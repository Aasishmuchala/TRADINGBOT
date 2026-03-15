"""Portfolio routes — positions, P&L, equity curve."""
from fastapi import APIRouter, Depends
from core.redis_client import RedisClient
from core.db import Database

router = APIRouter(prefix="/api/portfolio", tags=["portfolio"])


async def get_redis():
    from services.dashboard_api.main import app_state
    return app_state["redis"]

async def get_db():
    from services.dashboard_api.main import app_state
    return app_state["db"]


@router.get("/positions")
async def get_positions(redis: RedisClient = Depends(get_redis)):
    """Get current open positions."""
    try:
        data = await redis.redis.get("portfolio:positions")
        if data:
            import json
            return json.loads(data)
    except Exception:
        pass
    return {"positions": [], "total_exposure": 0}


@router.get("/pnl")
async def get_pnl(db: Database = Depends(get_db)):
    """Get P&L summary."""
    try:
        row = await db.fetchrow(
            """SELECT 
                COALESCE(SUM(realized_pnl), 0) as total_pnl,
                COUNT(*) as trade_count,
                COALESCE(SUM(fee), 0) as total_fees
               FROM fills WHERE timestamp > NOW() - INTERVAL '24 hours'"""
        )
        return {
            "daily_pnl": float(row["total_pnl"]) if row else 0,
            "trade_count": int(row["trade_count"]) if row else 0,
            "total_fees": float(row["total_fees"]) if row else 0,
        }
    except Exception:
        return {"daily_pnl": 0, "trade_count": 0, "total_fees": 0}


@router.get("/equity-curve")
async def get_equity_curve(hours: int = 24, db: Database = Depends(get_db)):
    """Get equity curve data points."""
    try:
        rows = await db.fetch(
            """SELECT timestamp, total_equity, realized_pnl, unrealized_pnl
               FROM portfolio_snapshots
               WHERE timestamp > NOW() - INTERVAL '%s hours'
               ORDER BY timestamp ASC""",
            hours,
        )
        return [
            {
                "timestamp": str(r["timestamp"]),
                "equity": float(r["total_equity"]),
                "realized_pnl": float(r["realized_pnl"]),
                "unrealized_pnl": float(r["unrealized_pnl"]),
            }
            for r in rows
        ]
    except Exception:
        return []


@router.get("/trades")
async def get_recent_trades(limit: int = 50, db: Database = Depends(get_db)):
    """Get recent trades."""
    try:
        rows = await db.fetch(
            """SELECT timestamp, asset, side, quantity, price, fee, strategy, 
                      exchange, realized_pnl, slippage_bps
               FROM fills ORDER BY timestamp DESC LIMIT $1""",
            limit,
        )
        return [
            {
                "timestamp": str(r["timestamp"]),
                "asset": r["asset"],
                "side": r["side"],
                "quantity": float(r["quantity"]),
                "price": float(r["price"]),
                "fee": float(r["fee"]),
                "strategy": r["strategy"],
                "exchange": r["exchange"],
                "realized_pnl": float(r["realized_pnl"]),
                "slippage_bps": float(r["slippage_bps"]),
            }
            for r in rows
        ]
    except Exception:
        return []