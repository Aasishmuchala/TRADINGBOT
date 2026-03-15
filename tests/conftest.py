"""Shared test fixtures."""
import pytest
from unittest.mock import AsyncMock, MagicMock
from config.settings import Settings


@pytest.fixture
def settings():
    return Settings(
        redis_url="redis://localhost:6379/0",
        database_url="postgresql://test:test@localhost:5432/test",
        binance_api_key="test",
        binance_api_secret="test",
        bybit_api_key="",
        bybit_api_secret="",
        kucoin_api_key="",
        kucoin_api_secret="",
        kucoin_passphrase="",
        initial_capital=10000,
        max_leverage=2.0,
        daily_drawdown_limit=0.03,
        portfolio_heat_limit=0.30,
        kelly_fraction=0.5,
        per_asset_limit=0.15,
        paper_mode=True,
    )


@pytest.fixture
def mock_redis():
    redis = AsyncMock()
    redis.connect = AsyncMock()
    redis.publish = AsyncMock()
    redis.consume = AsyncMock(return_value=[])
    redis.ack = AsyncMock()
    redis.create_consumer_group = AsyncMock()
    redis.get_features = AsyncMock(return_value={})
    redis.get_latency = AsyncMock(return_value=50.0)
    redis.get_correlation = AsyncMock(return_value=0.1)
    redis.cache_latency = AsyncMock()
    redis.cache_correlation = AsyncMock()
    redis.check_heartbeat = AsyncMock(return_value=None)
    redis.redis = AsyncMock()
    return redis


@pytest.fixture
def mock_db():
    db = AsyncMock()
    db.connect = AsyncMock()
    db.execute = AsyncMock()
    db.fetch = AsyncMock(return_value=[])
    db.fetchrow = AsyncMock(return_value=None)
    db.fetchval = AsyncMock(return_value=None)
    return db
