"""Strategy routes — performance, signals, regime info."""
from fastapi import APIRouter, Depends
from core.redis_client import RedisClient
from core.db import Database

router = APIRouter(prefix="/api/strategies", tags=["strategies"])


async def get_redis():
    from services.dashboard_api.main import app_state
    return app_state["redis"]

async def get_db():
    from services.dashboard_api.main import app_state
    return app_state["db"]


@router.get("/active")
async def get_active_strategies(redis: RedisClient = Depends(get_redis)):
    """Get currently active strategies and their weights."""
    try:
        import json
        data = await redis.redis.get("strategy:weights")
        if data:
            return json.loads(data)
    except Exception:
        pass
    return {"strategies": [], "regime": "unknown"}


@router.get("/performance")
async def get_strategy_performance(db: Database = Depends(get_db)):
    """Get per-strategy performance metrics."""
    try:
        rows = await db.fetch(
            """SELECT strategy,
                      COUNT(*) as trades,
                      SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
                      SUM(CASE WHEN realized_pnl <= 0 THEN 1 ELSE 0 END) as losses,
                      COALESCE(SUM(realized_pnl), 0) as total_pnl,
                      COALESCE(AVG(realized_pnl), 0) as avg_pnl,
                      COALESCE(AVG(slippage_bps), 0) as avg_slippage
               FROM fills
               WHERE timestamp > NOW() - INTERVAL '7 days'
               GROUP BY strategy ORDER BY total_pnl DESC"""
        )
        return [
            {
                "strategy": r["strategy"],
                "trades": int(r["trades"]),
                "wins": int(r["wins"]),
                "losses": int(r["losses"]),
                "win_rate": round(int(r["wins"]) / int(r["trades"]) * 100, 1) if int(r["trades"]) > 0 else 0,
                "total_pnl": round(float(r["total_pnl"]), 2),
                "avg_pnl": round(float(r["avg_pnl"]), 2),
                "avg_slippage": round(float(r["avg_slippage"]), 2),
            }
            for r in rows
        ]
    except Exception:
        return []


@router.get("/signals")
async def get_recent_signals(limit: int = 50, redis: RedisClient = Depends(get_redis)):
    """Get recent strategy signals (approved + rejected)."""
    try:
        import json
        signals = await redis.redis.lrange("signal:history", 0, limit - 1)
        return [json.loads(s) for s in signals if s]
    except Exception:
        return []


@router.get("/regime")
async def get_current_regime(redis: RedisClient = Depends(get_redis)):
    """Get current regime detection state."""
    try:
        import json
        data = await redis.redis.get("regime:current")
        if data:
            return json.loads(data)
    except Exception:
        pass
    return {"regime": "unknown", "confidence": 0, "probabilities": {}}