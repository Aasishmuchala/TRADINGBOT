import time
from typing import Optional, Callable
from collections import defaultdict

TIMEFRAMES = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "1h": 3600,
    "4h": 14400,
}

class OHLCVAggregator:
    """Builds multi-timeframe OHLCV candles from raw ticks."""
    
    def __init__(self, on_candle_close: Callable = None):
        self.on_candle_close = on_candle_close
        # Current open candles: candles[timeframe][symbol] = {open, high, low, close, volume, start_time}
        self._candles: dict[str, dict[str, dict]] = defaultdict(dict)
    
    def _get_candle_start(self, timestamp: float, period_seconds: int) -> float:
        """Align timestamp to candle boundary."""
        return (int(timestamp) // period_seconds) * period_seconds
    
    async def process_tick(self, symbol: str, price: float, amount: float, timestamp: float):
        """Process a single tick, update all timeframe candles."""
        for tf, period in TIMEFRAMES.items():
            candle_start = self._get_candle_start(timestamp, period)
            
            if symbol not in self._candles[tf]:
                # First tick for this symbol/timeframe
                self._candles[tf][symbol] = {
                    "open": price, "high": price, "low": price, "close": price,
                    "volume": amount, "start_time": candle_start
                }
                continue
            
            candle = self._candles[tf][symbol]
            
            # Check if candle period has closed
            if candle_start > candle["start_time"]:
                # Close current candle
                closed_candle = {
                    "symbol": symbol,
                    "timeframe": tf,
                    "open": candle["open"],
                    "high": candle["high"],
                    "low": candle["low"],
                    "close": candle["close"],
                    "volume": candle["volume"],
                    "start_time": candle["start_time"],
                    "end_time": candle_start,
                }
                if self.on_candle_close:
                    await self.on_candle_close(closed_candle)
                
                # Start new candle
                self._candles[tf][symbol] = {
                    "open": price, "high": price, "low": price, "close": price,
                    "volume": amount, "start_time": candle_start
                }
            else:
                # Update current candle
                candle["high"] = max(candle["high"], price)
                candle["low"] = min(candle["low"], price)
                candle["close"] = price
                candle["volume"] += amount
    
    def get_current_candle(self, timeframe: str, symbol: str) -> Optional[dict]:
        """Get the current (unclosed) candle."""
        return self._candles.get(timeframe, {}).get(symbol)
