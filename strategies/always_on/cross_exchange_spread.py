"""Cross-Exchange Spread — Exploit price discrepancies between exchanges.

Regime: always_on (runs in all market conditions)
Signal: BUY on cheap exchange, SELL on expensive exchange when spread exceeds threshold.
        This is a market-neutral arbitrage strategy.
"""
import time
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase


class CrossExchangeSpread(StrategyBase):
    name = "cross_exchange_spread"
    regimes = ["trending", "ranging", "high_vol", "low_vol"]  # Always on
    timeframe = "1m"
    min_confidence = 0.7
    latency_budget_ms = 200  # Arb requires speed
    paper_mode_days = 3

    def __init__(self):
        self.min_spread_bps = 5.0     # Minimum spread to trade (after fees)
        self.max_spread_bps = 100.0   # Don't trade if spread too wide (likely stale data)
        self.fee_bps = 2.0            # Estimated round-trip fee per leg
        self.cooldown_seconds = 10    # Minimum time between signals per pair
        self.last_signal_time: dict[str, float] = {}
        self.exchange_prices: dict[str, dict[str, float]] = {}  # asset -> {exchange: price}

    def on_features(self, asset: str, features: dict) -> StrategySignal | None:
        """Detect cross-exchange arbitrage opportunities."""
        price = features.get("close", 0)
        exchange = features.get("exchange", "")

        if price <= 0 or not exchange:
            return None

        # Track prices per exchange
        if asset not in self.exchange_prices:
            self.exchange_prices[asset] = {}
        self.exchange_prices[asset][exchange] = price

        # Need at least 2 exchanges to compare
        prices = self.exchange_prices.get(asset, {})
        if len(prices) < 2:
            return None

        # Check cooldown
        now = time.time()
        if now - self.last_signal_time.get(asset, 0) < self.cooldown_seconds:
            return None

        # Find best arb opportunity
        exchanges = list(prices.keys())
        best_arb = None
        best_spread = 0

        for i, ex_a in enumerate(exchanges):
            for ex_b in exchanges[i + 1:]:
                price_a = prices[ex_a]
                price_b = prices[ex_b]
                mid = (price_a + price_b) / 2

                if mid <= 0:
                    continue

                spread_bps = abs(price_a - price_b) / mid * 10000
                net_spread = spread_bps - (self.fee_bps * 2)  # Both legs have fees

                if net_spread > best_spread and net_spread >= self.min_spread_bps:
                    if spread_bps <= self.max_spread_bps:
                        cheap_ex = ex_a if price_a < price_b else ex_b
                        expensive_ex = ex_b if price_a < price_b else ex_a
                        best_arb = {
                            "buy_exchange": cheap_ex,
                            "sell_exchange": expensive_ex,
                            "buy_price": min(price_a, price_b),
                            "sell_price": max(price_a, price_b),
                            "spread_bps": round(spread_bps, 2),
                            "net_spread_bps": round(net_spread, 2),
                        }
                        best_spread = net_spread

        if best_arb is None:
            return None

        self.last_signal_time[asset] = now

        # Confidence based on spread size (bigger spread = more confidence it's real)
        confidence = min(0.95, 0.6 + best_arb["net_spread_bps"] / 100)

        return StrategySignal(
            strategy_name=self.name,
            asset=asset,
            signal=Signal.BUY,  # Buy leg (sell leg implied)
            confidence=confidence,
            price=best_arb["buy_price"],
            metadata={
                **best_arb,
                "type": "cross_exchange_arb",
            },
        )

    def on_fill(self, asset: str, fill_data: dict):
        pass

    def health(self) -> dict:
        return {
            "strategy": self.name,
            "tracked_pairs": len(self.exchange_prices),
            "exchanges_per_pair": {
                asset: len(exs) for asset, exs in self.exchange_prices.items()
            },
        }
