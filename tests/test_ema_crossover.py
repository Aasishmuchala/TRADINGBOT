"""Tests for EMA Crossover strategy."""
import pytest
from strategies.trending.ema_crossover import EMACrossover
from core.models import Signal


def test_bullish_crossover():
    s = EMACrossover()
    # Prime with previous values (fast below slow)
    s.on_features("BTC/USDT", {"ema_9": 99, "ema_21": 100, "adx": 30, "close": 99})
    # Crossover: fast above slow
    result = s.on_features("BTC/USDT", {"ema_9": 101, "ema_21": 100, "adx": 30, "close": 101})
    assert result is not None
    assert result.signal == Signal.BUY


def test_bearish_crossover():
    s = EMACrossover()
    s.on_features("BTC/USDT", {"ema_9": 101, "ema_21": 100, "adx": 30, "close": 101})
    result = s.on_features("BTC/USDT", {"ema_9": 99, "ema_21": 100, "adx": 30, "close": 99})
    assert result is not None
    assert result.signal == Signal.SELL


def test_no_signal_low_adx():
    s = EMACrossover()
    s.on_features("BTC/USDT", {"ema_9": 99, "ema_21": 100, "adx": 15, "close": 99})
    result = s.on_features("BTC/USDT", {"ema_9": 101, "ema_21": 100, "adx": 15, "close": 101})
    assert result is None  # ADX too low


def test_no_signal_without_crossover():
    s = EMACrossover()
    s.on_features("BTC/USDT", {"ema_9": 101, "ema_21": 100, "adx": 30, "close": 101})
    result = s.on_features("BTC/USDT", {"ema_9": 102, "ema_21": 100, "adx": 30, "close": 102})
    assert result is None  # No crossover
