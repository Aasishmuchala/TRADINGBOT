"""Trade Ledger Service — P&L tracking and TimescaleDB persistence."""
import asyncio
import json
import time
from typing import Optional
from collections import defaultdict

import structlog

from config.settings import Settings
from core.heartbeat import HeartbeatMixin
from core.redis_client import RedisClient
from core.db import Database

logger = structlog.get_logger()


class PositionTracker:
    """Tracks open positions and computes P&L using average cost basis."""

    def __init__(self):
        self.positions: dict[str, dict] = {}  # asset -> {qty, avg_cost, side}
        self.realized_pnl: float = 0.0
        self.total_fees: float = 0.0
        self.trade_count: int = 0

    def process_fill(self, fill: dict) -> dict:
        """Process a fill and return P&L info.

        Returns dict with realized_pnl for this fill.
        """
        asset = fill["asset"]
        side = fill["side"]
        qty = float(fill["filled_qty"])
        price = float(fill["fill_price"])
        fee = float(fill.get("fee", 0))

        self.total_fees += fee
        self.trade_count += 1

        result = {
            "asset": asset,
            "realized_pnl": 0.0,
            "unrealized_pnl": 0.0,
            "position_qty": 0.0,
            "avg_cost": 0.0,
        }

        pos = self.positions.get(asset)

        if pos is None:
            # New position
            self.positions[asset] = {
                "qty": qty if side == "buy" else -qty,
                "avg_cost": price,
                "side": side,
            }
        elif (side == "buy" and pos["qty"] >= 0) or (side == "sell" and pos["qty"] <= 0):
            # Adding to position — update average cost
            old_notional = abs(pos["qty"]) * pos["avg_cost"]
            new_notional = qty * price
            total_qty = abs(pos["qty"]) + qty
            pos["avg_cost"] = (old_notional + new_notional) / total_qty if total_qty > 0 else price
            pos["qty"] = pos["qty"] + qty if side == "buy" else pos["qty"] - qty
        else:
            # Reducing or closing position — realize P&L
            close_qty = min(abs(pos["qty"]), qty)
            if pos["qty"] > 0:
                # Was long, selling
                pnl = close_qty * (price - pos["avg_cost"])
            else:
                # Was short, buying
                pnl = close_qty * (pos["avg_cost"] - price)

            result["realized_pnl"] = pnl - fee
            self.realized_pnl += pnl - fee

            remaining = abs(pos["qty"]) - close_qty
            if remaining <= 0:
                # Position fully closed
                excess = qty - close_qty
                if excess > 0:
                    # Flipped direction
                    self.positions[asset] = {
                        "qty": excess if side == "buy" else -excess,
                        "avg_cost": price,
                        "side": side,
                    }
                else:
                    del self.positions[asset]
            else:
                pos["qty"] = remaining if pos["qty"] > 0 else -remaining

        # Update result with current position state
        if asset in self.positions:
            pos = self.positions[asset]
            result["position_qty"] = pos["qty"]
            result["avg_cost"] = pos["avg_cost"]

        return result

    def get_portfolio_snapshot(self) -> dict:
        """Get current portfolio state."""
        return {
            "positions": {
                asset: {
                    "qty": pos["qty"],
                    "avg_cost": pos["avg_cost"],
                    "side": "long" if pos["qty"] > 0 else "short",
                }
                for asset, pos in self.positions.items()
            },
            "realized_pnl": round(self.realized_pnl, 4),
            "total_fees": round(self.total_fees, 4),
            "trade_count": self.trade_count,
            "open_positions": len(self.positions),
        }


class TradeLedgerService(HeartbeatMixin):
    """Persists trades and portfolio state to TimescaleDB."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.redis: Optional[RedisClient] = None
        self.db: Optional[Database] = None
        self.service_name = "trade_ledger"
        self.tracker = PositionTracker()
        self.snapshot_interval = 60  # Seconds between portfolio snapshots

    async def start(self):
        self.redis = RedisClient(self.settings.redis_url)
        await self.redis.connect()
        self.db = Database(self.settings.database_url)
        await self.db.connect()

        await self.redis.create_consumer_group("fill_reports", "ledger_group")

        logger.info("trade_ledger.started")
        await asyncio.gather(
            self._consume_fills(),
            self._snapshot_loop(),
            self.run_heartbeat(self.redis),
        )

    async def _consume_fills(self):
        """Consume fills and track P&L."""
        while True:
            try:
                messages = await self.redis.consume(
                    "fill_reports", "ledger_group", self.service_name,
                    count=20, block_ms=1000,
                )
                for msg_id, data in messages:
                    await self._process_fill(msg_id, data)
            except Exception as e:
                logger.error("trade_ledger.consume_error", error=str(e))
                await asyncio.sleep(1)

    async def _process_fill(self, msg_id: str, fill_data: dict):
        """Process a fill: track P&L and persist to DB."""
        try:
            pnl_info = self.tracker.process_fill(fill_data)

            # Persist fill to TimescaleDB
            await self.db.execute(
                """INSERT INTO fills
                   (timestamp, asset, side, quantity, price, fee, strategy, exchange,
                    realized_pnl, slippage_bps)
                   VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9)""",
                fill_data.get("asset", ""),
                fill_data.get("side", ""),
                float(fill_data.get("filled_qty", 0)),
                float(fill_data.get("fill_price", 0)),
                float(fill_data.get("fee", 0)),
                fill_data.get("strategy", "unknown"),
                fill_data.get("exchange", "unknown"),
                pnl_info["realized_pnl"],
                float(fill_data.get("actual_slippage_bps", 0)),
            )

            # Publish fill with P&L to dashboard
            await self.redis.publish("portfolio_updates", {
                "type": "fill",
                "asset": fill_data.get("asset"),
                "side": fill_data.get("side"),
                "qty": fill_data.get("filled_qty"),
                "price": fill_data.get("fill_price"),
                "realized_pnl": pnl_info["realized_pnl"],
                "position_qty": pnl_info["position_qty"],
                "strategy": fill_data.get("strategy"),
                "timestamp": time.time(),
            })

            logger.info(
                "trade_ledger.fill_processed",
                asset=fill_data.get("asset"),
                realized_pnl=pnl_info["realized_pnl"],
            )

        except Exception as e:
            logger.error("trade_ledger.process_error", error=str(e), fill=fill_data)

        await self.redis.ack("fill_reports", "ledger_group", msg_id)

    async def _snapshot_loop(self):
        """Periodically save portfolio snapshots to TimescaleDB."""
        while True:
            await asyncio.sleep(self.snapshot_interval)
            try:
                snapshot = self.tracker.get_portfolio_snapshot()

                # Persist snapshot
                await self.db.execute(
                    """INSERT INTO portfolio_snapshots
                       (timestamp, total_equity, realized_pnl, unrealized_pnl,
                        open_positions, total_fees)
                       VALUES (NOW(), $1, $2, $3, $4, $5)""",
                    self.settings.initial_capital + snapshot["realized_pnl"],
                    snapshot["realized_pnl"],
                    0.0,  # TODO: compute from live prices
                    snapshot["open_positions"],
                    snapshot["total_fees"],
                )

                # Publish to dashboard
                await self.redis.publish("portfolio_updates", {
                    "type": "snapshot",
                    **snapshot,
                    "timestamp": time.time(),
                })

            except Exception as e:
                logger.error("trade_ledger.snapshot_error", error=str(e))


async def main():
    settings = Settings()
    service = TradeLedgerService(settings)
    await service.start()


if __name__ == "__main__":
    asyncio.run(main())
