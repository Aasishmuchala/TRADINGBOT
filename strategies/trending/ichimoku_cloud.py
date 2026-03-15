"""Ichimoku Cloud — Trade based on cloud breakouts and TK cross."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase


class IchimokuCloud(StrategyBase):
    name = "ichimoku_cloud"
    regimes = ["trending"]
    timeframe = "4h"
    min_confidence = 0.5
    latency_budget_ms = 2000
    paper_mode_days = 7

    def __init__(self):
        self.position_state = {}
        self.prev_tenkan = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        sma_9 = features.get("sma_9", 0)   # Tenkan proxy
        sma_20 = features.get("sma_20", 0)  # Kijun proxy
        ema_9 = features.get("ema_9", 0)
        ema_21 = features.get("ema_21", 0)
        if price <= 0 or sma_9 == 0 or sma_20 == 0: return None

        # Simplified cloud: use EMA 9/21 as Senkou A/B proxy
        cloud_top = max(ema_9, ema_21)
        cloud_bottom = min(ema_9, ema_21)
        state = self.position_state.get(asset, "flat")

        prev_t = self.prev_tenkan.get(asset)
        self.prev_tenkan[asset] = sma_9
        if prev_t is None: return None

        # TK cross above cloud = strong buy
        if prev_t < sma_20 and sma_9 > sma_20 and price > cloud_top:
            if state != "long":
                self.position_state[asset] = "long"
                return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                    confidence=0.8, price=price,
                    metadata={"cloud_top": round(cloud_top, 4), "trigger": "bullish_tk_above_cloud"})

        if prev_t > sma_20 and sma_9 < sma_20 and price < cloud_bottom:
            if state != "short":
                self.position_state[asset] = "short"
                return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                    confidence=0.8, price=price,
                    metadata={"cloud_bottom": round(cloud_bottom, 4), "trigger": "bearish_tk_below_cloud"})

        # Exit if price enters cloud
        if state == "long" and price < cloud_bottom:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.SELL,
                confidence=0.6, price=price, metadata={"trigger": "entered_cloud"})
        if state == "short" and price > cloud_top:
            self.position_state[asset] = "flat"
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=0.6, price=price, metadata={"trigger": "entered_cloud"})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "tracked": len(self.position_state)}
