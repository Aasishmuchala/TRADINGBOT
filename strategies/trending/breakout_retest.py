"""Breakout Retest — Enter on successful retest of broken resistance/support."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase


class BreakoutRetest(StrategyBase):
    name = "breakout_retest"
    regimes = ["trending"]
    timeframe = "15m"
    min_confidence = 0.5
    latency_budget_ms = 500
    paper_mode_days = 5

    def __init__(self):
        self.recent_highs = {}
        self.recent_lows = {}
        self.breakout_levels = {}
        self.position_state = {}
        self.lookback = 20

    def on_features(self, asset, features):
        price = features.get("close", 0)
        high = features.get("high", price)
        low = features.get("low", price)
        adx = features.get("adx")
        if price <= 0: return None

        if asset not in self.recent_highs:
            self.recent_highs[asset] = []
            self.recent_lows[asset] = []
        self.recent_highs[asset].append(high)
        self.recent_lows[asset].append(low)
        if len(self.recent_highs[asset]) > self.lookback:
            self.recent_highs[asset] = self.recent_highs[asset][-self.lookback:]
            self.recent_lows[asset] = self.recent_lows[asset][-self.lookback:]
        if len(self.recent_highs[asset]) < 10: return None

        resistance = max(self.recent_highs[asset][:-1])
        support = min(self.recent_lows[asset][:-1])
        state = self.position_state.get(asset, "flat")

        # Breakout above resistance, then retest
        bl = self.breakout_levels.get(asset)
        if price > resistance:
            self.breakout_levels[asset] = {"type": "up", "level": resistance}
        elif price < support:
            self.breakout_levels[asset] = {"type": "down", "level": support}

        if bl and bl["type"] == "up" and abs(price - bl["level"]) / bl["level"] < 0.005:
            if state != "long":
                self.position_state[asset] = "long"
                self.breakout_levels[asset] = None
                return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                    confidence=0.7, price=price,
                    metadata={"level": round(bl["level"], 4), "trigger": "retest_support"})

        if bl and bl["type"] == "down" and abs(price - bl["level"]) / bl["level"] < 0.005:
            if state != "short":
                self.position_state[asset] = "short"
                self.breakout_levels[asset] = None
                return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                    confidence=0.7, price=price,
                    metadata={"level": round(bl["level"], 4), "trigger": "retest_resistance"})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "tracked": len(self.breakout_levels)}
