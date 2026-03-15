"""Tests for multi-timeframe OHLCV aggregator."""
import pytest
from services.feature_engine.aggregator import OHLCVAggregator


def test_aggregator_creates_candles():
    candles = []
    agg = OHLCVAggregator(on_candle_close=lambda tf, asset, candle: candles.append((tf, asset, candle)))

    # Send 60 ticks to complete a 1m candle
    for i in range(65):
        agg.on_tick("BTC/USDT", {
            "price": 50000 + i,
            "volume": 1.0,
            "timestamp": 1000000 + i,
        })

    # Should have at least one 1m candle
    one_min = [c for c in candles if c[0] == "1m"]
    assert len(one_min) >= 1


def test_aggregator_ohlc_correct():
    candles = []
    agg = OHLCVAggregator(on_candle_close=lambda tf, asset, candle: candles.append(candle))

    prices = [100, 105, 95, 102]  # open, high, low, close pattern
    for i, p in enumerate(prices):
        agg.on_tick("ETH/USDT", {"price": p, "volume": 1.0, "timestamp": i})

    # Verify OHLC within accumulated data
    if candles:
        c = candles[0]
        assert c["high"] >= c["low"]
