"""Stochastic RSI — Trade stoch RSI crossovers in ranging markets."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase


class StochRSI(StrategyBase):
    name = "stoch_rsi"
    regimes = ["ranging"]
    timeframe = "15m"
    min_confidence = 0.5
    latency_budget_ms = 1000
    paper_mode_days = 3

    def __init__(self):
        self.rsi_history = {}
        self.window = 14
        self.oversold = 20
        self.overbought = 80
        self.position_state = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        rsi = features.get("rsi")
        if price <= 0 or rsi is None: return None

        if asset not in self.rsi_history: self.rsi_history[asset] = []
        self.rsi_history[asset].append(rsi)
        if len(self.rsi_history[asset]) > self.window:
            self.rsi_history[asset] = self.rsi_history[asset][-self.window:]
        if len(self.rsi_history[asset]) < self.window: return None

        hist = self.rsi_history[asset]
        rsi_min = min(hist)
        rsi_max = max(hist)
        if rsi_max == rsi_min: return None
        stoch_rsi = (rsi - rsi_min) / (rsi_max - rsi_min) * 100

        state = self.position_state.get(asset, "flat")

        if stoch_rsi < self.oversold and state != "long":
            self.position_state[asset] = "long"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=min(0.85, 0.5 + (self.oversold - stoch_rsi) / 50), price=price,
                metadata={"stoch_rsi": round(stoch_rsi, 2)})
        if stoch_rsi > self.overbought and state != "short":
            self.position_state[asset] = "short"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=min(0.85, 0.5 + (stoch_rsi - self.overbought) / 50), price=price,
                metadata={"stoch_rsi": round(stoch_rsi, 2)})
        if state == "long" and stoch_rsi > 50:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.6, price=price, metadata={"trigger": "stoch_exit"})
        if state == "short" and stoch_rsi < 50:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.6, price=price, metadata={"trigger": "stoch_exit"})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "tracked": len(self.rsi_history)}