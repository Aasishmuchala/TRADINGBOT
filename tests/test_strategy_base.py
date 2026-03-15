"""Tests for strategy base and strategy runner."""
import pytest
from core.models import Signal, StrategySignal
from services.strategy_runner.base import StrategyBase


class MockStrategy(StrategyBase):
    name = "mock_strategy"
    regimes = ["trending"]
    timeframe = "15m"
    min_confidence = 0.5
    latency_budget_ms = 500
    paper_mode_days = 3

    def on_features(self, asset, features):
        if features.get("trigger"):
            return StrategySignal(
                strategy_name=self.name,
                asset=asset,
                signal=Signal.BUY,
                confidence=0.8,
                price=features.get("close", 100),
            )
        return None

    def on_fill(self, asset, fill_data):
        pass

    def health(self):
        return {"strategy": self.name}


def test_strategy_base_attributes():
    s = MockStrategy()
    assert s.name == "mock_strategy"
    assert "trending" in s.regimes
    assert s.timeframe == "15m"


def test_strategy_generates_signal():
    s = MockStrategy()
    result = s.on_features("BTC/USDT", {"trigger": True, "close": 50000})
    assert result is not None
    assert result.signal == Signal.BUY


def test_strategy_no_signal():
    s = MockStrategy()
    result = s.on_features("BTC/USDT", {"close": 50000})
    assert result is None
