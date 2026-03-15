"""Tests for regime detector ensemble."""
import pytest
import numpy as np


def test_clustering_produces_4_regimes():
    from services.regime_detector.clustering import cluster_regimes
    np.random.seed(42)
    features = np.random.randn(200, 9)
    labels, label_map = cluster_regimes(features)
    assert labels is not None
    assert len(set(labels)) == 4
    assert all(r in label_map.values() for r in ["trending", "ranging", "high_vol", "low_vol"])


def test_ensemble_train_and_predict():
    from services.regime_detector.ensemble import RegimeEnsemble
    np.random.seed(42)
    X = np.random.randn(200, 9)
    y = np.random.randint(0, 4, 200)

    ensemble = RegimeEnsemble()
    metrics = ensemble.train(X, y)
    assert "accuracy" in metrics

    pred = ensemble.predict(X[0:1])
    assert pred is not None
    assert "regime" in pred
    assert "confidence" in pred


def test_psi_computation():
    from services.regime_detector.health_monitor import ModelHealthMonitor
    monitor = ModelHealthMonitor()
    np.random.seed(42)
    ref = np.random.randn(1000)
    same = np.random.randn(1000)
    shifted = np.random.randn(1000) + 3

    psi_same = monitor.compute_psi(ref, same)
    psi_shifted = monitor.compute_psi(ref, shifted)
    assert psi_same < psi_shifted
    assert monitor.psi_status(psi_same) == "green"
    assert monitor.psi_status(psi_shifted) == "red"
