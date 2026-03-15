import asyncio
import importlib
import os
import sys
import time
import structlog
from pathlib import Path
from typing import Optional
from config.settings import Settings
from config.assets import TRACKED_PAIRS
from core.redis_client import RedisClient
from core.heartbeat import HeartbeatMixin
from services.strategy_runner.base import StrategyBase

logger = structlog.get_logger()

class StrategyRunnerService(HeartbeatMixin):
    service_name = "strategy-runner"
    
    def __init__(self):
        self.settings = Settings()
        self.redis = RedisClient(self.settings)
        super().__init__(self.redis)
        self.strategies: dict[str, StrategyBase] = {}
        self._strategy_dir = Path("/app/strategies")
        self._last_scan = 0.0
        self._scan_interval = 60  # rescan every 60s
        self._capital_weights: dict[str, float] = {}  # from strategy selector
    
    def _discover_strategies(self):
        """Scan strategies/ folder and load modules via importlib."""
        if not self._strategy_dir.exists():
            logger.warning("strategy_dir_not_found", path=str(self._strategy_dir))
            return
        
        for category_dir in self._strategy_dir.iterdir():
            if not category_dir.is_dir() or category_dir.name.startswith("_"):
                continue
            for py_file in category_dir.glob("*.py"):
                if py_file.name.startswith("_"):
                    continue
                module_name = f"strategies.{category_dir.name}.{py_file.stem}"
                if module_name in sys.modules:
                    # Hot-reload if file changed
                    try:
                        module = importlib.reload(sys.modules[module_name])
                    except Exception as e:
                        logger.error("strategy_reload_error", module=module_name, error=str(e))
                        continue
                else:
                    try:
                        module = importlib.import_module(module_name)
                    except Exception as e:
                        logger.error("strategy_import_error", module=module_name, error=str(e))
                        continue
                
                # Find StrategyBase subclasses in module
                for attr_name in dir(module):
                    attr = getattr(module, attr_name)
                    if (isinstance(attr, type) and issubclass(attr, StrategyBase) 
                            and attr is not StrategyBase):
                        try:
                            instance = attr()
                            if instance.name not in self.strategies:
                                self.strategies[instance.name] = instance
                                logger.info("strategy_loaded", name=instance.name, regimes=instance.regimes)
                        except Exception as e:
                            logger.error("strategy_init_error", cls=attr_name, error=str(e))
    
    async def _consume_features(self):
        """Consume features stream and route to strategies."""
        group = "strategy-runner-cg"
        consumer = "sr-1"
        await self.redis.create_consumer_group("features", group)
        
        while True:
            try:
                messages = await self.redis.consume("features", group, consumer, count=50, block=500)
                for msg_id, data in messages:
                    symbol = data.get("symbol", "")
                    timeframe = data.get("timeframe", "")
                    
                    # Get full features from Redis hash
                    features = await self.redis.get_features(timeframe, symbol)
                    if not features:
                        await self.redis.ack("features", group, msg_id)
                        continue
                    
                    # Get current regime
                    regime_data = await self.redis.client.get("latest_regime")
                    regime = "uncertain"
                    confidence = 0.0
                    if regime_data:
                        import json
                        rd = json.loads(regime_data)
                        regime = rd.get("regime", "uncertain")
                        confidence = float(rd.get("confidence", 0))
                    
                    # Route to matching strategies
                    for name, strategy in self.strategies.items():
                        if not strategy.is_active:
                            continue
                        if strategy.timeframe != timeframe:
                            continue
                        if confidence < strategy.min_confidence:
                            continue
                        
                        try:
                            signal = strategy.on_features(features, regime, confidence)
                            if signal is not None:
                                # Get capital weight from selector
                                weight = self._capital_weights.get(name, 0.05)
                                signal_data = {
                                    "strategy_name": name,
                                    "asset": symbol,
                                    "signal": signal.signal.value if hasattr(signal, 'signal') else str(signal.get("signal", "HOLD")),
                                    "confidence": signal.confidence if hasattr(signal, 'confidence') else float(signal.get("confidence", 0)),
                                    "capital_weight": weight,
                                    "regime": regime,
                                    "timestamp": time.time(),
                                }
                                await self.redis.publish("strategy_signals", signal_data)
                                logger.info("signal_emitted", strategy=name, asset=symbol, signal=signal_data["signal"])
                        except Exception as e:
                            logger.error("strategy_error", strategy=name, error=str(e))
                            strategy.disable()
                    
                    await self.redis.ack("features", group, msg_id)
                
                # Periodic strategy scan
                now = time.time()
                if now - self._last_scan > self._scan_interval:
                    self._discover_strategies()
                    self._last_scan = now
                    
            except Exception as e:
                logger.error("feature_consumption_error", error=str(e))
                await asyncio.sleep(1)
    
    async def _consume_selector_weights(self):
        """Listen for capital weight updates from strategy selector."""
        group = "strategy-runner-weights-cg"
        consumer = "sr-w-1"
        await self.redis.create_consumer_group("capital_weights", group)
        
        while True:
            try:
                messages = await self.redis.consume("capital_weights", group, consumer, count=10, block=1000)
                for msg_id, data in messages:
                    if "weights" in data:
                        self._capital_weights = data["weights"] if isinstance(data["weights"], dict) else {}
                        logger.debug("weights_updated", count=len(self._capital_weights))
                    await self.redis.ack("capital_weights", group, msg_id)
            except Exception:
                await asyncio.sleep(1)
    
    async def start(self):
        await self.redis.connect()
        await self.start_heartbeat()
        self._discover_strategies()
        logger.info("strategy_runner_starting", loaded=len(self.strategies))
        
        await asyncio.gather(
            self._consume_features(),
            self._consume_selector_weights(),
        )
    
    async def stop(self):
        await self.stop_heartbeat()
        await self.redis.close()

async def main():
    service = StrategyRunnerService()
    try:
        await service.start()
    except KeyboardInterrupt:
        await service.stop()

if __name__ == "__main__":
    asyncio.run(main())
