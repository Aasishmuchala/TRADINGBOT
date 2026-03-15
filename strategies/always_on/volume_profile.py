"""Volume Profile — Trade based on volume-weighted price levels."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase
from collections import defaultdict

class VolumeProfile(StrategyBase):
    name = "volume_profile"
    regimes = ["trending", "ranging", "high_vol", "low_vol"]
    timeframe = "15m"
    min_confidence = 0.5
    latency_budget_ms = 1000
    paper_mode_days = 5

    def __init__(self):
        self.price_volume = {}
        self.n_bins = 20
        self.lookback = 100
        self.position_state = {}
        self.tick_count = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        volume = features.get("volume", 0)
        if price <= 0: return None

        if asset not in self.price_volume:
            self.price_volume[asset] = []
            self.tick_count[asset] = 0
        self.price_volume[asset].append((price, volume))
        self.tick_count[asset] += 1
        if len(self.price_volume[asset]) > self.lookback:
            self.price_volume[asset] = self.price_volume[asset][-self.lookback:]
        if len(self.price_volume[asset]) < 30: return None

        prices = [pv[0] for pv in self.price_volume[asset]]
        volumes = [pv[1] for pv in self.price_volume[asset]]
        min_p, max_p = min(prices), max(prices)
        if max_p == min_p: return None
        bin_size = (max_p - min_p) / self.n_bins

        vol_profile = defaultdict(float)
        for p, v in self.price_volume[asset]:
            bin_idx = min(int((p - min_p) / bin_size), self.n_bins - 1)
            vol_profile[bin_idx] += v

        # Find POC (Point of Control = highest volume price level)
        poc_bin = max(vol_profile, key=vol_profile.get)
        poc_price = min_p + (poc_bin + 0.5) * bin_size
        current_bin = min(int((price - min_p) / bin_size), self.n_bins - 1)
        state = self.position_state.get(asset, "flat")

        # Buy below POC, sell above
        if price < poc_price * 0.995 and current_bin < poc_bin - 2 and state != "long":
            self.position_state[asset] = "long"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.65, price=price,
                metadata={"poc": round(poc_price, 4), "trigger": "below_poc"})
        if price > poc_price * 1.005 and current_bin > poc_bin + 2 and state != "short":
            self.position_state[asset] = "short"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.65, price=price,
                metadata={"poc": round(poc_price, 4), "trigger": "above_poc"})
        if state == "long" and price >= poc_price:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.6, price=price, metadata={"trigger": "poc_reached"})
        if state == "short" and price <= poc_price:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.6, price=price, metadata={"trigger": "poc_reached"})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "tracked": len(self.price_volume)}
