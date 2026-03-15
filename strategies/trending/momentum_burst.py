"""Momentum Burst — Ride explosive momentum with trailing stop."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase


class MomentumBurst(StrategyBase):
    name = "momentum_burst"
    regimes = ["trending"]
    timeframe = "5m"
    min_confidence = 0.55
    latency_budget_ms = 300
    paper_mode_days = 3

    def __init__(self):
        self.roc_threshold = 0.015  # 1.5% rate of change
        self.adx_min = 30
        self.position_state = {}
        self.entry_prices = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        roc = features.get("roc")
        adx = features.get("adx")
        atr = features.get("atr", 0)
        if price <= 0 or roc is None: return None

        state = self.position_state.get(asset, "flat")

        # Trailing stop check
        if state == "long" and asset in self.entry_prices and atr > 0:
            if price < self.entry_prices[asset] - 2 * atr:
                self.position_state[asset] = "flat"
                return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                    confidence=0.7, price=price, metadata={"trigger": "trailing_stop"})
        if state == "short" and asset in self.entry_prices and atr > 0:
            if price > self.entry_prices[asset] + 2 * atr:
                self.position_state[asset] = "flat"
                return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                    confidence=0.7, price=price, metadata={"trigger": "trailing_stop"})

        if adx and adx < self.adx_min: return None

        if roc > self.roc_threshold and state != "long":
            self.position_state[asset] = "long"
            self.entry_prices[asset] = price
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=min(0.9, 0.5 + roc * 10), price=price,
                metadata={"roc": round(roc, 4), "adx": round(adx, 2) if adx else None})

        if roc < -self.roc_threshold and state != "short":
            self.position_state[asset] = "short"
            self.entry_prices[asset] = price
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=min(0.9, 0.5 + abs(roc) * 10), price=price,
                metadata={"roc": round(roc, 4), "adx": round(adx, 2) if adx else None})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "positions": len([s for s in self.position_state.values() if s != "flat"])}
