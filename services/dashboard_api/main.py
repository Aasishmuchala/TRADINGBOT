"""Dashboard API — FastAPI server with WebSocket support."""
import asyncio
import json
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from config.settings import Settings
from core.redis_client import RedisClient
from core.db import Database
from services.dashboard_api.ws_manager import WSManager
from services.dashboard_api.routes import portfolio, strategies, health, charts, settings

logger = structlog.get_logger()

# Shared app state
app_state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle."""
    settings = Settings()

    # Initialize connections
    redis = RedisClient(settings.redis_url)
    await redis.connect()
    db = Database(settings.database_url)
    await db.connect()

    app_state["redis"] = redis
    app_state["db"] = db
    app_state["ws_manager"] = WSManager()
    app_state["settings"] = settings

    # Start background Redis subscription relay
    relay_task = asyncio.create_task(_relay_redis_to_ws(redis, app_state["ws_manager"]))

    logger.info("dashboard_api.started")
    yield

    relay_task.cancel()
    logger.info("dashboard_api.stopped")


app = FastAPI(
    title="Trading Bot Dashboard API",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routes
app.include_router(portfolio.router)
app.include_router(strategies.router)
app.include_router(health.router)
app.include_router(charts.router)
app.include_router(settings.router)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    ws_manager = app_state["ws_manager"]
    await ws_manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                if msg.get("type") == "subscribe":
                    await ws_manager.subscribe(websocket, msg.get("channels", []))
            except json.JSONDecodeError:
                pass
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)


async def _relay_redis_to_ws(redis: RedisClient, ws_manager: WSManager):
    """Relay Redis pub/sub channels to WebSocket clients."""
    channels = [
        "portfolio_updates",
        "strategy_signals",
        "regime_signal",
        "correlation_updates",
        "latency_updates",
        "alerts",
        "fill_reports",
    ]

    # Use Redis pub/sub for real-time relay
    pubsub = redis.redis.pubsub()
    await pubsub.subscribe(*channels)

    try:
        async for message in pubsub.listen():
            if message["type"] == "message":
                channel = message["channel"]
                if isinstance(channel, bytes):
                    channel = channel.decode()
                try:
                    data = json.loads(message["data"])
                    await ws_manager.broadcast(channel, data)
                except (json.JSONDecodeError, TypeError):
                    pass
    except asyncio.CancelledError:
        await pubsub.unsubscribe(*channels)


@app.get("/api/ping")
async def ping():
    return {"status": "ok", "service": "dashboard_api"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)