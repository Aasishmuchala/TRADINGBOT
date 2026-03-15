"""Kelly Criterion position sizing calculator.

Half-Kelly default with regime confidence and leverage adjustments.
"""
import math
from dataclasses import dataclass


@dataclass
class KellyResult:
    raw_fraction: float        # Full Kelly fraction
    adjusted_fraction: float   # After half-kelly + regime + leverage adjustments
    position_size_usd: float   # Dollar amount to risk
    leverage_used: float       # Effective leverage
    capped: bool               # Whether Kelly cap was applied


class KellyCalculator:
    """Half-Kelly position sizing with regime and leverage adjustments."""

    def __init__(
        self,
        kelly_fraction: float = 0.5,   # Half-Kelly default
        max_kelly_bet: float = 0.10,   # 10% max single bet as fraction of capital
        max_leverage: float = 2.0,
    ):
        self.kelly_fraction = kelly_fraction
        self.max_kelly_bet = max_kelly_bet
        self.max_leverage = max_leverage

    def compute(
        self,
        win_rate: float,
        avg_win: float,
        avg_loss: float,
        capital: float,
        regime_confidence: float = 1.0,
        current_leverage: float = 1.0,
    ) -> KellyResult:
        """Compute Kelly-optimal position size.

        Args:
            win_rate: Historical win rate (0-1)
            avg_win: Average winning trade return (positive, e.g. 0.02 for 2%)
            avg_loss: Average losing trade return (positive, e.g. 0.01 for 1%)
            capital: Total available capital in USD
            regime_confidence: ML regime detection confidence (0-1)
            current_leverage: Current portfolio leverage ratio

        Returns:
            KellyResult with sizing details
        """
        # Guard against division by zero or invalid inputs
        if avg_loss <= 0 or avg_win <= 0 or win_rate <= 0 or win_rate >= 1:
            return KellyResult(
                raw_fraction=0.0,
                adjusted_fraction=0.0,
                position_size_usd=0.0,
                leverage_used=current_leverage,
                capped=False,
            )

        # Classic Kelly: f* = (bp - q) / b
        # where b = avg_win/avg_loss, p = win_rate, q = 1-p
        b = avg_win / avg_loss
        p = win_rate
        q = 1.0 - p
        raw_kelly = (b * p - q) / b

        # If Kelly is negative, don't trade
        if raw_kelly <= 0:
            return KellyResult(
                raw_fraction=raw_kelly,
                adjusted_fraction=0.0,
                position_size_usd=0.0,
                leverage_used=current_leverage,
                capped=False,
            )

        # Apply half-Kelly fraction
        adjusted = raw_kelly * self.kelly_fraction

        # Scale by regime confidence (lower confidence = smaller position)
        adjusted *= max(0.0, min(1.0, regime_confidence))

        # Leverage adjustment: reduce position as leverage increases
        leverage_ratio = current_leverage / self.max_leverage
        leverage_dampener = max(0.0, 1.0 - leverage_ratio)
        adjusted *= leverage_dampener

        # Apply Kelly cap
        capped = adjusted > self.max_kelly_bet
        adjusted = min(adjusted, self.max_kelly_bet)

        position_size = adjusted * capital

        return KellyResult(
            raw_fraction=raw_kelly,
            adjusted_fraction=adjusted,
            position_size_usd=position_size,
            leverage_used=current_leverage,
            capped=capped,
        )

    def compute_from_trades(
        self,
        wins: int,
        losses: int,
        total_profit: float,
        total_loss: float,
        capital: float,
        regime_confidence: float = 1.0,
        current_leverage: float = 1.0,
    ) -> KellyResult:
        """Convenience method: compute from raw trade statistics.

        Args:
            wins: Number of winning trades
            losses: Number of losing trades
            total_profit: Sum of all winning trade returns
            total_loss: Sum of all losing trade returns (positive number)
            capital: Available capital
            regime_confidence: Regime detection confidence
            current_leverage: Current leverage ratio
        """
        total_trades = wins + losses
        if total_trades == 0 or wins == 0 or losses == 0:
            return KellyResult(
                raw_fraction=0.0,
                adjusted_fraction=0.0,
                position_size_usd=0.0,
                leverage_used=current_leverage,
                capped=False,
            )

        win_rate = wins / total_trades
        avg_win = total_profit / wins
        avg_loss = abs(total_loss) / losses

        return self.compute(
            win_rate=win_rate,
            avg_win=avg_win,
            avg_loss=avg_loss,
            capital=capital,
            regime_confidence=regime_confidence,
            current_leverage=current_leverage,
        )