"""Slow Mean Reversion — Patient mean reversion in quiet markets."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase

class MeanReversionSlow(StrategyBase):
    name = "mean_reversion_slow"
    regimes = ["low_vol"]
    timeframe = "4h"
    min_confidence = 0.5
    latency_budget_ms = 2000
    paper_mode_days = 7

    def __init__(self):
        self.position_state = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        bb_upper = features.get("bb_upper")
        bb_lower = features.get("bb_lower")
        bb_mid = features.get("bb_mid")
        rsi = features.get("rsi")
        realized_vol = features.get("realized_vol")
        if price <= 0 or bb_upper is None or bb_lower is None or bb_mid is None: return None
        if realized_vol and realized_vol > 0.02: return None

        state = self.position_state.get(asset, "flat")
        bb_width = bb_upper - bb_lower
        if bb_width <= 0: return None
        pct_b = (price - bb_lower) / bb_width

        if pct_b < 0.1 and (rsi is None or rsi < 35) and state != "long":
            self.position_state[asset] = "long"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.7, price=price,
                metadata={"pct_b": round(pct_b, 4), "trigger": "slow_oversold"})
        if pct_b > 0.9 and (rsi is None or rsi > 65) and state != "short":
            self.position_state[asset] = "short"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.7, price=price,
                metadata={"pct_b": round(pct_b, 4), "trigger": "slow_overbought"})
        if state == "long" and pct_b > 0.5:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.6, price=price, metadata={"trigger": "slow_mean_exit"})
        if state == "short" and pct_b < 0.5:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.6, price=price, metadata={"trigger": "slow_mean_exit"})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "tracked": len(self.position_state)}
