"""RSI Extremes — Buy oversold RSI, sell overbought RSI in ranging markets."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase


class RSIExtremes(StrategyBase):
    name = "rsi_extremes"
    regimes = ["ranging"]
    timeframe = "15m"
    min_confidence = 0.5
    latency_budget_ms = 1000
    paper_mode_days = 3

    def __init__(self):
        self.oversold = 25
        self.overbought = 75
        self.exit_low = 45
        self.exit_high = 55
        self.prev_rsi = {}
        self.position_state = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        rsi = features.get("rsi")
        adx = features.get("adx")
        if price <= 0 or rsi is None: return None
        if adx and adx > 30: return None  # Skip if trending

        prev = self.prev_rsi.get(asset)
        self.prev_rsi[asset] = rsi
        if prev is None: return None
        state = self.position_state.get(asset, "flat")

        if prev < self.oversold and rsi > self.oversold and state != "long":
            self.position_state[asset] = "long"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=min(0.85, 0.5 + (self.oversold - prev) / 50), price=price,
                metadata={"rsi": round(rsi, 2), "trigger": "oversold_bounce"})
        if prev > self.overbought and rsi < self.overbought and state != "short":
            self.position_state[asset] = "short"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=min(0.85, 0.5 + (prev - self.overbought) / 50), price=price,
                metadata={"rsi": round(rsi, 2), "trigger": "overbought_reversal"})
        if state == "long" and rsi > self.exit_high:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.6, price=price, metadata={"trigger": "rsi_exit"})
        if state == "short" and rsi < self.exit_low:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.6, price=price, metadata={"trigger": "rsi_exit"})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "tracked": len(self.prev_rsi)}