import time
import structlog
from typing import Optional

logger = structlog.get_logger()

class TickValidator:
    """Validates incoming ticks, rejects bad data."""
    
    def __init__(self):
        self._last_prices: dict[str, float] = {}  # symbol -> last known price
        self._volume_history: dict[str, list[float]] = {}  # symbol -> recent volumes
        self._max_price_change = 0.10  # 10% max in one tick
        self._max_staleness = 30.0  # 30 seconds
        self._volume_anomaly_factor = 50.0  # 50x average
    
    def validate(self, symbol: str, tick: dict) -> tuple[bool, Optional[str]]:
        """Returns (is_valid, rejection_reason)."""
        price = float(tick.get("price", 0))
        timestamp = float(tick.get("timestamp", 0))
        amount = float(tick.get("amount", 0))
        
        # Price must be positive
        if price <= 0:
            return False, "non_positive_price"
        
        # Staleness check
        now = time.time()
        if abs(now - timestamp) > self._max_staleness:
            return False, f"stale_data_{now - timestamp:.1f}s"
        
        # Price spike filter
        if symbol in self._last_prices:
            last = self._last_prices[symbol]
            change = abs(price - last) / last
            if change > self._max_price_change:
                logger.warning("price_spike_rejected", symbol=symbol, change=f"{change:.2%}", price=price, last=last)
                return False, f"price_spike_{change:.2%}"
        
        # Volume anomaly (collect 100 samples before checking)
        if symbol not in self._volume_history:
            self._volume_history[symbol] = []
        self._volume_history[symbol].append(amount)
        if len(self._volume_history[symbol]) > 1000:
            self._volume_history[symbol] = self._volume_history[symbol][-500:]
        
        if len(self._volume_history[symbol]) > 100 and amount > 0:
            avg_vol = sum(self._volume_history[symbol][-100:]) / 100
            if avg_vol > 0 and amount > avg_vol * self._volume_anomaly_factor:
                logger.warning("volume_anomaly", symbol=symbol, amount=amount, avg=avg_vol)
                # Flag but don't reject — could be legitimate whale trade
        
        # Update last known price
        self._last_prices[symbol] = price
        return True, None
    
    def validate_orderbook(self, symbol: str, ob: dict) -> tuple[bool, Optional[str]]:
        """Validate order book snapshot."""
        bids = ob.get("bids", [])
        asks = ob.get("asks", [])
        
        if not bids or not asks:
            return False, "empty_orderbook"
        
        best_bid = bids[0][0] if bids else 0
        best_ask = asks[0][0] if asks else 0
        
        # Crossed book check
        if best_bid >= best_ask:
            return False, "crossed_book"
        
        return True, None
