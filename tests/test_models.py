"""Tests for core data models."""
import pytest
from core.models import (
    Regime, RegimeSignal, Signal, StrategySignal, FeatureSnapshot,
    OrderSide, Order, Position, StrategyHealth, DegradationTier,
)


def test_regime_enum():
    assert Regime.TRENDING.value == "trending"
    assert Regime.RANGING.value == "ranging"
    assert Regime.HIGH_VOL.value == "high_vol"
    assert Regime.LOW_VOL.value == "low_vol"


def test_signal_enum():
    assert Signal.BUY.value == "buy"
    assert Signal.SELL.value == "sell"
    assert Signal.HOLD.value == "hold"


def test_strategy_signal_creation():
    sig = StrategySignal(
        strategy_name="test",
        asset="BTC/USDT",
        signal=Signal.BUY,
        confidence=0.8,
        price=50000.0,
    )
    assert sig.strategy_name == "test"
    assert sig.signal == Signal.BUY
    assert sig.confidence == 0.8


def test_order_has_uuid():
    order = Order(
        asset="BTC/USDT",
        side=OrderSide.BUY,
        quantity=0.1,
        price=50000.0,
        strategy="test",
    )
    assert order.order_id is not None
    assert order.asset == "BTC/USDT"


def test_degradation_tiers():
    assert DegradationTier.FULL.value == "full"
    assert DegradationTier.EMERGENCY.value == "emergency"
