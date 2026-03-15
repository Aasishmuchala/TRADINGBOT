"""VWAP Breakout — Trade price breaks above/below VWAP with volume."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase


class VWAPBreakout(StrategyBase):
    name = "vwap_breakout"
    regimes = ["trending"]
    timeframe = "15m"
    min_confidence = 0.5
    latency_budget_ms = 500
    paper_mode_days = 3

    def __init__(self):
        self.prev_price_vs_vwap = {}
        self.position_state = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        vwap = features.get("vwap")
        adx = features.get("adx")
        if price <= 0 or vwap is None or vwap <= 0: return None

        prev = self.prev_price_vs_vwap.get(asset)
        current = "above" if price > vwap else "below"
        self.prev_price_vs_vwap[asset] = current
        if prev is None: return None

        state = self.position_state.get(asset, "flat")
        deviation = abs(price - vwap) / vwap

        if prev == "below" and current == "above" and state != "long":
            self.position_state[asset] = "long"
            conf = min(0.9, 0.5 + deviation * 20 + ((adx or 0) / 100))
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=conf, price=price,
                metadata={"vwap": round(vwap, 4), "deviation": round(deviation, 4)})

        if prev == "above" and current == "below" and state != "short":
            self.position_state[asset] = "short"
            conf = min(0.9, 0.5 + deviation * 20 + ((adx or 0) / 100))
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=conf, price=price,
                metadata={"vwap": round(vwap, 4), "deviation": round(deviation, 4)})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "tracked": len(self.prev_price_vs_vwap)}
