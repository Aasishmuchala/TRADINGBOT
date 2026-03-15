"""Trend Pullback — Enter on pullbacks to moving average in strong trends."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase


class TrendPullback(StrategyBase):
    name = "trend_pullback"
    regimes = ["trending"]
    timeframe = "15m"
    min_confidence = 0.5
    latency_budget_ms = 500
    paper_mode_days = 3

    def __init__(self):
        self.position_state = {}
        self.prev_rsi = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        ema_21 = features.get("ema_21")
        adx = features.get("adx")
        rsi = features.get("rsi")
        atr = features.get("atr")
        if price <= 0 or ema_21 is None or rsi is None or adx is None: return None
        if adx < 25: return None

        prev_rsi = self.prev_rsi.get(asset)
        self.prev_rsi[asset] = rsi
        if prev_rsi is None: return None

        state = self.position_state.get(asset, "flat")
        distance_to_ema = abs(price - ema_21) / ema_21

        # Uptrend pullback: price near EMA from above, RSI bouncing from ~40
        if price > ema_21 and distance_to_ema < 0.01 and prev_rsi < 45 and rsi > 45:
            if state != "long":
                self.position_state[asset] = "long"
                return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                    confidence=min(0.85, 0.5 + adx / 80), price=price,
                    metadata={"trigger": "uptrend_pullback", "distance": round(distance_to_ema, 4)})

        # Downtrend pullback
        if price < ema_21 and distance_to_ema < 0.01 and prev_rsi > 55 and rsi < 55:
            if state != "short":
                self.position_state[asset] = "short"
                return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                    confidence=min(0.85, 0.5 + adx / 80), price=price,
                    metadata={"trigger": "downtrend_pullback", "distance": round(distance_to_ema, 4)})

        # Exit on trend exhaustion
        if state == "long" and rsi > 75:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.6, price=price, metadata={"trigger": "rsi_exit"})
        if state == "short" and rsi < 25:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.6, price=price, metadata={"trigger": "rsi_exit"})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "tracked": len(self.position_state)}
