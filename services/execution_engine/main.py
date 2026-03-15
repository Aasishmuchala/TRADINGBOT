"""Execution Engine Service — Smart order routing and exchange execution."""
import asyncio
import json
import time
import uuid
from typing import Optional

import ccxt.async_support as ccxt
import structlog

from config.settings import Settings
from config.exchanges import EXCHANGES
from core.heartbeat import HeartbeatMixin
from core.redis_client import RedisClient
from services.execution_engine.router import SmartOrderRouter
from services.execution_engine.slippage import SlippageModel

logger = structlog.get_logger()


class ExecutionEngineService(HeartbeatMixin):
    """Executes orders on exchanges with smart routing and slippage tracking."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.redis: Optional[RedisClient] = None
        self.service_name = "execution_engine"
        self.exchanges: dict[str, ccxt.Exchange] = {}
        self.router: Optional[SmartOrderRouter] = None
        self.slippage_model = SlippageModel()
        self.paper_mode = settings.paper_mode

    async def start(self):
        self.redis = RedisClient(self.settings.redis_url)
        await self.redis.connect()
        self.router = SmartOrderRouter(self.redis)

        # Initialize exchange connections with API keys
        await self._init_exchanges()

        # Create consumer group
        await self.redis.create_consumer_group("approved_orders", "execution_group")

        logger.info("execution_engine.started", paper_mode=self.paper_mode)
        await asyncio.gather(
            self._consume_orders(),
            self._refit_slippage_model(),
            self.run_heartbeat(self.redis),
        )

    async def _init_exchanges(self):
        """Initialize exchange connections with API credentials."""
        exchange_configs = {
            "binance": {
                "ccxt_id": "binance",
                "apiKey": self.settings.binance_api_key,
                "secret": self.settings.binance_api_secret,
            },
            "bybit": {
                "ccxt_id": "bybit",
                "apiKey": self.settings.bybit_api_key,
                "secret": self.settings.bybit_api_secret,
            },
            "kucoin": {
                "ccxt_id": "kucoin",
                "apiKey": self.settings.kucoin_api_key,
                "secret": self.settings.kucoin_api_secret,
                "password": self.settings.kucoin_passphrase,
            },
        }

        for name, config in exchange_configs.items():
            try:
                ccxt_id = config.pop("ccxt_id")
                exchange_class = getattr(ccxt, ccxt_id)
                # Only pass credentials if they exist
                creds = {k: v for k, v in config.items() if v}
                creds["enableRateLimit"] = True
                creds["timeout"] = 10000

                if self.paper_mode:
                    # In paper mode, use sandbox if available
                    creds["sandbox"] = True

                self.exchanges[name] = exchange_class(creds)
                logger.info("execution_engine.exchange_init", exchange=name)
            except Exception as e:
                logger.error("execution_engine.exchange_init_failed", exchange=name, error=str(e))

    async def _consume_orders(self):
        """Consume approved orders and execute."""
        while True:
            try:
                messages = await self.redis.consume(
                    "approved_orders", "execution_group", self.service_name,
                    count=5, block_ms=500,
                )
                for msg_id, data in messages:
                    await self._execute_order(msg_id, data)
            except Exception as e:
                logger.error("execution_engine.consume_error", error=str(e))
                await asyncio.sleep(1)

    async def _execute_order(self, msg_id: str, order_data: dict):
        """Execute a single order."""
        asset = order_data.get("asset", "")
        side = order_data.get("side", "buy")
        quantity = float(order_data.get("quantity", 0))
        price = float(order_data.get("price", 0))
        strategy = order_data.get("strategy", "unknown")
        order_id = order_data.get("order_id", str(uuid.uuid4()))

        if quantity <= 0:
            logger.warning("execution_engine.zero_quantity", order_id=order_id)
            await self.redis.ack("approved_orders", "execution_group", msg_id)
            return

        # Route to best exchange
        exchange_name = await self.router.select_exchange(asset, side, quantity * price)
        if not exchange_name:
            logger.error("execution_engine.no_exchange", order_id=order_id)
            await self.redis.ack("approved_orders", "execution_group", msg_id)
            return

        exchange = self.exchanges.get(exchange_name)
        if not exchange:
            logger.error("execution_engine.exchange_not_found", exchange=exchange_name)
            await self.redis.ack("approved_orders", "execution_group", msg_id)
            return

        # Estimate slippage before execution
        vol_data = await self._get_realized_vol(asset)
        spread_data = await self._get_spread(exchange_name, asset)
        slippage_est = self.slippage_model.estimate(
            order_size_usd=quantity * price,
            realized_vol=vol_data,
            spread_bps=spread_data,
        )

        # Execute
        fill_report = await self._place_order(
            exchange_name, exchange, asset, side, quantity, price, order_id
        )

        if fill_report:
            # Compute actual slippage
            if price > 0:
                actual_slippage_bps = abs(fill_report["fill_price"] - price) / price * 10000
            else:
                actual_slippage_bps = 0

            fill_report["expected_slippage_bps"] = slippage_est.expected_bps
            fill_report["actual_slippage_bps"] = round(actual_slippage_bps, 2)
            fill_report["strategy"] = strategy
            fill_report["exchange"] = exchange_name

            # Record for slippage model learning
            self.slippage_model.record_fill(
                order_size_usd=quantity * price,
                realized_vol=vol_data,
                spread_bps=spread_data,
                actual_slippage_bps=actual_slippage_bps,
            )

            # Publish fill report
            await self.redis.publish("fill_reports", fill_report)
            logger.info(
                "execution_engine.filled",
                order_id=order_id,
                exchange=exchange_name,
                asset=asset,
                side=side,
                qty=fill_report["filled_qty"],
                price=fill_report["fill_price"],
                slippage_bps=actual_slippage_bps,
            )

        await self.redis.ack("approved_orders", "execution_group", msg_id)

    async def _place_order(
        self,
        exchange_name: str,
        exchange: ccxt.Exchange,
        asset: str,
        side: str,
        quantity: float,
        price: float,
        order_id: str,
    ) -> Optional[dict]:
        """Place order on exchange (or simulate in paper mode)."""
        try:
            if self.paper_mode:
                # Simulate fill with small random slippage
                import random
                slippage_pct = random.uniform(0, 0.001)  # 0-0.1% slippage
                fill_price = price * (1 + slippage_pct if side == "buy" else 1 - slippage_pct)

                return {
                    "order_id": order_id,
                    "asset": asset,
                    "side": side,
                    "filled_qty": quantity,
                    "fill_price": round(fill_price, 8),
                    "fee": round(quantity * fill_price * 0.001, 4),  # 0.1% fee
                    "timestamp": time.time(),
                    "paper_mode": True,
                }
            else:
                # Real execution via ccxt
                result = await exchange.create_order(
                    symbol=asset,
                    type="limit",
                    side=side,
                    amount=quantity,
                    price=price,
                )

                # Wait briefly for fill
                await asyncio.sleep(0.5)

                # Fetch order status
                order_info = await exchange.fetch_order(result["id"], asset)

                filled_qty = order_info.get("filled", 0)
                avg_price = order_info.get("average", price)
                fee_info = order_info.get("fee", {})

                return {
                    "order_id": order_id,
                    "exchange_order_id": result["id"],
                    "asset": asset,
                    "side": side,
                    "filled_qty": filled_qty,
                    "fill_price": avg_price,
                    "fee": fee_info.get("cost", 0),
                    "fee_currency": fee_info.get("currency", "USDT"),
                    "timestamp": time.time(),
                    "paper_mode": False,
                }

        except Exception as e:
            logger.error(
                "execution_engine.order_failed",
                exchange=exchange_name,
                order_id=order_id,
                error=str(e),
            )
            return None

    async def _get_realized_vol(self, asset: str) -> float:
        """Get realized volatility from feature store."""
        try:
            features = await self.redis.get_features("1h", asset)
            if features and "realized_vol" in features:
                return float(features["realized_vol"])
        except Exception:
            pass
        return 0.02  # Default 2%

    async def _get_spread(self, exchange: str, asset: str) -> float:
        """Get current spread in bps."""
        try:
            key = f"orderbook:{exchange}:{asset}"
            data = await self.redis.redis.hgetall(key)
            if data:
                bid = float(data.get("best_bid", 0))
                ask = float(data.get("best_ask", 0))
                if bid > 0 and ask > 0:
                    return (ask - bid) / ((bid + ask) / 2) * 10000
        except Exception:
            pass
        return 2.0  # Default 2 bps

    async def _refit_slippage_model(self):
        """Periodically refit slippage model from accumulated fills."""
        while True:
            await asyncio.sleep(3600)  # Every hour
            self.slippage_model.refit()

    async def shutdown(self):
        """Close all exchange connections."""
        for name, exchange in self.exchanges.items():
            try:
                await exchange.close()
            except Exception:
                pass


async def main():
    settings = Settings()
    service = ExecutionEngineService(settings)
    try:
        await service.start()
    finally:
        await service.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
