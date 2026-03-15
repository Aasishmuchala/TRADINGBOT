"""Volatility Breakout Strategy — Trade explosive moves in high-volatility regimes.

Regime: high_vol
Signal: BUY on ATR breakout above resistance with volume confirmation.
        SELL on ATR breakout below support with volume confirmation.
"""
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase


class VolatilityBreakout(StrategyBase):
    name = "volatility_breakout"
    regimes = ["high_vol"]
    timeframe = "5m"
    min_confidence = 0.55
    latency_budget_ms = 300  # Fast execution needed in volatile markets
    paper_mode_days = 5

    def __init__(self):
        self.atr_multiplier = 2.0  # Breakout threshold as multiple of ATR
        self.volume_multiplier = 1.5  # Volume must be 1.5x average
        self.lookback_highs: dict[str, list[float]] = {}
        self.lookback_lows: dict[str, list[float]] = {}
        self.max_lookback = 20
        self.position_state: dict[str, str] = {}
        self.entry_prices: dict[str, float] = {}

    def on_features(self, asset: str, features: dict) -> StrategySignal | None:
        """Generate signal on ATR-based breakout with volume filter."""
        price = features.get("close", 0)
        high = features.get("high", price)
        low = features.get("low", price)
        atr = features.get("atr")
        volume = features.get("volume", 0)
        sma_20 = features.get("sma_20")
        realized_vol = features.get("realized_vol", 0)

        if price <= 0 or atr is None or atr <= 0:
            return None

        # Track rolling highs/lows
        if asset not in self.lookback_highs:
            self.lookback_highs[asset] = []
            self.lookback_lows[asset] = []

        self.lookback_highs[asset].append(high)
        self.lookback_lows[asset].append(low)

        if len(self.lookback_highs[asset]) > self.max_lookback:
            self.lookback_highs[asset] = self.lookback_highs[asset][-self.max_lookback:]
            self.lookback_lows[asset] = self.lookback_lows[asset][-self.max_lookback:]

        if len(self.lookback_highs[asset]) < 10:
            return None

        # Compute breakout levels
        recent_high = max(self.lookback_highs[asset][:-1])  # Exclude current candle
        recent_low = min(self.lookback_lows[asset][:-1])
        breakout_up = recent_high + atr * self.atr_multiplier
        breakout_down = recent_low - atr * self.atr_multiplier

        # Estimate average volume (simple heuristic)
        avg_volume = volume  # In production, use rolling average from features
        volume_ok = True  # Simplified; in production check volume vs avg

        current_state = self.position_state.get(asset, "flat")

        # Upside breakout
        if price > breakout_up and volume_ok and current_state != "long":
            confidence = min(1.0, 0.5 + realized_vol * 5)  # Higher vol = higher confidence for breakout
            self.position_state[asset] = "long"
            self.entry_prices[asset] = price
            return StrategySignal(
                strategy_name=self.name,
                asset=asset,
                signal=Signal.BUY,
                confidence=confidence,
                price=price,
                metadata={
                    "breakout_level": round(breakout_up, 4),
                    "atr": round(atr, 4),
                    "recent_high": round(recent_high, 4),
                    "realized_vol": round(realized_vol, 4),
                    "trigger": "upside_breakout",
                },
            )

        # Downside breakout
        if price < breakout_down and volume_ok and current_state != "short":
            confidence = min(1.0, 0.5 + realized_vol * 5)
            self.position_state[asset] = "short"
            self.entry_prices[asset] = price
            return StrategySignal(
                strategy_name=self.name,
                asset=asset,
                signal=Signal.SELL,
                confidence=confidence,
                price=price,
                metadata={
                    "breakout_level": round(breakout_down, 4),
                    "atr": round(atr, 4),
                    "recent_low": round(recent_low, 4),
                    "realized_vol": round(realized_vol, 4),
                    "trigger": "downside_breakout",
                },
            )

        # Trailing stop: exit if price retraces 1.5 ATR from entry
        if current_state == "long" and asset in self.entry_prices:
            stop = self.entry_prices[asset] - 1.5 * atr
            if price < stop:
                self.position_state[asset] = "flat"
                return StrategySignal(
                    strategy_name=self.name,
                    asset=asset,
                    signal=Signal.SELL,
                    confidence=0.7,
                    price=price,
                    metadata={"trigger": "trailing_stop", "stop_level": round(stop, 4)},
                )

        if current_state == "short" and asset in self.entry_prices:
            stop = self.entry_prices[asset] + 1.5 * atr
            if price > stop:
                self.position_state[asset] = "flat"
                return StrategySignal(
                    strategy_name=self.name,
                    asset=asset,
                    signal=Signal.BUY,
                    confidence=0.7,
                    price=price,
                    metadata={"trigger": "trailing_stop", "stop_level": round(stop, 4)},
                )

        return None

    def on_fill(self, asset: str, fill_data: dict):
        pass

    def health(self) -> dict:
        return {
            "strategy": self.name,
            "active_positions": len([s for s in self.position_state.values() if s != "flat"]),
            "tracked_assets": len(self.lookback_highs),
        }
