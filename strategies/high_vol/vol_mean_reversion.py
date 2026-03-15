"""Volatility Mean Reversion — Bet on vol returning to mean after spikes."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase

class VolMeanReversion(StrategyBase):
    name = "vol_mean_reversion"
    regimes = ["high_vol"]
    timeframe = "1h"
    min_confidence = 0.5
    latency_budget_ms = 1000
    paper_mode_days = 5

    def __init__(self):
        self.vol_history = {}
        self.window = 24
        self.position_state = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        realized_vol = features.get("realized_vol")
        rsi = features.get("rsi")
        if price <= 0 or realized_vol is None: return None

        if asset not in self.vol_history: self.vol_history[asset] = []
        self.vol_history[asset].append(realized_vol)
        if len(self.vol_history[asset]) > self.window:
            self.vol_history[asset] = self.vol_history[asset][-self.window:]
        if len(self.vol_history[asset]) < 10: return None

        import numpy as np
        arr = np.array(self.vol_history[asset])
        vol_mean = np.mean(arr)
        vol_std = np.std(arr)
        if vol_std == 0: return None
        vol_zscore = (realized_vol - vol_mean) / vol_std
        state = self.position_state.get(asset, "flat")

        # Vol spike + oversold = buy the dip
        if vol_zscore > 2.0 and rsi and rsi < 30 and state != "long":
            self.position_state[asset] = "long"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=min(0.85, 0.5 + vol_zscore / 5), price=price,
                metadata={"vol_zscore": round(vol_zscore, 2), "realized_vol": round(realized_vol, 4)})
        if vol_zscore > 2.0 and rsi and rsi > 70 and state != "short":
            self.position_state[asset] = "short"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=min(0.85, 0.5 + vol_zscore / 5), price=price,
                metadata={"vol_zscore": round(vol_zscore, 2), "realized_vol": round(realized_vol, 4)})
        if state != "flat" and abs(vol_zscore) < 0.5:
            signal = Signal.SELL if state == "long" else Signal.BUY
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=signal,
                confidence=0.6, price=price, metadata={"trigger": "vol_normalized"})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "tracked": len(self.vol_history)}
