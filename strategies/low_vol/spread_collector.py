"""Spread Collector — Collect bid-ask spread in low-vol conditions."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase
import time

class SpreadCollector(StrategyBase):
    name = "spread_collector"
    regimes = ["low_vol"]
    timeframe = "1m"
    min_confidence = 0.55
    latency_budget_ms = 100
    paper_mode_days = 3

    def __init__(self):
        self.min_spread_bps = 3.0
        self.position_state = {}
        self.cooldown = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        ob_imbalance = features.get("ob_imbalance")
        realized_vol = features.get("realized_vol")
        if price <= 0 or realized_vol is None: return None
        if realized_vol > 0.015: return None

        now = time.time()
        if now - self.cooldown.get(asset, 0) < 30: return None
        state = self.position_state.get(asset, "flat")

        if ob_imbalance is not None and ob_imbalance > 0.15 and state != "long":
            self.position_state[asset] = "long"
            self.cooldown[asset] = now
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.6, price=price,
                metadata={"ob_imbalance": round(ob_imbalance, 4), "trigger": "bid_side"})
        if ob_imbalance is not None and ob_imbalance < -0.15 and state != "short":
            self.position_state[asset] = "short"
            self.cooldown[asset] = now
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.6, price=price,
                metadata={"ob_imbalance": round(ob_imbalance, 4), "trigger": "ask_side"})
        if state != "flat" and abs(ob_imbalance or 0) < 0.05:
            signal = Signal.SELL if state == "long" else Signal.BUY
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=signal,
                confidence=0.55, price=price, metadata={"trigger": "spread_collected"})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "tracked": len(self.position_state)}
