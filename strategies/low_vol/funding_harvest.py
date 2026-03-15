"""Funding Rate Harvest — Collect funding payments in low-volatility markets.

Regime: low_vol
Signal: Go short perpetual when funding rate is highly positive (longs pay shorts).
        Go long perpetual when funding rate is highly negative (shorts pay longs).
        Delta-hedge with spot to capture pure funding income.
"""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase


class FundingHarvest(StrategyBase):
    name = "funding_harvest"
    regimes = ["low_vol"]
    timeframe = "1h"
    min_confidence = 0.6
    latency_budget_ms = 2000  # Not latency sensitive
    paper_mode_days = 7  # Longer paper test for carry strategies

    def __init__(self):
        # Funding rate thresholds (annualized)
        self.entry_threshold = 0.0005  # 0.05% per 8h = ~22% annualized
        self.exit_threshold = 0.0001   # Exit when funding normalizes
        self.max_funding = 0.005       # Don't chase extreme funding (likely squeeze)
        self.position_state: dict[str, str] = {}
        self.entry_funding: dict[str, float] = {}

    def on_features(self, asset: str, features: dict) -> StrategySignal | None:
        """Generate signal based on funding rate arbitrage."""
        price = features.get("close", 0)
        funding_rate = features.get("funding_rate")
        realized_vol = features.get("realized_vol", 0)

        if price <= 0 or funding_rate is None:
            return None

        abs_funding = abs(funding_rate)
        current_state = self.position_state.get(asset, "flat")

        # Don't enter if volatility is too high for carry trade
        if realized_vol > 0.03:  # >3% realized vol too risky
            if current_state != "flat":
                # Exit existing position
                self.position_state[asset] = "flat"
                signal = Signal.BUY if current_state == "short" else Signal.SELL
                return StrategySignal(
                    strategy_name=self.name,
                    asset=asset,
                    signal=signal,
                    confidence=0.7,
                    price=price,
                    metadata={"trigger": "vol_exit", "realized_vol": round(realized_vol, 4)},
                )
            return None

        # Don't chase extreme funding (likely short squeeze incoming)
        if abs_funding > self.max_funding:
            return None

        # Entry: high positive funding → short perp (collect from longs)
        if funding_rate > self.entry_threshold and current_state != "short":
            confidence = min(0.9, 0.5 + (abs_funding / self.entry_threshold) * 0.1)
            self.position_state[asset] = "short"
            self.entry_funding[asset] = funding_rate
            return StrategySignal(
                strategy_name=self.name,
                asset=asset,
                signal=Signal.SELL,
                confidence=confidence,
                price=price,
                metadata={
                    "funding_rate": round(funding_rate, 6),
                    "annualized_yield": round(funding_rate * 3 * 365 * 100, 1),  # 3 payments/day
                    "realized_vol": round(realized_vol, 4),
                    "trigger": "positive_funding_entry",
                },
            )

        # Entry: highly negative funding → long perp (collect from shorts)
        if funding_rate < -self.entry_threshold and current_state != "long":
            confidence = min(0.9, 0.5 + (abs_funding / self.entry_threshold) * 0.1)
            self.position_state[asset] = "long"
            self.entry_funding[asset] = funding_rate
            return StrategySignal(
                strategy_name=self.name,
                asset=asset,
                signal=Signal.BUY,
                confidence=confidence,
                price=price,
                metadata={
                    "funding_rate": round(funding_rate, 6),
                    "annualized_yield": round(abs(funding_rate) * 3 * 365 * 100, 1),
                    "realized_vol": round(realized_vol, 4),
                    "trigger": "negative_funding_entry",
                },
            )

        # Exit: funding rate normalized
        if current_state == "short" and funding_rate < self.exit_threshold:
            self.position_state[asset] = "flat"
            return StrategySignal(
                strategy_name=self.name,
                asset=asset,
                signal=Signal.BUY,
                confidence=0.6,
                price=price,
                metadata={
                    "funding_rate": round(funding_rate, 6),
                    "trigger": "funding_normalized_exit",
                },
            )

        if current_state == "long" and funding_rate > -self.exit_threshold:
            self.position_state[asset] = "flat"
            return StrategySignal(
                strategy_name=self.name,
                asset=asset,
                signal=Signal.SELL,
                confidence=0.6,
                price=price,
                metadata={
                    "funding_rate": round(funding_rate, 6),
                    "trigger": "funding_normalized_exit",
                },
            )

        return None

    def on_fill(self, asset: str, fill_data: dict):
        pass

    def health(self) -> dict:
        return {
            "strategy": self.name,
            "active_positions": len([s for s in self.position_state.values() if s != "flat"]),
            "harvesting": {
                asset: round(rate, 6)
                for asset, rate in self.entry_funding.items()
                if self.position_state.get(asset, "flat") != "flat"
            },
        }
