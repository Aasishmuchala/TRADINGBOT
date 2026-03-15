import asyncio
import time
import numpy as np
import structlog
from collections import defaultdict
from config.settings import Settings
from config.assets import TRACKED_PAIRS
from core.redis_client import RedisClient
from core.heartbeat import HeartbeatMixin
from services.feature_engine.aggregator import OHLCVAggregator
from services.feature_engine.validator import TickValidator
from services.feature_engine.indicators import compute_all_indicators

logger = structlog.get_logger()

class FeatureEngineService(HeartbeatMixin):
    service_name = "feature-engine"
    
    def __init__(self):
        self.settings = Settings()
        self.redis = RedisClient(self.settings)
        super().__init__(self.redis)
        self.validator = TickValidator()
        self.aggregator = OHLCVAggregator(on_candle_close=self.on_candle_close)
        
        # Price history per timeframe/symbol for indicator computation
        # history[timeframe][symbol] = {"closes": [], "highs": [], "lows": [], "volumes": []}
        self._history: dict[str, dict[str, dict]] = defaultdict(lambda: defaultdict(lambda: {
            "closes": [], "highs": [], "lows": [], "volumes": []
        }))
        self._max_history = 500  # candles to keep per timeframe/symbol
        
        # Latest order book per exchange/symbol
        self._orderbooks: dict[str, dict] = {}
    
    async def on_candle_close(self, candle: dict):
        """Called when an OHLCV candle closes. Compute and store features."""
        tf = candle["timeframe"]
        symbol = candle["symbol"]
        
        # Append to history
        h = self._history[tf][symbol]
        h["closes"].append(candle["close"])
        h["highs"].append(candle["high"])
        h["lows"].append(candle["low"])
        h["volumes"].append(candle["volume"])
        
        # Trim history
        for key in h:
            if len(h[key]) > self._max_history:
                h[key] = h[key][-self._max_history:]
        
        # Need minimum 60 candles for reliable indicators
        if len(h["closes"]) < 60:
            return
        
        # Get latest order book for this symbol
        ob_key = f"{symbol}"
        ob = self._orderbooks.get(ob_key, {})
        
        # Compute indicators
        indicators = compute_all_indicators(
            closes=np.array(h["closes"]),
            highs=np.array(h["highs"]),
            lows=np.array(h["lows"]),
            volumes=np.array(h["volumes"]),
            ob_bids=ob.get("bids"),
            ob_asks=ob.get("asks"),
        )
        
        # Store in Redis hash
        features = {
            "symbol": symbol,
            "timeframe": tf,
            "ohlcv": {
                "open": candle["open"],
                "high": candle["high"],
                "low": candle["low"],
                "close": candle["close"],
                "volume": candle["volume"],
            },
            **indicators,
        }
        await self.redis.set_features(tf, symbol, features)
        
        # Publish to features stream
        await self.redis.publish("features", {
            "symbol": symbol,
            "timeframe": tf,
            "timestamp": time.time(),
            "close": candle["close"],
            "indicators_count": len(indicators),
        })
        
        logger.debug("features_computed", symbol=symbol, timeframe=tf, indicators=len(indicators))
    
    async def _consume_ticks(self):
        """Consume raw_ticks stream and feed to aggregator."""
        group = "feature-engine-cg"
        consumer = "fe-1"
        await self.redis.create_consumer_group("raw_ticks", group)
        
        while True:
            try:
                messages = await self.redis.consume("raw_ticks", group, consumer, count=100, block=500)
                for msg_id, data in messages:
                    symbol = data.get("symbol", "")
                    
                    # Validate tick
                    valid, reason = self.validator.validate(symbol, data)
                    if not valid:
                        logger.debug("tick_rejected", symbol=symbol, reason=reason)
                        await self.redis.ack("raw_ticks", group, msg_id)
                        continue
                    
                    # Feed to aggregator
                    await self.aggregator.process_tick(
                        symbol=symbol,
                        price=float(data["price"]),
                        amount=float(data.get("amount", 0)),
                        timestamp=float(data["timestamp"]),
                    )
                    
                    await self.redis.ack("raw_ticks", group, msg_id)
            except Exception as e:
                logger.error("tick_consumption_error", error=str(e))
                await asyncio.sleep(1)
    
    async def _consume_orderbooks(self):
        """Consume raw_orderbook stream and cache latest order books."""
        group = "feature-engine-ob-cg"
        consumer = "fe-ob-1"
        await self.redis.create_consumer_group("raw_orderbook", group)
        
        while True:
            try:
                messages = await self.redis.consume("raw_orderbook", group, consumer, count=50, block=500)
                for msg_id, data in messages:
                    symbol = data.get("symbol", "")
                    
                    valid, reason = self.validator.validate_orderbook(symbol, data)
                    if valid:
                        self._orderbooks[symbol] = {
                            "bids": data.get("bids", []),
                            "asks": data.get("asks", []),
                        }
                    
                    await self.redis.ack("raw_orderbook", group, msg_id)
            except Exception as e:
                logger.error("orderbook_consumption_error", error=str(e))
                await asyncio.sleep(1)
    
    async def start(self):
        await self.redis.connect()
        await self.start_heartbeat()
        logger.info("feature_engine_starting")
        
        await asyncio.gather(
            self._consume_ticks(),
            self._consume_orderbooks(),
        )
    
    async def stop(self):
        await self.stop_heartbeat()
        await self.redis.close()

async def main():
    service = FeatureEngineService()
    try:
        await service.start()
    except KeyboardInterrupt:
        await service.stop()

if __name__ == "__main__":
    asyncio.run(main())
