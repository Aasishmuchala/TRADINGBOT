"""Chart routes — OHLCV data and correlation matrix for visualization."""
from fastapi import APIRouter, Depends, Query
from core.redis_client import RedisClient
from core.db import Database

router = APIRouter(prefix="/api/charts", tags=["charts"])


async def get_redis():
    from services.dashboard_api.main import app_state
    return app_state["redis"]

async def get_db():
    from services.dashboard_api.main import app_state
    return app_state["db"]


@router.get("/ohlcv/{asset}")
async def get_ohlcv(
    asset: str,
    timeframe: str = Query("1h", regex="^(1m|5m|15m|1h|4h)$"),
    limit: int = Query(200, le=1000),
    db: Database = Depends(get_db),
):
    """Get OHLCV candle data for charting."""
    try:
        rows = await db.fetch(
            """SELECT timestamp, open, high, low, close, volume
               FROM ohlcv
               WHERE asset = $1 AND timeframe = $2
               ORDER BY timestamp DESC LIMIT $3""",
            asset, timeframe, limit,
        )
        return [
            {
                "timestamp": str(r["timestamp"]),
                "open": float(r["open"]),
                "high": float(r["high"]),
                "low": float(r["low"]),
                "close": float(r["close"]),
                "volume": float(r["volume"]),
            }
            for r in reversed(rows)
        ]
    except Exception:
        return []


@router.get("/correlations")
async def get_correlation_matrix(redis: RedisClient = Depends(get_redis)):
    """Get current correlation matrix."""
    try:
        import json
        data = await redis.redis.get("correlation:matrix")
        if data:
            return json.loads(data)
    except Exception:
        pass
    return {"pairs": {}, "timestamp": None}


@router.get("/regime-history")
async def get_regime_history(hours: int = 24, db: Database = Depends(get_db)):
    """Get regime detection history for overlay chart."""
    try:
        rows = await db.fetch(
            """SELECT timestamp, regime, confidence
               FROM regime_history
               WHERE timestamp > NOW() - INTERVAL '%s hours'
               ORDER BY timestamp ASC""",
            hours,
        )
        return [
            {
                "timestamp": str(r["timestamp"]),
                "regime": r["regime"],
                "confidence": float(r["confidence"]),
            }
            for r in rows
        ]
    except Exception:
        return []