"""Risk Layer Service — 7-check validation gate for all trading signals."""
import asyncio
import json
import time
from typing import Optional

import structlog

from config.settings import Settings
from core.heartbeat import HeartbeatMixin
from core.models import StrategySignal, Signal, Order, OrderSide
from core.redis_client import RedisClient
from services.risk_layer.kelly import KellyCalculator, KellyResult

logger = structlog.get_logger()


class RiskCheck:
    """Result of a single risk check."""
    def __init__(self, name: str, passed: bool, reason: str = ""):
        self.name = name
        self.passed = passed
        self.reason = reason


class RiskLayerService(HeartbeatMixin):
    """Validates every signal against 7 risk constraints before forwarding to execution."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.redis: Optional[RedisClient] = None
        self.kelly = KellyCalculator(
            kelly_fraction=settings.kelly_fraction,
            max_kelly_bet=0.10,
            max_leverage=settings.max_leverage,
        )
        self.service_name = "risk_layer"

        # Risk parameters from settings
        self.daily_drawdown_limit = settings.daily_drawdown_limit  # 0.03 = 3%
        self.portfolio_heat_limit = settings.portfolio_heat_limit  # 0.30 = 30%
        self.per_asset_limit = settings.per_asset_limit            # 0.15 = 15%
        self.max_leverage = settings.max_leverage                  # 2.0
        self.correlation_threshold = 0.85
        self.initial_capital = settings.initial_capital

        # Tracking state
        self.daily_pnl = 0.0
        self.daily_pnl_reset_date = None
        self.open_positions: dict[str, float] = {}  # asset -> exposure_usd
        self.total_exposure = 0.0
        self.current_leverage = 1.0

    async def start(self):
        self.redis = RedisClient(self.settings.redis_url)
        await self.redis.connect()

        # Create consumer group
        await self.redis.create_consumer_group("strategy_signals", "risk_layer_group")

        logger.info("risk_layer.started")
        await asyncio.gather(
            self._consume_signals(),
            self._consume_fills(),
            self._track_daily_pnl(),
            self.run_heartbeat(self.redis),
        )

    async def _consume_signals(self):
        """Main loop: consume strategy signals and validate."""
        while True:
            try:
                messages = await self.redis.consume(
                    "strategy_signals", "risk_layer_group", self.service_name,
                    count=10, block_ms=1000,
                )
                for msg_id, data in messages:
                    await self._process_signal(msg_id, data)
            except Exception as e:
                logger.error("risk_layer.consume_error", error=str(e))
                await asyncio.sleep(1)

    async def _process_signal(self, msg_id: str, data: dict):
        """Run all 7 risk checks on a signal."""
        try:
            signal = StrategySignal(**data)
        except Exception as e:
            logger.warning("risk_layer.invalid_signal", error=str(e))
            await self.redis.ack("strategy_signals", "risk_layer_group", msg_id)
            return

        checks = await self._run_all_checks(signal)
        failed = [c for c in checks if not c.passed]

        if failed:
            reasons = "; ".join(f"{c.name}: {c.reason}" for c in failed)
            logger.warning(
                "risk_layer.signal_rejected",
                strategy=signal.strategy_name,
                asset=signal.asset,
                signal=signal.signal.value,
                reasons=reasons,
            )
            await self.redis.publish("rejected_signals", {
                "strategy": signal.strategy_name,
                "asset": signal.asset,
                "signal": signal.signal.value,
                "reasons": reasons,
                "timestamp": time.time(),
            })
        else:
            # Compute position size via Kelly
            kelly_result = self._compute_position_size(signal)
            
            # Forward approved signal to execution engine
            order_side = OrderSide.BUY if signal.signal == Signal.BUY else OrderSide.SELL
            order = Order(
                asset=signal.asset,
                side=order_side,
                quantity=kelly_result.position_size_usd / signal.price if signal.price > 0 else 0,
                price=signal.price,
                strategy=signal.strategy_name,
            )
            await self.redis.publish("approved_orders", {
                "order_id": str(order.order_id),
                "asset": order.asset,
                "side": order.side.value,
                "quantity": order.quantity,
                "price": order.price,
                "strategy": order.strategy,
                "kelly_fraction": kelly_result.adjusted_fraction,
                "position_size_usd": kelly_result.position_size_usd,
                "timestamp": time.time(),
            })
            logger.info(
                "risk_layer.signal_approved",
                strategy=signal.strategy_name,
                asset=signal.asset,
                signal=signal.signal.value,
                position_usd=kelly_result.position_size_usd,
            )

        await self.redis.ack("strategy_signals", "risk_layer_group", msg_id)

    async def _run_all_checks(self, signal: StrategySignal) -> list[RiskCheck]:
        """Execute all 7 risk checks."""
        checks = []

        # 1. Daily drawdown kill-switch
        checks.append(self._check_daily_drawdown())

        # 2. Portfolio heat
        checks.append(self._check_portfolio_heat())

        # 3. Per-asset concentration
        checks.append(self._check_per_asset_limit(signal.asset))

        # 4. Leverage cap
        checks.append(self._check_leverage())

        # 5. Correlation check
        checks.append(await self._check_correlation(signal.asset))

        # 6. Kelly cap (position sizing sanity)
        checks.append(self._check_kelly_cap(signal))

        # 7. Latency budget
        checks.append(await self._check_latency(signal))

        return checks

    def _check_daily_drawdown(self) -> RiskCheck:
        """Check 1: Daily drawdown kill-switch at -3%."""
        drawdown_pct = abs(self.daily_pnl) / self.initial_capital if self.daily_pnl < 0 else 0
        if drawdown_pct >= self.daily_drawdown_limit:
            return RiskCheck(
                "daily_drawdown", False,
                f"Daily loss {drawdown_pct:.1%} >= limit {self.daily_drawdown_limit:.1%}"
            )
        return RiskCheck("daily_drawdown", True)

    def _check_portfolio_heat(self) -> RiskCheck:
        """Check 2: Total portfolio exposure limit."""
        heat = self.total_exposure / self.initial_capital if self.initial_capital > 0 else 0
        if heat >= self.portfolio_heat_limit:
            return RiskCheck(
                "portfolio_heat", False,
                f"Portfolio heat {heat:.1%} >= limit {self.portfolio_heat_limit:.1%}"
            )
        return RiskCheck("portfolio_heat", True)

    def _check_per_asset_limit(self, asset: str) -> RiskCheck:
        """Check 3: Per-asset concentration limit."""
        asset_exposure = self.open_positions.get(asset, 0)
        concentration = asset_exposure / self.initial_capital if self.initial_capital > 0 else 0
        if concentration >= self.per_asset_limit:
            return RiskCheck(
                "per_asset", False,
                f"{asset} concentration {concentration:.1%} >= limit {self.per_asset_limit:.1%}"
            )
        return RiskCheck("per_asset", True)

    def _check_leverage(self) -> RiskCheck:
        """Check 4: Leverage cap."""
        if self.current_leverage >= self.max_leverage:
            return RiskCheck(
                "leverage", False,
                f"Leverage {self.current_leverage:.1f}x >= limit {self.max_leverage:.1f}x"
            )
        return RiskCheck("leverage", True)

    async def _check_correlation(self, asset: str) -> RiskCheck:
        """Check 5: Reject if new position highly correlated with existing."""
        if not self.redis or not self.open_positions:
            return RiskCheck("correlation", True)

        for existing_asset in self.open_positions:
            if existing_asset == asset:
                continue
            pair_key = tuple(sorted([asset, existing_asset]))
            corr = await self.redis.get_correlation(pair_key[0], pair_key[1])
            if corr is not None and abs(corr) > self.correlation_threshold:
                return RiskCheck(
                    "correlation", False,
                    f"{asset} corr with {existing_asset} = {corr:.2f} > {self.correlation_threshold}"
                )
        return RiskCheck("correlation", True)

    def _check_kelly_cap(self, signal: StrategySignal) -> RiskCheck:
        """Check 6: Kelly criterion sanity check."""
        # This is a pre-check; actual sizing happens after approval
        # Reject if strategy has no historical win data
        if signal.confidence <= 0:
            return RiskCheck(
                "kelly_cap", False,
                f"Signal confidence {signal.confidence} <= 0"
            )
        return RiskCheck("kelly_cap", True)

    async def _check_latency(self, signal: StrategySignal) -> RiskCheck:
        """Check 7: Exchange latency within strategy's budget."""
        if not self.redis:
            return RiskCheck("latency", True)

        # Get exchange for this asset (default binance)
        exchange = "binance"
        latency = await self.redis.get_latency(exchange)

        if latency is None:
            # No latency data; allow but warn
            logger.warning("risk_layer.no_latency_data", exchange=exchange)
            return RiskCheck("latency", True)

        budget_ms = getattr(signal, "latency_budget_ms", 500)
        if latency > budget_ms:
            return RiskCheck(
                "latency", False,
                f"{exchange} latency {latency}ms > budget {budget_ms}ms"
            )
        return RiskCheck("latency", True)

    def _compute_position_size(self, signal: StrategySignal) -> KellyResult:
        """Compute position size using Kelly criterion."""
        return self.kelly.compute(
            win_rate=max(0.01, min(0.99, signal.confidence)),
            avg_win=0.02,   # Default 2% avg win (overridden by strategy health data)
            avg_loss=0.01,  # Default 1% avg loss
            capital=self.initial_capital,
            regime_confidence=signal.confidence,
            current_leverage=self.current_leverage,
        )

    async def _consume_fills(self):
        """Track fills to update position state."""
        await self.redis.create_consumer_group("fill_reports", "risk_fills_group")
        while True:
            try:
                messages = await self.redis.consume(
                    "fill_reports", "risk_fills_group", self.service_name,
                    count=10, block_ms=2000,
                )
                for msg_id, data in messages:
                    self._update_positions(data)
                    await self.redis.ack("fill_reports", "risk_fills_group", msg_id)
            except Exception as e:
                logger.error("risk_layer.fills_error", error=str(e))
                await asyncio.sleep(1)

    def _update_positions(self, fill_data: dict):
        """Update internal position tracking from fill reports."""
        asset = fill_data.get("asset", "")
        side = fill_data.get("side", "")
        fill_qty = float(fill_data.get("filled_qty", 0))
        fill_price = float(fill_data.get("fill_price", 0))
        notional = fill_qty * fill_price

        if side == "buy":
            self.open_positions[asset] = self.open_positions.get(asset, 0) + notional
        elif side == "sell":
            self.open_positions[asset] = self.open_positions.get(asset, 0) - notional
            if self.open_positions.get(asset, 0) <= 0:
                self.open_positions.pop(asset, None)

        self.total_exposure = sum(abs(v) for v in self.open_positions.values())
        self.current_leverage = self.total_exposure / self.initial_capital if self.initial_capital > 0 else 0

        # Track P&L from fills
        pnl = float(fill_data.get("realized_pnl", 0))
        self.daily_pnl += pnl

    async def _track_daily_pnl(self):
        """Reset daily P&L at midnight UTC."""
        import datetime
        while True:
            now = datetime.datetime.utcnow().date()
            if self.daily_pnl_reset_date != now:
                if self.daily_pnl_reset_date is not None:
                    logger.info("risk_layer.daily_pnl_reset", previous_pnl=self.daily_pnl)
                self.daily_pnl = 0.0
                self.daily_pnl_reset_date = now
            await asyncio.sleep(60)


async def main():
    settings = Settings()
    service = RiskLayerService(settings)
    await service.start()


if __name__ == "__main__":
    asyncio.run(main())
