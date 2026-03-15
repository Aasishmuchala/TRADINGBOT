"""Watchdog Service — Dead man's switch and 4-tier degradation."""
import asyncio
import time
from typing import Optional
from enum import Enum

import structlog

from config.settings import Settings
from core.heartbeat import HeartbeatMixin
from core.redis_client import RedisClient
from core.models import DegradationTier

logger = structlog.get_logger()


class WatchdogService(HeartbeatMixin):
    """Monitors all service heartbeats and triggers degradation tiers."""

    SERVICES = [
        "data_ingestion", "feature_engine", "regime_detector",
        "strategy_selector", "strategy_runner", "risk_layer",
        "execution_engine", "trade_ledger", "correlation_engine",
        "latency_monitor", "retrainer", "backtester",
    ]

    # Critical services that trigger emergency mode if down
    CRITICAL_SERVICES = {"data_ingestion", "risk_layer", "execution_engine"}

    HEARTBEAT_TIMEOUT = 15   # Seconds before a service is considered unhealthy
    DEAD_MAN_TIMEOUT = 30    # Seconds before triggering emergency mode
    CHECK_INTERVAL = 5       # How often to check heartbeats

    def __init__(self, settings: Settings):
        self.settings = settings
        self.redis: Optional[RedisClient] = None
        self.service_name = "watchdog"
        self.current_tier = DegradationTier.FULL
        self.consecutive_failures: dict[str, int] = {}

    async def start(self):
        self.redis = RedisClient(self.settings.redis_url)
        await self.redis.connect()

        logger.info("watchdog.started", services=len(self.SERVICES))
        await asyncio.gather(
            self._monitor_loop(),
            self.run_heartbeat(self.redis),
        )

    async def _monitor_loop(self):
        """Main monitoring loop."""
        while True:
            try:
                service_status = await self._check_all_services()
                new_tier = self._determine_tier(service_status)

                if new_tier != self.current_tier:
                    await self._transition_tier(new_tier, service_status)

                # Publish health status
                await self.redis.publish("system_health", {
                    "tier": self.current_tier.value,
                    "services": service_status,
                    "timestamp": time.time(),
                })

            except Exception as e:
                logger.error("watchdog.monitor_error", error=str(e))

            await asyncio.sleep(self.CHECK_INTERVAL)

    async def _check_all_services(self) -> dict[str, dict]:
        """Check heartbeat status of all services."""
        now = time.time()
        status = {}

        for service in self.SERVICES:
            try:
                last_hb = await self.redis.check_heartbeat(service)
                if last_hb is None:
                    status[service] = {"status": "unknown", "age": None}
                    self.consecutive_failures[service] = self.consecutive_failures.get(service, 0) + 1
                else:
                    age = now - last_hb
                    if age < self.HEARTBEAT_TIMEOUT:
                        status[service] = {"status": "healthy", "age": round(age, 1)}
                        self.consecutive_failures[service] = 0
                    elif age < self.DEAD_MAN_TIMEOUT:
                        status[service] = {"status": "degraded", "age": round(age, 1)}
                        self.consecutive_failures[service] = self.consecutive_failures.get(service, 0) + 1
                    else:
                        status[service] = {"status": "down", "age": round(age, 1)}
                        self.consecutive_failures[service] = self.consecutive_failures.get(service, 0) + 1
            except Exception:
                status[service] = {"status": "error", "age": None}

        return status

    def _determine_tier(self, status: dict[str, dict]) -> DegradationTier:
        """Determine degradation tier based on service health."""
        healthy = [s for s, info in status.items() if info["status"] == "healthy"]
        degraded = [s for s, info in status.items() if info["status"] == "degraded"]
        down = [s for s, info in status.items() if info["status"] in ("down", "error", "unknown")]

        # Check if critical services are down
        critical_down = [s for s in down if s in self.CRITICAL_SERVICES]

        if not down and not degraded:
            return DegradationTier.FULL
        elif not critical_down and len(down) <= 2:
            return DegradationTier.REDUCED
        elif len(critical_down) == 0 and len(down) <= 4:
            return DegradationTier.MINIMAL
        else:
            return DegradationTier.EMERGENCY

    async def _transition_tier(self, new_tier: DegradationTier, status: dict):
        """Handle tier transition."""
        old_tier = self.current_tier
        self.current_tier = new_tier

        logger.warning(
            "watchdog.tier_change",
            old_tier=old_tier.value,
            new_tier=new_tier.value,
        )

        # Publish alert
        alert_data = {
            "type": "degradation_tier_change",
            "old_tier": old_tier.value,
            "new_tier": new_tier.value,
            "services_down": [s for s, info in status.items() if info["status"] in ("down", "error")],
            "timestamp": time.time(),
        }
        await self.redis.publish("alerts", alert_data)

        # Emergency mode: trigger position close
        if new_tier == DegradationTier.EMERGENCY:
            logger.critical("watchdog.EMERGENCY_MODE_ACTIVATED")
            await self.redis.publish("emergency", {
                "action": "close_all_positions",
                "reason": "Dead man's switch triggered",
                "timestamp": time.time(),
            })


async def main():
    settings = Settings()
    service = WatchdogService(settings)
    await service.start()


if __name__ == "__main__":
    asyncio.run(main())