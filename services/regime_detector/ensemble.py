import numpy as np
import pickle
import os
from typing import Optional
import lightgbm as lgb
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
import structlog

logger = structlog.get_logger()

REGIME_CLASSES = ["trending", "ranging", "high_vol", "low_vol"]

class RegimeEnsemble:
    """Ensemble of 3 models for regime classification."""
    
    def __init__(self):
        self.lgb_model: Optional[lgb.LGBMClassifier] = None
        self.rf_model: Optional[RandomForestClassifier] = None
        self.lr_model: Optional[LogisticRegression] = None
        self.scaler: Optional[StandardScaler] = None
        self.feature_names: list[str] = []
        self.version: str = "untrained"
        
        # Model weights (LightGBM gets more weight as it's typically best for tabular data)
        self.weights = [0.5, 0.3, 0.2]  # lgb, rf, lr
    
    def train(self, X: np.ndarray, y: np.ndarray, feature_names: list[str]):
        """Train all 3 models on the same data."""
        self.feature_names = feature_names
        self.scaler = StandardScaler()
        X_scaled = self.scaler.fit_transform(X)
        
        # LightGBM
        self.lgb_model = lgb.LGBMClassifier(
            n_estimators=200, max_depth=6, learning_rate=0.1,
            num_leaves=31, min_child_samples=20, random_state=42, verbose=-1
        )
        self.lgb_model.fit(X_scaled, y)
        
        # Random Forest
        self.rf_model = RandomForestClassifier(
            n_estimators=200, max_depth=8, min_samples_leaf=10, random_state=42
        )
        self.rf_model.fit(X_scaled, y)
        
        # Logistic Regression
        self.lr_model = LogisticRegression(
            max_iter=1000, multi_class="multinomial", random_state=42
        )
        self.lr_model.fit(X_scaled, y)
        
        logger.info("ensemble_trained", samples=len(y), features=len(feature_names))
    
    def predict(self, X: np.ndarray) -> dict:
        """
        Predict regime probabilities using weighted vote.
        Returns: {"regime": str, "confidence": float, "probabilities": dict, "model_agreement": float}
        """
        if self.scaler is None:
            raise RuntimeError("Model not trained. Call train() first.")
        
        X_scaled = self.scaler.transform(X.reshape(1, -1) if X.ndim == 1 else X)
        
        # Get probabilities from each model
        lgb_probs = self.lgb_model.predict_proba(X_scaled)[0]
        rf_probs = self.rf_model.predict_proba(X_scaled)[0]
        lr_probs = self.lr_model.predict_proba(X_scaled)[0]
        
        # Weighted average
        ensemble_probs = (
            self.weights[0] * lgb_probs +
            self.weights[1] * rf_probs +
            self.weights[2] * lr_probs
        )
        
        # Determine dominant regime
        regime_idx = np.argmax(ensemble_probs)
        confidence = float(ensemble_probs[regime_idx])
        
        # Model agreement: how many models agree on the dominant class
        individual_preds = [
            np.argmax(lgb_probs),
            np.argmax(rf_probs),
            np.argmax(lr_probs),
        ]
        agreement = sum(1 for p in individual_preds if p == regime_idx) / 3.0
        
        return {
            "regime": REGIME_CLASSES[regime_idx],
            "confidence": confidence,
            "probabilities": {cls: float(p) for cls, p in zip(REGIME_CLASSES, ensemble_probs)},
            "model_agreement": agreement,
        }
    
    def save(self, path: str):
        """Save ensemble to disk."""
        os.makedirs(os.path.dirname(path), exist_ok=True)
        data = {
            "lgb": self.lgb_model,
            "rf": self.rf_model,
            "lr": self.lr_model,
            "scaler": self.scaler,
            "feature_names": self.feature_names,
            "weights": self.weights,
            "version": self.version,
        }
        with open(path, "wb") as f:
            pickle.dump(data, f)
        logger.info("ensemble_saved", path=path)
    
    def load(self, path: str):
        """Load ensemble from disk."""
        with open(path, "rb") as f:
            data = pickle.load(f)
        self.lgb_model = data["lgb"]
        self.rf_model = data["rf"]
        self.lr_model = data["lr"]
        self.scaler = data["scaler"]
        self.feature_names = data["feature_names"]
        self.weights = data.get("weights", self.weights)
        self.version = data.get("version", "loaded")
        logger.info("ensemble_loaded", path=path, version=self.version)
