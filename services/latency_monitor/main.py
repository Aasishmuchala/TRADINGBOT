"""Latency Monitor Service — Per-exchange RTT tracking."""
import asyncio
import time
from typing import Optional

import ccxt.async_support as ccxt
import structlog

from config.settings import Settings
from config.exchanges import EXCHANGES
from core.heartbeat import HeartbeatMixin
from core.redis_client import RedisClient

logger = structlog.get_logger()


class LatencyMonitorService(HeartbeatMixin):
    """Measures and caches per-exchange round-trip latency."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.redis: Optional[RedisClient] = None
        self.service_name = "latency_monitor"
        self.exchanges: dict[str, ccxt.Exchange] = {}
        self.ping_interval = 5  # seconds
        self.alert_threshold_ms = 500
        self.critical_threshold_ms = 2000

        # Rolling stats
        self.latency_history: dict[str, list[float]] = {}
        self.max_history = 100  # Keep last 100 pings per exchange

    async def start(self):
        self.redis = RedisClient(self.settings.redis_url)
        await self.redis.connect()

        # Initialize exchange connections
        for name, config in EXCHANGES.items():
            try:
                exchange_class = getattr(ccxt, config["ccxt_id"])
                self.exchanges[name] = exchange_class({
                    "enableRateLimit": True,
                    "timeout": 10000,
                })
                self.latency_history[name] = []
                logger.info("latency_monitor.exchange_init", exchange=name)
            except Exception as e:
                logger.error("latency_monitor.exchange_init_failed", exchange=name, error=str(e))

        logger.info("latency_monitor.started", exchanges=list(self.exchanges.keys()))
        await asyncio.gather(
            self._ping_loop(),
            self.run_heartbeat(self.redis),
        )

    async def _ping_loop(self):
        """Continuously ping all exchanges."""
        while True:
            tasks = [self._ping_exchange(name, ex) for name, ex in self.exchanges.items()]
            await asyncio.gather(*tasks, return_exceptions=True)
            await asyncio.sleep(self.ping_interval)

    async def _ping_exchange(self, name: str, exchange: ccxt.Exchange):
        """Measure RTT for a single exchange."""
        try:
            start = time.monotonic()
            await exchange.fetch_time()
            rtt_ms = (time.monotonic() - start) * 1000

            # Store in Redis
            if self.redis:
                await self.redis.cache_latency(name, rtt_ms)

            # Update rolling history
            history = self.latency_history.get(name, [])
            history.append(rtt_ms)
            if len(history) > self.max_history:
                history = history[-self.max_history:]
            self.latency_history[name] = history

            # Compute stats
            avg_ms = sum(history) / len(history)
            p99_ms = sorted(history)[int(len(history) * 0.99)] if len(history) > 10 else rtt_ms

            # Publish latency data
            if self.redis:
                await self.redis.publish("latency_updates", {
                    "exchange": name,
                    "rtt_ms": round(rtt_ms, 1),
                    "avg_ms": round(avg_ms, 1),
                    "p99_ms": round(p99_ms, 1),
                    "samples": len(history),
                    "timestamp": time.time(),
                })

            # Alert on high latency
            if rtt_ms > self.critical_threshold_ms:
                logger.error("latency_monitor.critical", exchange=name, rtt_ms=rtt_ms)
                if self.redis:
                    await self.redis.publish("alerts", {
                        "type": "latency_critical",
                        "exchange": name,
                        "rtt_ms": round(rtt_ms, 1),
                        "threshold_ms": self.critical_threshold_ms,
                        "timestamp": time.time(),
                    })
            elif rtt_ms > self.alert_threshold_ms:
                logger.warning("latency_monitor.high", exchange=name, rtt_ms=rtt_ms)

        except Exception as e:
            logger.error("latency_monitor.ping_failed", exchange=name, error=str(e))
            # Cache a high latency value to signal degradation
            if self.redis:
                await self.redis.cache_latency(name, 9999.0)

    async def get_best_exchange(self) -> Optional[str]:
        """Return the exchange with the lowest current latency."""
        best_name = None
        best_latency = float("inf")
        for name, history in self.latency_history.items():
            if history:
                recent = history[-5:]  # Last 5 pings
                avg = sum(recent) / len(recent)
                if avg < best_latency:
                    best_latency = avg
                    best_name = name
        return best_name

    async def shutdown(self):
        """Close all exchange connections."""
        for name, exchange in self.exchanges.items():
            try:
                await exchange.close()
            except Exception:
                pass


async def main():
    settings = Settings()
    service = LatencyMonitorService(settings)
    try:
        await service.start()
    finally:
        await service.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
