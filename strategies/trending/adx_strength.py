"""ADX Strength Rider — Enter when ADX is rising and >25, exit when weakening."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase


class ADXStrength(StrategyBase):
    name = "adx_strength"
    regimes = ["trending"]
    timeframe = "1h"
    min_confidence = 0.5
    latency_budget_ms = 1000
    paper_mode_days = 3

    def __init__(self):
        self.prev_adx = {}
        self.position_state = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        adx = features.get("adx")
        ema_9 = features.get("ema_9")
        ema_21 = features.get("ema_21")
        if price <= 0 or adx is None or ema_9 is None or ema_21 is None: return None

        prev = self.prev_adx.get(asset)
        self.prev_adx[asset] = adx
        if prev is None: return None

        state = self.position_state.get(asset, "flat")
        adx_rising = adx > prev

        # Entry: ADX crossing above 25 and rising, with EMA direction
        if adx > 25 and adx_rising and prev < 25:
            if ema_9 > ema_21 and state != "long":
                self.position_state[asset] = "long"
                return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                    confidence=min(0.9, adx / 60), price=price,
                    metadata={"adx": round(adx, 2), "trend": "up"})
            elif ema_9 < ema_21 and state != "short":
                self.position_state[asset] = "short"
                return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                    confidence=min(0.9, adx / 60), price=price,
                    metadata={"adx": round(adx, 2), "trend": "down"})

        # Exit: ADX declining below 20
        if adx < 20 and not adx_rising and state != "flat":
            signal = Signal.SELL if state == "long" else Signal.BUY
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=signal,
                confidence=0.6, price=price, metadata={"adx": round(adx, 2), "trigger": "adx_weakening"})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "tracked": len(self.prev_adx)}
