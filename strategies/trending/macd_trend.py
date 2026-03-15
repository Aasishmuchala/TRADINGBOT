"""MACD Trend Follower — Trade MACD crossovers in trending markets."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase


class MACDTrend(StrategyBase):
    name = "macd_trend"
    regimes = ["trending"]
    timeframe = "1h"
    min_confidence = 0.5
    latency_budget_ms = 1000
    paper_mode_days = 3

    def __init__(self):
        self.prev_histogram = {}
        self.position_state = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        macd_hist = features.get("macd_histogram")
        adx = features.get("adx")
        if price <= 0 or macd_hist is None: return None
        if adx is not None and adx < 20: return None

        prev = self.prev_histogram.get(asset)
        self.prev_histogram[asset] = macd_hist
        if prev is None: return None

        state = self.position_state.get(asset, "flat")

        if prev < 0 and macd_hist > 0 and state != "long":
            self.position_state[asset] = "long"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=min(0.85, 0.5 + abs(macd_hist) * 50), price=price,
                metadata={"macd_hist": round(macd_hist, 6), "crossover": "bullish"})

        if prev > 0 and macd_hist < 0 and state != "short":
            self.position_state[asset] = "short"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=min(0.85, 0.5 + abs(macd_hist) * 50), price=price,
                metadata={"macd_hist": round(macd_hist, 6), "crossover": "bearish"})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "tracked": len(self.prev_histogram)}
