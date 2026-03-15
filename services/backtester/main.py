"""Backtester Engine — Historical strategy validation with slippage modeling."""
import asyncio
import time
from typing import Optional
from dataclasses import dataclass, field

import numpy as np
import structlog

from config.settings import Settings
from core.heartbeat import HeartbeatMixin
from core.redis_client import RedisClient
from core.db import Database
from core.models import Signal

logger = structlog.get_logger()


@dataclass
class BacktestResult:
    strategy: str
    period_start: str
    period_end: str
    total_trades: int = 0
    winning_trades: int = 0
    losing_trades: int = 0
    total_pnl: float = 0.0
    max_drawdown: float = 0.0
    sharpe_ratio: float = 0.0
    win_rate: float = 0.0
    avg_win: float = 0.0
    avg_loss: float = 0.0
    profit_factor: float = 0.0
    max_consecutive_losses: int = 0
    equity_curve: list[float] = field(default_factory=list)


class BacktestEngine:
    """Runs historical backtests using stored OHLCV data and feature snapshots."""

    def __init__(self, db: Database, initial_capital: float = 10000):
        self.db = db
        self.initial_capital = initial_capital
        self.slippage_bps = 2.0  # Estimated slippage
        self.fee_bps = 1.0       # Estimated fees per side

    async def run_backtest(
        self,
        strategy_instance,
        asset: str,
        timeframe: str,
        days: int = 30,
    ) -> BacktestResult:
        """Run a backtest for a strategy on historical data."""
        # Fetch historical features
        rows = await self.db.fetch(
            """SELECT timestamp, features
               FROM feature_snapshots
               WHERE asset = $1 AND timeframe = $2
                 AND timestamp > NOW() - INTERVAL '%s days'
               ORDER BY timestamp ASC""",
            asset, timeframe, days,
        )

        if not rows:
            return BacktestResult(
                strategy=strategy_instance.name,
                period_start="", period_end="",
            )

        import json
        capital = self.initial_capital
        peak_capital = capital
        max_drawdown = 0.0
        trades = []
        equity_curve = [capital]
        position = None  # {"side": "long"/"short", "entry_price": float, "qty": float}
        consecutive_losses = 0
        max_consecutive_losses = 0

        for row in rows:
            feat_dict = json.loads(row["features"]) if isinstance(row["features"], str) else row["features"]
            price = float(feat_dict.get("close", 0))

            if price <= 0:
                continue

            # Get signal from strategy
            signal_result = strategy_instance.on_features(asset, feat_dict)

            if signal_result:
                signal = signal_result.signal

                # Close existing position if signal is opposite
                if position:
                    if (position["side"] == "long" and signal == Signal.SELL) or \
                       (position["side"] == "short" and signal == Signal.BUY):
                        # Close position
                        exit_price = price * (1 - self.slippage_bps / 10000)
                        if position["side"] == "long":
                            pnl = (exit_price - position["entry_price"]) * position["qty"]
                        else:
                            pnl = (position["entry_price"] - exit_price) * position["qty"]

                        # Deduct fees
                        fee = exit_price * position["qty"] * self.fee_bps / 10000
                        pnl -= fee

                        capital += pnl
                        trades.append(pnl)

                        if pnl <= 0:
                            consecutive_losses += 1
                            max_consecutive_losses = max(max_consecutive_losses, consecutive_losses)
                        else:
                            consecutive_losses = 0

                        position = None

                # Open new position
                if not position and signal in (Signal.BUY, Signal.SELL):
                    entry_price = price * (1 + self.slippage_bps / 10000)
                    qty = (capital * 0.05) / entry_price  # 5% of capital per trade
                    position = {
                        "side": "long" if signal == Signal.BUY else "short",
                        "entry_price": entry_price,
                        "qty": qty,
                    }

            equity_curve.append(capital)
            peak_capital = max(peak_capital, capital)
            drawdown = (peak_capital - capital) / peak_capital if peak_capital > 0 else 0
            max_drawdown = max(max_drawdown, drawdown)

        # Close any remaining position
        if position and rows:
            last_feat = json.loads(rows[-1]["features"]) if isinstance(rows[-1]["features"], str) else rows[-1]["features"]
            last_price = float(last_feat.get("close", 0))
            if last_price > 0:
                if position["side"] == "long":
                    pnl = (last_price - position["entry_price"]) * position["qty"]
                else:
                    pnl = (position["entry_price"] - last_price) * position["qty"]
                capital += pnl
                trades.append(pnl)

        # Compute metrics
        wins = [t for t in trades if t > 0]
        losses = [t for t in trades if t <= 0]
        total_pnl = sum(trades)
        win_rate = len(wins) / len(trades) if trades else 0

        # Sharpe ratio (annualized from daily returns)
        if len(equity_curve) > 1:
            returns = np.diff(equity_curve) / np.array(equity_curve[:-1])
            returns = returns[np.isfinite(returns)]
            if len(returns) > 0 and np.std(returns) > 0:
                sharpe = np.mean(returns) / np.std(returns) * np.sqrt(365)
            else:
                sharpe = 0.0
        else:
            sharpe = 0.0

        gross_profit = sum(wins) if wins else 0
        gross_loss = abs(sum(losses)) if losses else 1
        profit_factor = gross_profit / gross_loss if gross_loss > 0 else 0

        return BacktestResult(
            strategy=strategy_instance.name,
            period_start=str(rows[0]["timestamp"]) if rows else "",
            period_end=str(rows[-1]["timestamp"]) if rows else "",
            total_trades=len(trades),
            winning_trades=len(wins),
            losing_trades=len(losses),
            total_pnl=round(total_pnl, 2),
            max_drawdown=round(max_drawdown, 4),
            sharpe_ratio=round(float(sharpe), 2),
            win_rate=round(win_rate, 4),
            avg_win=round(np.mean(wins), 2) if wins else 0,
            avg_loss=round(np.mean(losses), 2) if losses else 0,
            profit_factor=round(profit_factor, 2),
            max_consecutive_losses=max_consecutive_losses,
            equity_curve=equity_curve[-100:],  # Last 100 points
        )


