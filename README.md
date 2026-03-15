# Autonomous Crypto Trading Bot

Self-learning crypto trading system with ML regime detection, 40+ strategies, and a Bloomberg-style real-time dashboard.

## Architecture

Event-driven pipeline with Redis Streams connecting 17 Docker services:

```
Data Ingestion → Feature Engine → Regime Detector → Strategy Selector
                                                          ↓
              Dashboard ← Trade Ledger ← Execution ← Risk Layer ← Strategy Runner
```

### Services

| Service | Purpose |
|---------|---------|
| data_ingestion | WebSocket/REST feeds from Binance, Bybit, KuCoin |
| feature_engine | Technical indicators + multi-timeframe aggregation |
| regime_detector | LightGBM + RF + LR ensemble for market regime classification |
| strategy_selector | Capital weight allocation based on regime × strategy health |
| strategy_runner | Hot-reloads strategy modules, routes features, emits signals |
| risk_layer | 7-check validation gate (drawdown, heat, leverage, correlation, Kelly, latency) |
| execution_engine | Smart order routing across 3 exchanges with slippage modeling |
| trade_ledger | P&L tracking with TimescaleDB persistence |
| correlation_engine | 60s rolling pairwise correlations |
| watchdog | Dead man's switch + 4-tier graceful degradation |
| latency_monitor | Per-exchange RTT tracking |
| retrainer | Scheduled model retraining with PSI drift detection |
| backtester | Historical strategy validation with walk-forward |
| dashboard_api | FastAPI backend with WebSocket streaming |
| dashboard_ui | React dashboard with real-time panels |

### Market Regimes

The ML ensemble classifies markets into 4 regimes every 30 seconds:

- **Trending**: Strong directional moves (ADX > 25)
- **Ranging**: Sideways consolidation
- **High Volatility**: Explosive price action
- **Low Volatility**: Quiet accumulation/distribution

### Strategies (40+)

**Trending** (9): EMA Crossover, Momentum Burst, VWAP Breakout, MACD Trend, ADX Strength, Supertrend, Trend Pullback, Breakout Retest, Ichimoku Cloud

**Ranging** (8): Bollinger Reversion, Z-Score Reversion, RSI Extremes, Range Scalper, Stochastic RSI, Keltner Channel, OB Imbalance Fade, Pivot Points

**High Vol** (7): Volatility Breakout, Cross-Exchange Arb, Squeeze Detector, Gap Filler, Vol Mean Reversion, Liquidation Hunter, Panic Reversal

**Low Vol** (5): Funding Harvest, Grid Trading, Mean Reversion Slow, Spread Collector, DCA Accumulator

**Always On** (4): Cross-Exchange Spread, Triangular Arb, Volume Profile, Multi-TF Confluence

## Quick Start

```bash
# 1. Copy and configure environment
cp .env.example .env
# Edit .env with your exchange API keys

# 2. Start infrastructure
docker-compose up -d redis timescaledb

# 3. Run migrations
docker-compose exec timescaledb psql -U trader -d trading -f /migrations/001_initial_schema.sql

# 4. Start all services
docker-compose up -d

# 5. Open dashboard
open http://localhost:3000
```

## Risk Management

- Daily drawdown kill-switch: -3%
- Portfolio heat limit: 30%
- Per-asset concentration: 15%
- Max leverage: 2x
- Correlation threshold: 0.85
- Kelly cap: 10% per position
- Dead man's switch: 15s heartbeat timeout

## Configuration

All settings via environment variables (see `.env.example`):

- `PAPER_MODE=true` — Start in paper trading mode (recommended)
- `INITIAL_CAPITAL=10000` — Starting capital
- `MAX_LEVERAGE=2.0` — Maximum leverage multiplier
- `DAILY_DRAWDOWN_LIMIT=0.03` — Daily loss limit (3%)

## Testing

```bash
pip install -r requirements.txt
pytest tests/ -v --cov
```
