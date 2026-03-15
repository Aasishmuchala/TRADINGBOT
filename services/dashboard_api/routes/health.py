"""Health routes — system status, heartbeats, degradation tier."""
import time
from fastapi import APIRouter, Depends
from core.redis_client import RedisClient

router = APIRouter(prefix="/api/health", tags=["health"])


async def get_redis():
    from services.dashboard_api.main import app_state
    return app_state["redis"]


SERVICES = [
    "data_ingestion", "feature_engine", "regime_detector",
    "strategy_selector", "strategy_runner", "risk_layer",
    "execution_engine", "trade_ledger", "correlation_engine",
    "watchdog", "latency_monitor", "retrainer", "backtester",
]


@router.get("/status")
async def get_system_health(redis: RedisClient = Depends(get_redis)):
    """Get health status of all services."""
    now = time.time()
    statuses = []

    for service in SERVICES:
        try:
            last_hb = await redis.check_heartbeat(service)
            if last_hb:
                age = now - last_hb
                status = "healthy" if age < 15 else "degraded" if age < 30 else "down"
            else:
                age = None
                status = "unknown"
        except Exception:
            age = None
            status = "error"

        statuses.append({
            "service": service,
            "status": status,
            "last_heartbeat_age_s": round(age, 1) if age else None,
        })

    healthy = sum(1 for s in statuses if s["status"] == "healthy")
    total = len(statuses)

    return {
        "services": statuses,
        "summary": {
            "healthy": healthy,
            "degraded": sum(1 for s in statuses if s["status"] == "degraded"),
            "down": sum(1 for s in statuses if s["status"] == "down"),
            "total": total,
        },
        "overall": "healthy" if healthy == total else "degraded" if healthy > total * 0.5 else "critical",
    }


@router.get("/latency")
async def get_exchange_latency(redis: RedisClient = Depends(get_redis)):
    """Get exchange latency data."""
    exchanges = ["binance", "bybit", "kucoin"]
    result = []
    for ex in exchanges:
        try:
            latency = await redis.get_latency(ex)
            result.append({"exchange": ex, "latency_ms": latency})
        except Exception:
            result.append({"exchange": ex, "latency_ms": None})
    return result