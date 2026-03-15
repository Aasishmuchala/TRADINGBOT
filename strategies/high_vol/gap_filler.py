"""Gap Filler — Trade price gaps during high volatility."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase

class GapFiller(StrategyBase):
    name = "gap_filler"
    regimes = ["high_vol"]
    timeframe = "5m"
    min_confidence = 0.55
    latency_budget_ms = 300
    paper_mode_days = 3

    def __init__(self):
        self.prev_close = {}
        self.gap_threshold = 0.005
        self.position_state = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        open_price = features.get("open", price)
        if price <= 0: return None

        prev = self.prev_close.get(asset)
        self.prev_close[asset] = price
        if prev is None or prev <= 0: return None

        gap_pct = (open_price - prev) / prev
        state = self.position_state.get(asset, "flat")

        if abs(gap_pct) < self.gap_threshold: return None

        # Gap up: fade it (expect fill)
        if gap_pct > self.gap_threshold and state != "short":
            self.position_state[asset] = "short"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=min(0.8, 0.5 + abs(gap_pct) * 20), price=price,
                metadata={"gap_pct": round(gap_pct * 100, 2), "trigger": "fade_gap_up"})
        if gap_pct < -self.gap_threshold and state != "long":
            self.position_state[asset] = "long"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=min(0.8, 0.5 + abs(gap_pct) * 20), price=price,
                metadata={"gap_pct": round(gap_pct * 100, 2), "trigger": "fade_gap_down"})

        # Exit when gap is ~50% filled
        if state == "short" and gap_pct > 0 and price <= prev + (open_price - prev) * 0.5:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.6, price=price, metadata={"trigger": "gap_half_filled"})
        if state == "long" and gap_pct < 0 and price >= prev - (prev - open_price) * 0.5:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.6, price=price, metadata={"trigger": "gap_half_filled"})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "tracked": len(self.prev_close)}
