import numpy as np
import time
import structlog
from typing import Optional
from collections import deque

logger = structlog.get_logger()

class ModelHealthMonitor:
    """Monitors model health: PSI, confidence trending, performance degradation."""
    
    def __init__(self):
        self._training_distributions: dict[str, np.ndarray] = {}
        self._confidence_history: deque = deque(maxlen=1440)  # 24h at 1/min
        self._last_psi_check = 0.0
        self._psi_interval = 6 * 3600  # 6 hours
        self._consecutive_declining_days = 0
        self._daily_confidences: list[float] = []
    
    def set_training_distribution(self, feature_name: str, values: np.ndarray, bins: int = 20):
        """Store training distribution for PSI comparison."""
        hist, bin_edges = np.histogram(values, bins=bins, density=True)
        self._training_distributions[feature_name] = {
            "hist": hist,
            "bin_edges": bin_edges,
        }
    
    def compute_psi(self, feature_name: str, live_values: np.ndarray) -> Optional[float]:
        """Compute Population Stability Index between training and live distributions."""
        if feature_name not in self._training_distributions:
            return None
        
        train = self._training_distributions[feature_name]
        live_hist, _ = np.histogram(live_values, bins=train["bin_edges"], density=True)
        
        # Add small epsilon to avoid log(0)
        eps = 1e-6
        train_hist = train["hist"] + eps
        live_hist = live_hist + eps
        
        # Normalize
        train_hist = train_hist / train_hist.sum()
        live_hist = live_hist / live_hist.sum()
        
        psi = np.sum((live_hist - train_hist) * np.log(live_hist / train_hist))
        return float(psi)
    
    def check_all_psi(self, live_features: dict[str, np.ndarray]) -> dict:
        """
        Check PSI for all features. Returns status and actions.
        PSI < 0.10 -> stable
        PSI 0.10-0.25 -> yellow (reduce positions 30%)
        PSI > 0.25 -> red (pause entries, emergency retrain)
        """
        now = time.time()
        if now - self._last_psi_check < self._psi_interval:
            return {"status": "skipped", "reason": "too_soon"}
        
        self._last_psi_check = now
        results = {}
        max_psi = 0.0
        
        for name, values in live_features.items():
            psi = self.compute_psi(name, values)
            if psi is not None:
                results[name] = psi
                max_psi = max(max_psi, psi)
        
        if max_psi > 0.25:
            status = "red"
            action = "pause_entries_emergency_retrain"
        elif max_psi > 0.10:
            status = "yellow"
            action = "reduce_positions_30pct"
        else:
            status = "green"
            action = "none"
        
        logger.info("psi_check", status=status, max_psi=f"{max_psi:.4f}", action=action)
        return {"status": status, "action": action, "max_psi": max_psi, "feature_psi": results}
    
    def record_confidence(self, confidence: float):
        """Record a confidence score for trending analysis."""
        self._confidence_history.append((time.time(), confidence))
    
    def is_confidence_declining(self) -> bool:
        """Check if confidence has been trending down for 3+ days."""
        if len(self._confidence_history) < 100:
            return False
        
        confidences = [c for _, c in self._confidence_history]
        
        # Compare rolling averages: last 8h vs previous 8h vs before that
        third = len(confidences) // 3
        if third < 10:
            return False
        
        avg_old = np.mean(confidences[:third])
        avg_mid = np.mean(confidences[third:2*third])
        avg_recent = np.mean(confidences[2*third:])
        
        declining = avg_recent < avg_mid < avg_old
        if declining:
            logger.warning("confidence_declining", old=f"{avg_old:.3f}", mid=f"{avg_mid:.3f}", recent=f"{avg_recent:.3f}")
        
        return declining
