"""Walk-Forward Validation — Out-of-sample strategy testing."""
import numpy as np
import structlog
from dataclasses import dataclass
from typing import Optional

logger = structlog.get_logger()


@dataclass
class WalkForwardResult:
    strategy: str
    n_windows: int
    in_sample_sharpe: float
    out_of_sample_sharpe: float
    walk_forward_efficiency: float  # OOS Sharpe / IS Sharpe
    is_degraded: bool               # True if OOS much worse than IS
    window_results: list[dict]


class WalkForwardValidator:
    """Walk-forward validation: train on window, test on next, slide forward.
    
    Prevents overfitting by ensuring strategies work on unseen data.
    """

    def __init__(
        self,
        train_window_days: int = 60,
        test_window_days: int = 14,
        min_windows: int = 3,
        degradation_threshold: float = 0.5,  # OOS/IS ratio below this = degraded
    ):
        self.train_days = train_window_days
        self.test_days = test_window_days
        self.min_windows = min_windows
        self.degradation_threshold = degradation_threshold

    def validate(
        self,
        equity_curve: list[float],
        total_days: int,
    ) -> WalkForwardResult:
        """Run walk-forward validation on an equity curve.
        
        Splits the equity curve into overlapping train/test windows
        and computes in-sample vs out-of-sample performance.
        """
        if not equity_curve or total_days < self.train_days + self.test_days:
            return WalkForwardResult(
                strategy="unknown", n_windows=0,
                in_sample_sharpe=0, out_of_sample_sharpe=0,
                walk_forward_efficiency=0, is_degraded=True,
                window_results=[],
            )

        points_per_day = len(equity_curve) / total_days
        train_points = int(self.train_days * points_per_day)
        test_points = int(self.test_days * points_per_day)
        step = test_points  # Slide by test window

        window_results = []
        is_sharpes = []
        oos_sharpes = []

        idx = 0
        while idx + train_points + test_points <= len(equity_curve):
            # In-sample window
            is_curve = equity_curve[idx:idx + train_points]
            # Out-of-sample window
            oos_curve = equity_curve[idx + train_points:idx + train_points + test_points]

            is_sharpe = self._compute_sharpe(is_curve)
            oos_sharpe = self._compute_sharpe(oos_curve)

            window_results.append({
                "window": len(window_results) + 1,
                "is_start_idx": idx,
                "is_sharpe": round(is_sharpe, 3),
                "oos_sharpe": round(oos_sharpe, 3),
                "efficiency": round(oos_sharpe / is_sharpe, 3) if is_sharpe > 0 else 0,
            })

            is_sharpes.append(is_sharpe)
            oos_sharpes.append(oos_sharpe)

            idx += step

        if len(window_results) < self.min_windows:
            return WalkForwardResult(
                strategy="unknown", n_windows=len(window_results),
                in_sample_sharpe=0, out_of_sample_sharpe=0,
                walk_forward_efficiency=0, is_degraded=True,
                window_results=window_results,
            )

        avg_is = np.mean(is_sharpes)
        avg_oos = np.mean(oos_sharpes)
        efficiency = avg_oos / avg_is if avg_is > 0 else 0

        return WalkForwardResult(
            strategy="unknown",
            n_windows=len(window_results),
            in_sample_sharpe=round(float(avg_is), 3),
            out_of_sample_sharpe=round(float(avg_oos), 3),
            walk_forward_efficiency=round(float(efficiency), 3),
            is_degraded=efficiency < self.degradation_threshold,
            window_results=window_results,
        )

    def _compute_sharpe(self, equity_curve: list[float]) -> float:
        """Compute annualized Sharpe ratio from equity curve."""
        if len(equity_curve) < 2:
            return 0.0

        arr = np.array(equity_curve)
        returns = np.diff(arr) / arr[:-1]
        returns = returns[np.isfinite(returns)]

        if len(returns) == 0 or np.std(returns) == 0:
            return 0.0

        return float(np.mean(returns) / np.std(returns) * np.sqrt(365))

    def deployment_gate(self, wf_result: WalkForwardResult) -> dict:
        """Determine if a strategy passes the deployment gate.
        
        Returns:
            dict with "approved", "reason", and recommendation
        """
        if wf_result.n_windows < self.min_windows:
            return {
                "approved": False,
                "reason": f"Insufficient windows: {wf_result.n_windows} < {self.min_windows}",
                "recommendation": "Collect more data before deployment",
            }

        if wf_result.is_degraded:
            return {
                "approved": False,
                "reason": f"WF efficiency {wf_result.walk_forward_efficiency:.2f} below threshold {self.degradation_threshold}",
                "recommendation": "Strategy may be overfit; review parameters",
            }

        if wf_result.out_of_sample_sharpe < 0.5:
            return {
                "approved": False,
                "reason": f"OOS Sharpe {wf_result.out_of_sample_sharpe:.2f} too low",
                "recommendation": "Strategy not profitable enough for live deployment",
            }

        return {
            "approved": True,
            "reason": f"WF efficiency {wf_result.walk_forward_efficiency:.2f}, OOS Sharpe {wf_result.out_of_sample_sharpe:.2f}",
            "recommendation": "Proceed to paper trading phase",
        }