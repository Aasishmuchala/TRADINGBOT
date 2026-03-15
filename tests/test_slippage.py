"""Tests for slippage model."""
import pytest
from services.execution_engine.slippage import SlippageModel


@pytest.fixture
def model():
    return SlippageModel()


def test_estimate_basic(model):
    est = model.estimate(order_size_usd=1000, realized_vol=0.02, spread_bps=2.0)
    assert est.expected_bps >= 0
    assert est.worst_case_bps > est.expected_bps
    assert est.confidence == 0.3  # Default coefficients


def test_estimate_larger_order_higher_slippage(model):
    small = model.estimate(order_size_usd=100, realized_vol=0.02, spread_bps=2.0)
    large = model.estimate(order_size_usd=10000, realized_vol=0.02, spread_bps=2.0)
    assert large.expected_bps > small.expected_bps


def test_estimate_higher_vol_higher_slippage(model):
    low_vol = model.estimate(order_size_usd=1000, realized_vol=0.01, spread_bps=2.0)
    high_vol = model.estimate(order_size_usd=1000, realized_vol=0.05, spread_bps=2.0)
    assert high_vol.expected_bps > low_vol.expected_bps


def test_record_and_refit(model):
    for i in range(100):
        model.record_fill(
            order_size_usd=1000 + i * 10,
            realized_vol=0.02,
            spread_bps=2.0,
            actual_slippage_bps=2.0 + i * 0.01,
        )
    success = model.refit()
    assert success
    assert model.coefficients.version == 2
    assert model.coefficients.n_samples == 100


def test_refit_insufficient_data(model):
    model.record_fill(order_size_usd=1000, realized_vol=0.02, spread_bps=2.0, actual_slippage_bps=3.0)
    success = model.refit()
    assert not success