class BacktesterService(HeartbeatMixin):
    """Service wrapper for on-demand and scheduled backtesting."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.redis: Optional[RedisClient] = None
        self.db: Optional[Database] = None
        self.service_name = "backtester"
        self.engine: Optional[BacktestEngine] = None

    async def start(self):
        self.redis = RedisClient(self.settings.redis_url)
        await self.redis.connect()
        self.db = Database(self.settings.database_url)
        await self.db.connect()
        self.engine = BacktestEngine(self.db, self.settings.initial_capital)

        await self.redis.create_consumer_group("backtest_requests", "backtester_group")

        logger.info("backtester.started")
        await asyncio.gather(
            self._consume_requests(),
            self.run_heartbeat(self.redis),
        )

    async def _consume_requests(self):
        """Listen for backtest requests."""
        while True:
            try:
                messages = await self.redis.consume(
                    "backtest_requests", "backtester_group", self.service_name,
                    count=1, block_ms=5000,
                )
                for msg_id, data in messages:
                    await self._handle_request(msg_id, data)
            except Exception as e:
                logger.error("backtester.consume_error", error=str(e))
                await asyncio.sleep(5)

    async def _handle_request(self, msg_id: str, data: dict):
        """Handle a backtest request."""
        strategy_name = data.get("strategy", "")
        asset = data.get("asset", "BTC/USDT")
        timeframe = data.get("timeframe", "1h")
        days = int(data.get("days", 30))

        logger.info("backtester.running", strategy=strategy_name, asset=asset, days=days)

        # Load strategy (dynamic import)
        try:
            import importlib
            from pathlib import Path
            strategies_dir = Path("/app/strategies")
            # Find strategy module
            for py_file in strategies_dir.rglob("*.py"):
                if py_file.stem == "__init__":
                    continue
                module_name = f"strategies.{py_file.parent.name}.{py_file.stem}"
                mod = importlib.import_module(module_name)
                for attr_name in dir(mod):
                    attr = getattr(mod, attr_name)
                    if isinstance(attr, type) and hasattr(attr, "name"):
                        if getattr(attr, "name", None) == strategy_name:
                            instance = attr()
                            result = await self.engine.run_backtest(instance, asset, timeframe, days)

                            # Publish result
                            await self.redis.publish("backtest_results", {
                                "strategy": result.strategy,
                                "total_trades": result.total_trades,
                                "total_pnl": result.total_pnl,
                                "sharpe": result.sharpe_ratio,
                                "win_rate": result.win_rate,
                                "max_drawdown": result.max_drawdown,
                                "profit_factor": result.profit_factor,
                                "timestamp": time.time(),
                            })
                            logger.info("backtester.complete", strategy=strategy_name, pnl=result.total_pnl)
                            await self.redis.ack("backtest_requests", "backtester_group", msg_id)
                            return

            logger.warning("backtester.strategy_not_found", strategy=strategy_name)
        except Exception as e:
            logger.error("backtester.error", strategy=strategy_name, error=str(e))

        await self.redis.ack("backtest_requests", "backtester_group", msg_id)


async def main():
    settings = Settings()
    service = BacktesterService(settings)
    await service.start()


if __name__ == "__main__":
    asyncio.run(main())