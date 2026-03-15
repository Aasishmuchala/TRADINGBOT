"""Pivot Points — Trade bounces off daily pivot levels."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase


class PivotPoints(StrategyBase):
    name = "pivot_points"
    regimes = ["ranging"]
    timeframe = "15m"
    min_confidence = 0.5
    latency_budget_ms = 1000
    paper_mode_days = 3

    def __init__(self):
        self.position_state = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        high = features.get("high", price)
        low = features.get("low", price)
        rsi = features.get("rsi")
        if price <= 0: return None

        # Classic pivot point calculation
        pivot = (high + low + price) / 3
        s1 = 2 * pivot - high
        r1 = 2 * pivot - low
        s2 = pivot - (high - low)
        r2 = pivot + (high - low)
        state = self.position_state.get(asset, "flat")
        tolerance = 0.002

        if abs(price - s1) / s1 < tolerance and (rsi is None or rsi < 40) and state != "long":
            self.position_state[asset] = "long"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.65, price=price,
                metadata={"pivot": round(pivot, 4), "s1": round(s1, 4), "trigger": "s1_bounce"})
        if abs(price - r1) / r1 < tolerance and (rsi is None or rsi > 60) and state != "short":
            self.position_state[asset] = "short"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.65, price=price,
                metadata={"pivot": round(pivot, 4), "r1": round(r1, 4), "trigger": "r1_rejection"})
        if state == "long" and price >= pivot:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.6, price=price, metadata={"trigger": "pivot_target"})
        if state == "short" and price <= pivot:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.6, price=price, metadata={"trigger": "pivot_target"})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "tracked": len(self.position_state)}