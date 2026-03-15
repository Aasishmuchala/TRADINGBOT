"""Supertrend Strategy — ATR-based trend indicator signals."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase


class Supertrend(StrategyBase):
    name = "supertrend"
    regimes = ["trending"]
    timeframe = "15m"
    min_confidence = 0.5
    latency_budget_ms = 500
    paper_mode_days = 3

    def __init__(self):
        self.multiplier = 3.0
        self.upper_band = {}
        self.lower_band = {}
        self.prev_direction = {}  # 1 = up, -1 = down
        self.position_state = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        high = features.get("high", price)
        low = features.get("low", price)
        atr = features.get("atr")
        if price <= 0 or atr is None or atr <= 0: return None

        mid = (high + low) / 2
        upper = mid + self.multiplier * atr
        lower = mid - self.multiplier * atr

        # Adjust bands with previous values
        prev_upper = self.upper_band.get(asset, upper)
        prev_lower = self.lower_band.get(asset, lower)
        if price > prev_upper: lower = max(lower, prev_lower)
        if price < prev_lower: upper = min(upper, prev_upper)
        self.upper_band[asset] = upper
        self.lower_band[asset] = lower

        # Determine direction
        if price > upper: direction = 1
        elif price < lower: direction = -1
        else: direction = self.prev_direction.get(asset, 1)

        prev_dir = self.prev_direction.get(asset)
        self.prev_direction[asset] = direction
        if prev_dir is None: return None

        state = self.position_state.get(asset, "flat")

        if prev_dir == -1 and direction == 1 and state != "long":
            self.position_state[asset] = "long"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.7, price=price,
                metadata={"upper": round(upper, 4), "lower": round(lower, 4), "atr": round(atr, 4)})

        if prev_dir == 1 and direction == -1 and state != "short":
            self.position_state[asset] = "short"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.7, price=price,
                metadata={"upper": round(upper, 4), "lower": round(lower, 4), "atr": round(atr, 4)})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "tracked": len(self.prev_direction)}
