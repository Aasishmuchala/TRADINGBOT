"""Squeeze Detector — Detect BB squeeze inside Keltner and trade the expansion."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase

class SqueezeDetector(StrategyBase):
    name = "squeeze_detector"
    regimes = ["high_vol"]
    timeframe = "15m"
    min_confidence = 0.55
    latency_budget_ms = 500
    paper_mode_days = 5

    def __init__(self):
        self.was_squeezed = {}
        self.position_state = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        bb_upper = features.get("bb_upper")
        bb_lower = features.get("bb_lower")
        ema_21 = features.get("ema_21")
        atr = features.get("atr")
        macd_hist = features.get("macd_histogram")
        if price <= 0 or bb_upper is None or bb_lower is None or ema_21 is None or atr is None:
            return None

        kc_upper = ema_21 + 1.5 * atr
        kc_lower = ema_21 - 1.5 * atr
        is_squeeze = bb_lower > kc_lower and bb_upper < kc_upper
        was = self.was_squeezed.get(asset, False)
        self.was_squeezed[asset] = is_squeeze
        state = self.position_state.get(asset, "flat")

        # Fire on squeeze release
        if was and not is_squeeze and macd_hist is not None:
            if macd_hist > 0 and state != "long":
                self.position_state[asset] = "long"
                return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                    confidence=0.75, price=price,
                    metadata={"trigger": "squeeze_release_up", "macd_hist": round(macd_hist, 6)})
            elif macd_hist < 0 and state != "short":
                self.position_state[asset] = "short"
                return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                    confidence=0.75, price=price,
                    metadata={"trigger": "squeeze_release_down", "macd_hist": round(macd_hist, 6)})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "squeezed": sum(1 for v in self.was_squeezed.values() if v)}
