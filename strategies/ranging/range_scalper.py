"""Range Scalper — Quick entries near support/resistance levels in ranges."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase


class RangeScalper(StrategyBase):
    name = "range_scalper"
    regimes = ["ranging"]
    timeframe = "5m"
    min_confidence = 0.55
    latency_budget_ms = 300
    paper_mode_days = 3

    def __init__(self):
        self.lookback = 30
        self.price_history = {}
        self.position_state = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        high = features.get("high", price)
        low = features.get("low", price)
        rsi = features.get("rsi")
        if price <= 0: return None

        if asset not in self.price_history: self.price_history[asset] = {"highs": [], "lows": []}
        self.price_history[asset]["highs"].append(high)
        self.price_history[asset]["lows"].append(low)
        if len(self.price_history[asset]["highs"]) > self.lookback:
            self.price_history[asset]["highs"] = self.price_history[asset]["highs"][-self.lookback:]
            self.price_history[asset]["lows"] = self.price_history[asset]["lows"][-self.lookback:]
        if len(self.price_history[asset]["highs"]) < 15: return None

        resistance = max(self.price_history[asset]["highs"][:-1])
        support = min(self.price_history[asset]["lows"][:-1])
        range_size = resistance - support
        if range_size <= 0: return None

        position_in_range = (price - support) / range_size
        state = self.position_state.get(asset, "flat")

        if position_in_range < 0.1 and (rsi is None or rsi < 35) and state != "long":
            self.position_state[asset] = "long"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.65, price=price,
                metadata={"support": round(support, 4), "resistance": round(resistance, 4)})
        if position_in_range > 0.9 and (rsi is None or rsi > 65) and state != "short":
            self.position_state[asset] = "short"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.65, price=price,
                metadata={"support": round(support, 4), "resistance": round(resistance, 4)})
        if state == "long" and position_in_range > 0.6:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.6, price=price, metadata={"trigger": "range_target"})
        if state == "short" and position_in_range < 0.4:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.6, price=price, metadata={"trigger": "range_target"})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "tracked": len(self.price_history)}