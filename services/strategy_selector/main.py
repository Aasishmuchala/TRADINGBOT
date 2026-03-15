import asyncio
import json
import time
import structlog
from config.settings import Settings
from core.redis_client import RedisClient
from core.heartbeat import HeartbeatMixin

logger = structlog.get_logger()

class StrategySelectorService(HeartbeatMixin):
    service_name = "strategy-selector"
    
    def __init__(self):
        self.settings = Settings()
        self.redis = RedisClient(self.settings)
        super().__init__(self.redis)
        self._strategy_health: dict[str, dict] = {}
        self._max_sharpe = 3.0
    
    def _compute_weights(self, regime: str, confidence: float) -> dict[str, float]:
        """Compute capital weights for all strategies based on regime."""
        weights = {}
        total = 0.0
        
        for name, health in self._strategy_health.items():
            if not health.get("is_enabled", False):
                weights[name] = 0.0
                continue
            
            regimes = health.get("regimes", [])
            sharpe = max(health.get("sharpe_7d", 0.0), 0.01)
            
            if regime in regimes:
                # Primary regime match
                base = confidence
                health_mult = min(sharpe / self._max_sharpe, 1.0)
                w = base * health_mult
            else:
                # Off-regime residual allocation (5%)
                w = 0.05
            
            # Reduce all weights if confidence is low
            if confidence < 0.55:
                w *= 0.5
            
            weights[name] = w
            total += w
        
        # Normalize to sum to 1.0
        if total > 0:
            weights = {k: v / total for k, v in weights.items()}
        
        return weights
    
    async def _consume_regime(self):
        """Consume regime signals and compute capital allocations."""
        group = "strategy-selector-cg"
        consumer = "ss-1"
        await self.redis.create_consumer_group("regime_signal", group)
        
        while True:
            try:
                messages = await self.redis.consume("regime_signal", group, consumer, count=1, block=1000)
                for msg_id, data in messages:
                    regime = data.get("regime", "uncertain")
                    confidence = float(data.get("confidence", 0))
                    
                    # Cache latest regime
                    await self.redis.client.set("latest_regime", json.dumps(data))
                    
                    # Compute weights
                    weights = self._compute_weights(regime, confidence)
                    
                    # Publish weights
                    await self.redis.publish("capital_weights", {
                        "weights": weights,
                        "regime": regime,
                        "confidence": confidence,
                        "timestamp": time.time(),
                    })
                    
                    logger.info("weights_computed", regime=regime, confidence=f"{confidence:.3f}", active=sum(1 for w in weights.values() if w > 0.01))
                    
                    await self.redis.ack("regime_signal", group, msg_id)
            except Exception as e:
                logger.error("selector_error", error=str(e))
                await asyncio.sleep(1)
    
    async def _poll_strategy_health(self):
        """Periodically read strategy health from Redis."""
        while True:
            try:
                keys = await self.redis.client.keys("strategy_health:*")
                for key in keys:
                    data = await self.redis.client.hgetall(key)
                    if data:
                        name = key.split(":")[-1] if isinstance(key, str) else key.decode().split(":")[-1]
                        self._strategy_health[name] = {
                            k: json.loads(v) if isinstance(v, str) else v 
                            for k, v in data.items()
                        }
            except Exception as e:
                logger.error("health_poll_error", error=str(e))
            await asyncio.sleep(30)
    
    async def start(self):
        await self.redis.connect()
        await self.start_heartbeat()
        logger.info("strategy_selector_starting")
        
        await asyncio.gather(
            self._consume_regime(),
            self._poll_strategy_health(),
        )
    
    async def stop(self):
        await self.stop_heartbeat()
        await self.redis.close()

async def main():
    service = StrategySelectorService()
    try:
        await service.start()
    except KeyboardInterrupt:
        await service.stop()

if __name__ == "__main__":
    asyncio.run(main())
