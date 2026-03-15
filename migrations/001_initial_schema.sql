-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- OHLCV candles (1m base, other timeframes derived)
CREATE TABLE IF NOT EXISTS ohlcv (
    time        TIMESTAMPTZ NOT NULL,
    asset       TEXT NOT NULL,
    exchange    TEXT NOT NULL,
    timeframe   TEXT NOT NULL DEFAULT '1m',
    open        DOUBLE PRECISION NOT NULL,
    high        DOUBLE PRECISION NOT NULL,
    low         DOUBLE PRECISION NOT NULL,
    close       DOUBLE PRECISION NOT NULL,
    volume      DOUBLE PRECISION NOT NULL
);
SELECT create_hypertable('ohlcv', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_ohlcv_asset_tf ON ohlcv (asset, timeframe, time DESC);

-- Order book snapshots (every 5s, last 90 days)
CREATE TABLE IF NOT EXISTS order_book_snapshots (
    time        TIMESTAMPTZ NOT NULL,
    asset       TEXT NOT NULL,
    exchange    TEXT NOT NULL,
    bids        JSONB NOT NULL,
    asks        JSONB NOT NULL,
    spread_bps  DOUBLE PRECISION
);
SELECT create_hypertable('order_book_snapshots', 'time', if_not_exists => TRUE);

-- Trade fills
CREATE TABLE IF NOT EXISTS fills (
    time            TIMESTAMPTZ NOT NULL,
    order_id        TEXT NOT NULL,
    asset           TEXT NOT NULL,
    side            TEXT NOT NULL,
    size            DOUBLE PRECISION NOT NULL,
    fill_price      DOUBLE PRECISION NOT NULL,
    fee             DOUBLE PRECISION NOT NULL,
    exchange        TEXT NOT NULL,
    strategy_name   TEXT NOT NULL,
    slippage        DOUBLE PRECISION,
    latency_ms      DOUBLE PRECISION,
    regime_at_entry TEXT
);
SELECT create_hypertable('fills', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_fills_strategy ON fills (strategy_name, time DESC);

-- Portfolio snapshots (every minute)
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    time            TIMESTAMPTZ NOT NULL,
    total_value     DOUBLE PRECISION NOT NULL,
    cash            DOUBLE PRECISION NOT NULL,
    positions_value DOUBLE PRECISION NOT NULL,
    daily_pnl       DOUBLE PRECISION NOT NULL,
    total_return    DOUBLE PRECISION NOT NULL,
    leverage        DOUBLE PRECISION NOT NULL,
    regime          TEXT,
    regime_confidence DOUBLE PRECISION
);
SELECT create_hypertable('portfolio_snapshots', 'time', if_not_exists => TRUE);

-- Strategy performance tracking
CREATE TABLE IF NOT EXISTS strategy_performance (
    time            TIMESTAMPTZ NOT NULL,
    strategy_name   TEXT NOT NULL,
    sharpe_7d       DOUBLE PRECISION,
    sharpe_30d      DOUBLE PRECISION,
    win_rate        DOUBLE PRECISION,
    total_trades    INTEGER,
    capital_weight  DOUBLE PRECISION,
    is_enabled      BOOLEAN DEFAULT TRUE,
    is_paper        BOOLEAN DEFAULT FALSE
);
SELECT create_hypertable('strategy_performance', 'time', if_not_exists => TRUE);

-- Model versions registry
CREATE TABLE IF NOT EXISTS model_registry (
    id              SERIAL PRIMARY KEY,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    model_type      TEXT NOT NULL,
    version         TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    sharpe_backtest DOUBLE PRECISION,
    sharpe_shadow   DOUBLE PRECISION,
    is_live         BOOLEAN DEFAULT FALSE,
    is_shadow       BOOLEAN DEFAULT FALSE,
    metadata        JSONB
);

-- Slippage model versions
CREATE TABLE IF NOT EXISTS slippage_model_versions (
    id              SERIAL PRIMARY KEY,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    exchange        TEXT NOT NULL,
    asset           TEXT NOT NULL,
    alpha           DOUBLE PRECISION NOT NULL,
    beta            DOUBLE PRECISION NOT NULL,
    gamma           DOUBLE PRECISION NOT NULL,
    is_active       BOOLEAN DEFAULT TRUE,
    validation_notes TEXT
);

-- Alerts log
CREATE TABLE IF NOT EXISTS alerts (
    time        TIMESTAMPTZ NOT NULL,
    alert_type  TEXT NOT NULL,
    severity    TEXT NOT NULL,
    message     TEXT NOT NULL,
    metadata    JSONB
);
SELECT create_hypertable('alerts', 'time', if_not_exists => TRUE);

-- Retention policies (automatic data lifecycle)
SELECT add_retention_policy('order_book_snapshots', INTERVAL '90 days', if_not_exists => TRUE);
SELECT add_retention_policy('ohlcv', INTERVAL '400 days', if_not_exists => TRUE);
