"""Slippage Model — OLS-based slippage estimation with coefficient versioning."""
import time
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import structlog

logger = structlog.get_logger()


@dataclass
class SlippageEstimate:
    expected_bps: float       # Expected slippage in basis points
    worst_case_bps: float     # 95th percentile estimate
    confidence: float         # Model confidence (0-1)
    model_version: int        # Coefficient version used


@dataclass
class SlippageCoefficients:
    intercept: float = 0.5       # Base slippage in bps
    size_coeff: float = 0.02     # bps per $1000 order size
    vol_coeff: float = 0.8       # bps per 1% realized volatility
    spread_coeff: float = 0.5    # bps per 1 bps of spread
    residual_std: float = 1.0    # Standard deviation of residuals
    version: int = 1
    fitted_at: float = field(default_factory=time.time)
    n_samples: int = 0


class SlippageModel:
    """Predicts execution slippage using a linear model.
    
    Model: slippage_bps = intercept + size_coeff * (order_size/1000) 
                         + vol_coeff * realized_vol + spread_coeff * spread_bps
    """

    def __init__(self):
        self.coefficients = SlippageCoefficients()
        self._fill_history: list[dict] = []
        self.max_history = 5000
        self.min_samples_for_refit = 50

    def estimate(
        self,
        order_size_usd: float,
        realized_vol: float,
        spread_bps: float,
    ) -> SlippageEstimate:
        """Estimate slippage for a given order.
        
        Args:
            order_size_usd: Order notional in USD
            realized_vol: Current realized volatility (e.g., 0.02 for 2%)
            spread_bps: Current bid-ask spread in basis points
        
        Returns:
            SlippageEstimate with expected and worst-case values
        """
        c = self.coefficients

        # Linear model prediction
        expected = (
            c.intercept
            + c.size_coeff * (order_size_usd / 1000.0)
            + c.vol_coeff * (realized_vol * 100.0)  # Convert to percentage
            + c.spread_coeff * spread_bps
        )

        # Ensure non-negative
        expected = max(0.0, expected)

        # Worst case: expected + 1.96 * residual std (95th percentile)
        worst_case = expected + 1.96 * c.residual_std

        # Confidence based on number of samples used to fit
        if c.n_samples >= 500:
            confidence = 0.9
        elif c.n_samples >= 100:
            confidence = 0.7
        elif c.n_samples >= self.min_samples_for_refit:
            confidence = 0.5
        else:
            confidence = 0.3  # Default coefficients

        return SlippageEstimate(
            expected_bps=round(expected, 2),
            worst_case_bps=round(worst_case, 2),
            confidence=confidence,
            model_version=c.version,
        )

    def record_fill(
        self,
        order_size_usd: float,
        realized_vol: float,
        spread_bps: float,
        actual_slippage_bps: float,
    ):
        """Record an actual fill for future model refitting."""
        self._fill_history.append({
            "order_size_usd": order_size_usd,
            "realized_vol": realized_vol,
            "spread_bps": spread_bps,
            "actual_slippage_bps": actual_slippage_bps,
            "timestamp": time.time(),
        })
        # Trim old history
        if len(self._fill_history) > self.max_history:
            self._fill_history = self._fill_history[-self.max_history:]

    def refit(self) -> bool:
        """Refit OLS coefficients from fill history.
        
        Returns:
            True if refit was successful
        """
        if len(self._fill_history) < self.min_samples_for_refit:
            logger.info(
                "slippage.refit_skipped",
                samples=len(self._fill_history),
                required=self.min_samples_for_refit,
            )
            return False

        try:
            n = len(self._fill_history)

            # Build feature matrix [1, size/1000, vol*100, spread]
            X = np.zeros((n, 4))
            y = np.zeros(n)

            for i, fill in enumerate(self._fill_history):
                X[i, 0] = 1.0  # Intercept
                X[i, 1] = fill["order_size_usd"] / 1000.0
                X[i, 2] = fill["realized_vol"] * 100.0
                X[i, 3] = fill["spread_bps"]
                y[i] = fill["actual_slippage_bps"]

            # OLS: beta = (X'X)^-1 X'y
            XtX = X.T @ X
            Xty = X.T @ y

            # Add small ridge term for numerical stability
            ridge = 1e-6 * np.eye(4)
            beta = np.linalg.solve(XtX + ridge, Xty)

            # Compute residuals
            residuals = y - X @ beta
            residual_std = float(np.std(residuals))

            # Update coefficients
            self.coefficients = SlippageCoefficients(
                intercept=max(0, float(beta[0])),
                size_coeff=max(0, float(beta[1])),
                vol_coeff=max(0, float(beta[2])),
                spread_coeff=max(0, float(beta[3])),
                residual_std=residual_std,
                version=self.coefficients.version + 1,
                fitted_at=time.time(),
                n_samples=n,
            )

            logger.info(
                "slippage.refit_complete",
                version=self.coefficients.version,
                samples=n,
                intercept=self.coefficients.intercept,
                size_coeff=self.coefficients.size_coeff,
                vol_coeff=self.coefficients.vol_coeff,
                spread_coeff=self.coefficients.spread_coeff,
                residual_std=residual_std,
            )
            return True

        except Exception as e:
            logger.error("slippage.refit_failed", error=str(e))
            return False

    def get_coefficients(self) -> dict:
        """Return current coefficients as dict for persistence."""
        c = self.coefficients
        return {
            "intercept": c.intercept,
            "size_coeff": c.size_coeff,
            "vol_coeff": c.vol_coeff,
            "spread_coeff": c.spread_coeff,
            "residual_std": c.residual_std,
            "version": c.version,
            "fitted_at": c.fitted_at,
            "n_samples": c.n_samples,
        }

    def load_coefficients(self, data: dict):
        """Load coefficients from persisted data."""
        self.coefficients = SlippageCoefficients(
            intercept=data.get("intercept", 0.5),
            size_coeff=data.get("size_coeff", 0.02),
            vol_coeff=data.get("vol_coeff", 0.8),
            spread_coeff=data.get("spread_coeff", 0.5),
            residual_std=data.get("residual_std", 1.0),
            version=data.get("version", 1),
            fitted_at=data.get("fitted_at", time.time()),
            n_samples=data.get("n_samples", 0),
        )
