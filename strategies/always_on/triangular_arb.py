"""Triangular Arb — Exploit price inefficiencies across 3-pair triangles."""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase
import time

class TriangularArb(StrategyBase):
    name = "triangular_arb"
    regimes = ["trending", "ranging", "high_vol", "low_vol"]
    timeframe = "1m"
    min_confidence = 0.7
    latency_budget_ms = 150
    paper_mode_days = 3

    def __init__(self):
        self.min_profit_bps = 3.0
        self.fee_per_trade_bps = 1.0
        self.prices = {}
        self.triangles = [
            ("BTC/USDT", "ETH/BTC", "ETH/USDT"),
            ("BTC/USDT", "SOL/BTC", "SOL/USDT"),
            ("BTC/USDT", "BNB/BTC", "BNB/USDT"),
        ]
        self.cooldown = {}

    def on_features(self, asset, features):
        price = features.get("close", 0)
        if price <= 0: return None
        self.prices[asset] = price

        now = time.time()
        for t in self.triangles:
            if asset not in t: continue
            if all(p in self.prices for p in t):
                if now - self.cooldown.get(str(t), 0) < 5: continue
                profit = self._check_triangle(t)
                if profit and profit > self.min_profit_bps + self.fee_per_trade_bps * 3:
                    self.cooldown[str(t)] = now
                    return StrategySignal(strategy_name=self.name, asset=t[0], signal=Signal.BUY,
                        confidence=min(0.9, 0.6 + profit / 50), price=self.prices[t[0]],
                        metadata={"triangle": list(t), "profit_bps": round(profit, 2)})
        return None

    def _check_triangle(self, triangle):
        a, b, c = triangle
        try:
            pa, pb, pc = self.prices[a], self.prices[b], self.prices[c]
            implied = pa * pb
            if pc > 0:
                arb_bps = abs(implied - pc) / pc * 10000
                return arb_bps
        except: pass
        return None

    def on_fill(self, asset, fill_data): pass
    def health(self): return {"strategy": self.name, "prices_tracked": len(self.prices)}
