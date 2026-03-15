"""Order Book Imbalance Fade — Fade strong OB imbalances in ranges."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase


class OBImbalanceFade(StrategyBase):
    name = "ob_imbalance_fade"
    regimes = ["ranging"]
    timeframe = "1m"
    min_confidence = 0.55
    latency_budget_ms = 200
    paper_mode_days = 3

    def __init__(self):
        self.imbalance_threshold = 0.3
        self.position_state = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        ob_imbalance = features.get("ob_imbalance")
        rsi = features.get("rsi")
        if price <= 0 or ob_imbalance is None: return None

        state = self.position_state.get(asset, "flat")

        # Fade strong bid imbalance (too many buyers = likely reversal down)
        if ob_imbalance > self.imbalance_threshold and (rsi is None or rsi > 60) and state != "short":
            self.position_state[asset] = "short"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=min(0.8, 0.5 + abs(ob_imbalance)), price=price,
                metadata={"ob_imbalance": round(ob_imbalance, 4), "trigger": "fade_bid_heavy"})

        # Fade strong ask imbalance
        if ob_imbalance < -self.imbalance_threshold and (rsi is None or rsi < 40) and state != "long":
            self.position_state[asset] = "long"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=min(0.8, 0.5 + abs(ob_imbalance)), price=price,
                metadata={"ob_imbalance": round(ob_imbalance, 4), "trigger": "fade_ask_heavy"})

        # Quick exit on rebalance
        if state == "long" and ob_imbalance > -0.05:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.6, price=price, metadata={"trigger": "rebalanced"})
        if state == "short" and ob_imbalance < 0.05:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.6, price=price, metadata={"trigger": "rebalanced"})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "tracked": len(self.position_state)}