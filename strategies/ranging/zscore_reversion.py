"""Z-Score Mean Reversion — Trade when price deviates >2 std from mean."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase


class ZScoreReversion(StrategyBase):
    name = "zscore_reversion"
    regimes = ["ranging"]
    timeframe = "15m"
    min_confidence = 0.5
    latency_budget_ms = 1000
    paper_mode_days = 3

    def __init__(self):
        self.entry_threshold = 2.0
        self.exit_threshold = 0.5
        self.price_history = {}
        self.window = 50
        self.position_state = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        sma_20 = features.get("sma_20")
        if price <= 0 or sma_20 is None: return None

        if asset not in self.price_history: self.price_history[asset] = []
        self.price_history[asset].append(price)
        if len(self.price_history[asset]) > self.window:
            self.price_history[asset] = self.price_history[asset][-self.window:]
        if len(self.price_history[asset]) < 20: return None

        import numpy as np
        arr = np.array(self.price_history[asset])
        mean = np.mean(arr)
        std = np.std(arr)
        if std == 0: return None
        zscore = (price - mean) / std

        state = self.position_state.get(asset, "flat")

        if zscore < -self.entry_threshold and state != "long":
            self.position_state[asset] = "long"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=min(0.9, 0.5 + abs(zscore) / 5), price=price,
                metadata={"zscore": round(zscore, 3)})
        if zscore > self.entry_threshold and state != "short":
            self.position_state[asset] = "short"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=min(0.9, 0.5 + abs(zscore) / 5), price=price,
                metadata={"zscore": round(zscore, 3)})
        if state == "long" and zscore > -self.exit_threshold:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.6, price=price, metadata={"trigger": "mean_reversion"})
        if state == "short" and zscore < self.exit_threshold:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.6, price=price, metadata={"trigger": "mean_reversion"})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "tracked": len(self.price_history)}