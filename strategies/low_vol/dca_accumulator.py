"""DCA Accumulator — Dollar-cost average into positions during quiet markets."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase
import time

class DCAAccumulator(StrategyBase):
    name = "dca_accumulator"
    regimes = ["low_vol"]
    timeframe = "4h"
    min_confidence = 0.5
    latency_budget_ms = 5000
    paper_mode_days = 14

    def __init__(self):
        self.last_buy_time = {}
        self.buy_interval = 14400  # 4 hours
        self.position_count = {}
        self.max_buys = 10

    def on_features(self, asset, features):
        price = features.get("close", 0)
        rsi = features.get("rsi")
        realized_vol = features.get("realized_vol")
        if price <= 0: return None
        if realized_vol and realized_vol > 0.015: return None

        now = time.time()
        last = self.last_buy_time.get(asset, 0)
        count = self.position_count.get(asset, 0)

        if now - last >= self.buy_interval and count < self.max_buys:
            if rsi is None or rsi < 55:
                self.last_buy_time[asset] = now
                self.position_count[asset] = count + 1
                return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                    confidence=0.5, price=price,
                    metadata={"dca_count": count + 1, "trigger": "scheduled_dca"})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "positions": dict(self.position_count)}
