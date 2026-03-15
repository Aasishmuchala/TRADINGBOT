"""Tests for technical indicator calculations."""
import pytest
from services.feature_engine.indicators import (
    compute_ema, compute_sma, compute_rsi, compute_atr,
    compute_bollinger_bands, compute_macd, compute_adx,
)


def test_ema_basic():
    prices = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]
    result = compute_ema(prices, period=5)
    assert result is not None
    assert result > 15  # Should be weighted toward recent prices


def test_sma_basic():
    prices = [10, 20, 30, 40, 50]
    result = compute_sma(prices, period=5)
    assert result == 30.0


def test_rsi_overbought():
    # Strongly rising prices
    prices = list(range(50, 70))
    result = compute_rsi(prices, period=14)
    assert result is not None
    assert result > 60


def test_rsi_oversold():
    # Strongly falling prices
    prices = list(range(70, 50, -1))
    result = compute_rsi(prices, period=14)
    assert result is not None
    assert result < 40


def test_atr_positive():
    highs = [105, 107, 106, 108, 110]
    lows = [100, 101, 99, 102, 104]
    closes = [103, 105, 104, 106, 108]
    result = compute_atr(highs, lows, closes, period=3)
    assert result is not None
    assert result > 0


def test_bollinger_bands():
    prices = list(range(90, 110))
    upper, mid, lower = compute_bollinger_bands(prices, period=10, std_dev=2)
    assert upper > mid > lower


def test_macd():
    prices = list(range(50, 80))
    macd_line, signal_line, histogram = compute_macd(prices)
    assert macd_line is not None
