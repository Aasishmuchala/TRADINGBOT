"""Panic Reversal — Buy extreme fear, sell extreme greed."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase

class PanicReversal(StrategyBase):
    name = "panic_reversal"
    regimes = ["high_vol"]
    timeframe = "5m"
    min_confidence = 0.6
    latency_budget_ms = 500
    paper_mode_days = 5

    def __init__(self):
        self.position_state = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        rsi = features.get("rsi")
        realized_vol = features.get("realized_vol")
        bb_lower = features.get("bb_lower")
        bb_upper = features.get("bb_upper")
        if price <= 0 or rsi is None or realized_vol is None: return None
        if realized_vol < 0.03: return None  # Only in high vol

        state = self.position_state.get(asset, "flat")

        if rsi < 15 and bb_lower and price < bb_lower and state != "long":
            self.position_state[asset] = "long"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.8, price=price,
                metadata={"rsi": round(rsi, 2), "vol": round(realized_vol, 4), "trigger": "panic_buy"})
        if rsi > 85 and bb_upper and price > bb_upper and state != "short":
            self.position_state[asset] = "short"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.8, price=price,
                metadata={"rsi": round(rsi, 2), "vol": round(realized_vol, 4), "trigger": "greed_sell"})
        if state == "long" and rsi > 50:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.6, price=price, metadata={"trigger": "panic_exit"})
        if state == "short" and rsi < 50:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.6, price=price, metadata={"trigger": "greed_exit"})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "positions": len([s for s in self.position_state.values() if s != "flat"])}
