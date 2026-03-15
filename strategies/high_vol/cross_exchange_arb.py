"""Cross-Exchange Arb (High Vol) — Exploit exchange dislocations during volatility."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase
import time

class CrossExchangeArbHV(StrategyBase):
    name = "cross_exchange_arb_hv"
    regimes = ["high_vol"]
    timeframe = "1m"
    min_confidence = 0.6
    latency_budget_ms = 200
    paper_mode_days = 3

    def __init__(self):
        self.min_spread_bps = 8.0
        self.exchange_prices = {}
        self.cooldown = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        exchange = features.get("exchange", "")
        realized_vol = features.get("realized_vol", 0)
        if price <= 0 or not exchange: return None
        if realized_vol < 0.02: return None

        if asset not in self.exchange_prices: self.exchange_prices[asset] = {}
        self.exchange_prices[asset][exchange] = price
        if len(self.exchange_prices[asset]) < 2: return None
        now = time.time()
        if now - self.cooldown.get(asset, 0) < 5: return None

        prices = self.exchange_prices[asset]
        max_p = max(prices.values())
        min_p = min(prices.values())
        mid = (max_p + min_p) / 2
        if mid <= 0: return None
        spread_bps = (max_p - min_p) / mid * 10000

        if spread_bps >= self.min_spread_bps:
            self.cooldown[asset] = now
            return StrategySignal(strategy_name=self.name, asset=asset, signal=Signal.BUY,
                confidence=min(0.9, 0.6 + spread_bps / 100), price=min_p,
                metadata={"spread_bps": round(spread_bps, 2), "vol": round(realized_vol, 4)})
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "tracked": len(self.exchange_prices)}
