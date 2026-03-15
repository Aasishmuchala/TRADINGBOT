"""Keltner Channel — Mean reversion within ATR-based channel."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase


class KeltnerChannel(StrategyBase):
    name = "keltner_channel"
    regimes = ["ranging"]
    timeframe = "15m"
    min_confidence = 0.5
    latency_budget_ms = 1000
    paper_mode_days = 3

    def __init__(self):
        self.multiplier = 2.0
        self.position_state = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        ema_21 = features.get("ema_21")
        atr = features.get("atr")
        rsi = features.get("rsi")
        if price <= 0 or ema_21 is None or atr is None or atr <= 0: return None

        upper = ema_21 + self.multiplier * atr
        lower = ema_21 - self.multiplier * atr
        state = self.position_state.get(asset, "flat")

        if price <= lower and (rsi is None or rsi < 35) and state != "long":
            self.position_state[asset] = "long"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.7, price=price,
                metadata={"lower": round(lower, 4), "ema": round(ema_21, 4)})
        if price >= upper and (rsi is None or rsi > 65) and state != "short":
            self.position_state[asset] = "short"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.7, price=price,
                metadata={"upper": round(upper, 4), "ema": round(ema_21, 4)})
        if state == "long" and price >= ema_21:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.6, price=price, metadata={"trigger": "mean_reversion"})
        if state == "short" and price <= ema_21:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.6, price=price, metadata={"trigger": "mean_reversion"})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "tracked": len(self.position_state)}