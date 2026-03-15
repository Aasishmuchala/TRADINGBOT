"""Tests for risk layer checks."""
import pytest
from unittest.mock import AsyncMock
from services.risk_layer.main import RiskLayerService, RiskCheck


@pytest.fixture
def risk_service(settings, mock_redis):
    service = RiskLayerService(settings)
    service.redis = mock_redis
    return service


def test_daily_drawdown_pass(risk_service):
    risk_service.daily_pnl = -100  # -1% of 10k
    check = risk_service._check_daily_drawdown()
    assert check.passed


def test_daily_drawdown_fail(risk_service):
    risk_service.daily_pnl = -400  # -4% of 10k, exceeds 3% limit
    check = risk_service._check_daily_drawdown()
    assert not check.passed


def test_portfolio_heat_pass(risk_service):
    risk_service.total_exposure = 2000  # 20% of 10k
    check = risk_service._check_portfolio_heat()
    assert check.passed


def test_portfolio_heat_fail(risk_service):
    risk_service.total_exposure = 4000  # 40% of 10k
    check = risk_service._check_portfolio_heat()
    assert not check.passed


def test_per_asset_limit_pass(risk_service):
    risk_service.open_positions = {"BTC/USDT": 1000}
    check = risk_service._check_per_asset_limit("BTC/USDT")
    assert check.passed


def test_per_asset_limit_fail(risk_service):
    risk_service.open_positions = {"BTC/USDT": 2000}
    check = risk_service._check_per_asset_limit("BTC/USDT")
    assert not check.passed


def test_leverage_check_pass(risk_service):
    risk_service.current_leverage = 1.5
    check = risk_service._check_leverage()
    assert check.passed


def test_leverage_check_fail(risk_service):
    risk_service.current_leverage = 2.5
    check = risk_service._check_leverage()
    assert not check.passed
