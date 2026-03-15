"""EMA Crossover Strategy — Classic dual EMA trend-following.

Regime: trending
Signal: BUY when fast EMA crosses above slow EMA with ADX confirmation.
        SELL when fast EMA crosses below slow EMA.
"""
from core.models import Signal, StrategySignal, FeatureSnapshot
from services.strategy_runner.base import StrategyBase


class EMACrossover(StrategyBase):
    name = "ema_crossover"
    regimes = ["trending"]
    timeframe = "15m"
    min_confidence = 0.5
    latency_budget_ms = 500
    paper_mode_days = 3

    def __init__(self):
        self.fast_period = 9
        self.slow_period = 21
        self.adx_threshold = 25.0
        self.prev_fast: dict[str, float] = {}  # asset -> previous fast EMA
        self.prev_slow: dict[str, float] = {}  # asset -> previous slow EMA
        self.position_state: dict[str, str] = {}  # asset -> "long" | "short" | "flat"

    def on_features(self, asset: str, features: dict) -> StrategySignal | None:
        """Generate signal on EMA crossover with ADX filter."""
        ema_fast = features.get("ema_9")
        ema_slow = features.get("ema_21")
        adx = features.get("adx")
        price = features.get("close", 0)

        if ema_fast is None or ema_slow is None or price <= 0:
            return None

        # Store previous values for crossover detection
        prev_fast = self.prev_fast.get(asset)
        prev_slow = self.prev_slow.get(asset)
        self.prev_fast[asset] = ema_fast
        self.prev_slow[asset] = ema_slow

        if prev_fast is None or prev_slow is None:
            return None

        # ADX filter: only trade when trend is strong enough
        if adx is not None and adx < self.adx_threshold:
            return None

        current_state = self.position_state.get(asset, "flat")

        # Detect crossovers
        was_below = prev_fast < prev_slow
        was_above = prev_fast > prev_slow
        now_above = ema_fast > ema_slow
        now_below = ema_fast < ema_slow

        # Bullish crossover
        if was_below and now_above and current_state != "long":
            confidence = min(1.0, (adx or 25) / 50.0)  # Higher ADX = higher confidence
            self.position_state[asset] = "long"
            return StrategySignal(
                strategy_name=self.name,
                asset=asset,
                signal=Signal.BUY,
                confidence=confidence,
                price=price,
                metadata={
                    "ema_fast": round(ema_fast, 4),
                    "ema_slow": round(ema_slow, 4),
                    "adx": round(adx, 2) if adx else None,
                    "crossover": "bullish",
                },
            )

        # Bearish crossover
        if was_above and now_below and current_state != "short":
            confidence = min(1.0, (adx or 25) / 50.0)
            self.position_state[asset] = "short"
            return StrategySignal(
                strategy_name=self.name,
                asset=asset,
                signal=Signal.SELL,
                confidence=confidence,
                price=price,
                metadata={
                    "ema_fast": round(ema_fast, 4),
                    "ema_slow": round(ema_slow, 4),
                    "adx": round(adx, 2) if adx else None,
                    "crossover": "bearish",
                },
            )

        return None

    def on_fill(self, asset: str, fill_data: dict):
        """Track position state from fills."""
        pass  # Position state managed internally via crossover signals

    def health(self) -> dict:
        return {
            "strategy": self.name,
            "active_positions": len([s for s in self.position_state.values() if s != "flat"]),
            "tracked_assets": len(self.prev_fast),
        }
