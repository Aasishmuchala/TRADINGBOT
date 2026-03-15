"""Bollinger Band Mean Reversion — Buy oversold, sell overbought in ranging markets.

Regime: ranging
Signal: BUY when price touches lower band with RSI confirmation (<30).
        SELL when price touches upper band with RSI confirmation (>70).
"""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase


class BollingerReversion(StrategyBase):
    name = "bollinger_reversion"
    regimes = ["ranging"]
    timeframe = "15m"
    min_confidence = 0.5
    latency_budget_ms = 1000
    paper_mode_days = 3

    def __init__(self):
        self.bb_period = 20
        self.bb_std = 2.0
        self.rsi_oversold = 30
        self.rsi_overbought = 70
        self.position_state: dict[str, str] = {}

    def on_features(self, asset: str, features: dict) -> StrategySignal | None:
        """Generate signal on Bollinger Band touch with RSI filter."""
        price = features.get("close", 0)
        bb_upper = features.get("bb_upper")
        bb_lower = features.get("bb_lower")
        bb_mid = features.get("bb_mid")
        rsi = features.get("rsi")

        if price <= 0 or bb_upper is None or bb_lower is None or bb_mid is None:
            return None

        if rsi is None:
            return None

        current_state = self.position_state.get(asset, "flat")
        bb_width = bb_upper - bb_lower
        if bb_width <= 0:
            return None

        # Compute %B: where price is relative to bands (0=lower, 1=upper)
        pct_b = (price - bb_lower) / bb_width

        # Buy signal: price at/below lower band + RSI oversold
        if pct_b <= 0.05 and rsi < self.rsi_oversold and current_state != "long":
            # Confidence increases as price gets further below band
            confidence = min(1.0, 0.5 + (1.0 - pct_b) * 0.3 + (self.rsi_oversold - rsi) / 100)
            self.position_state[asset] = "long"
            return StrategySignal(
                strategy_name=self.name,
                asset=asset,
                signal=Signal.BUY,
                confidence=confidence,
                price=price,
                metadata={
                    "pct_b": round(pct_b, 4),
                    "rsi": round(rsi, 2),
                    "bb_upper": round(bb_upper, 4),
                    "bb_lower": round(bb_lower, 4),
                    "trigger": "lower_band_touch",
                },
            )

        # Sell signal: price at/above upper band + RSI overbought
        if pct_b >= 0.95 and rsi > self.rsi_overbought and current_state != "short":
            confidence = min(1.0, 0.5 + (pct_b - 1.0) * 0.3 + (rsi - self.rsi_overbought) / 100)
            self.position_state[asset] = "short"
            return StrategySignal(
                strategy_name=self.name,
                asset=asset,
                signal=Signal.SELL,
                confidence=confidence,
                price=price,
                metadata={
                    "pct_b": round(pct_b, 4),
                    "rsi": round(rsi, 2),
                    "bb_upper": round(bb_upper, 4),
                    "bb_lower": round(bb_lower, 4),
                    "trigger": "upper_band_touch",
                },
            )

        # Exit: price returns to middle band
        if current_state == "long" and price >= bb_mid:
            self.position_state[asset] = "flat"
            return StrategySignal(
                strategy_name=self.name,
                asset=asset,
                signal=Signal.SELL,
                confidence=0.6,
                price=price,
                metadata={"trigger": "mean_reversion_exit", "pct_b": round(pct_b, 4)},
            )

        if current_state == "short" and price <= bb_mid:
            self.position_state[asset] = "flat"
            return StrategySignal(
                strategy_name=self.name,
                asset=asset,
                signal=Signal.BUY,
                confidence=0.6,
                price=price,
                metadata={"trigger": "mean_reversion_exit", "pct_b": round(pct_b, 4)},
            )

        return None

    def on_fill(self, asset: str, fill_data: dict):
        pass

    def health(self) -> dict:
        return {
            "strategy": self.name,
            "active_positions": len([s for s in self.position_state.values() if s != "flat"]),
        }
