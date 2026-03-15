"""Tests for Kelly Criterion calculator."""
import pytest
from services.risk_layer.kelly import KellyCalculator, KellyResult


@pytest.fixture
def kelly():
    return KellyCalculator(kelly_fraction=0.5, max_kelly_bet=0.10, max_leverage=2.0)


def test_basic_kelly(kelly):
    result = kelly.compute(win_rate=0.6, avg_win=0.02, avg_loss=0.01, capital=10000)
    assert result.raw_fraction > 0
    assert result.adjusted_fraction > 0
    assert result.position_size_usd > 0
    assert result.position_size_usd <= 1000  # 10% cap of 10k


def test_kelly_negative_edge(kelly):
    result = kelly.compute(win_rate=0.3, avg_win=0.01, avg_loss=0.02, capital=10000)
    assert result.adjusted_fraction == 0
    assert result.position_size_usd == 0


def test_kelly_zero_inputs(kelly):
    result = kelly.compute(win_rate=0, avg_win=0, avg_loss=0, capital=10000)
    assert result.position_size_usd == 0


def test_kelly_regime_confidence_scaling(kelly):
    high_conf = kelly.compute(win_rate=0.6, avg_win=0.02, avg_loss=0.01,
                              capital=10000, regime_confidence=1.0)
    low_conf = kelly.compute(win_rate=0.6, avg_win=0.02, avg_loss=0.01,
                             capital=10000, regime_confidence=0.5)
    assert high_conf.position_size_usd > low_conf.position_size_usd


def test_kelly_leverage_dampening(kelly):
    no_leverage = kelly.compute(win_rate=0.6, avg_win=0.02, avg_loss=0.01,
                                capital=10000, current_leverage=0.0)
    high_leverage = kelly.compute(win_rate=0.6, avg_win=0.02, avg_loss=0.01,
                                  capital=10000, current_leverage=1.5)
    assert no_leverage.position_size_usd > high_leverage.position_size_usd


def test_kelly_cap(kelly):
    result = kelly.compute(win_rate=0.9, avg_win=0.10, avg_loss=0.01, capital=10000)
    assert result.adjusted_fraction <= 0.10
    assert result.capped


def test_kelly_from_trades(kelly):
    result = kelly.compute_from_trades(
        wins=60, losses=40, total_profit=1.2, total_loss=0.4,
        capital=10000,
    )
    assert result.position_size_usd > 0
