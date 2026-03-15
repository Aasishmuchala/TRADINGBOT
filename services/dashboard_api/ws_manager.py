"""WebSocket subscription manager for real-time dashboard updates."""
import asyncio
import json
from typing import Optional

import structlog
from fastapi import WebSocket

logger = structlog.get_logger()


class WSManager:
    """Manages WebSocket connections and broadcasts Redis stream updates."""

    def __init__(self):
        self.active_connections: list[WebSocket] = []
        self.subscriptions: dict[WebSocket, set[str]] = {}

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        self.subscriptions[websocket] = {"all"}  # Subscribe to everything by default
        logger.info("ws.connected", total=len(self.active_connections))

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        self.subscriptions.pop(websocket, None)
        logger.info("ws.disconnected", total=len(self.active_connections))

    async def subscribe(self, websocket: WebSocket, channels: list[str]):
        if websocket in self.subscriptions:
            self.subscriptions[websocket] = set(channels)

    async def broadcast(self, channel: str, data: dict):
        """Send data to all clients subscribed to this channel."""
        message = json.dumps({"channel": channel, "data": data})
        disconnected = []

        for ws in self.active_connections:
            subs = self.subscriptions.get(ws, set())
            if "all" in subs or channel in subs:
                try:
                    await ws.send_text(message)
                except Exception:
                    disconnected.append(ws)

        for ws in disconnected:
            self.disconnect(ws)

    async def send_personal(self, websocket: WebSocket, data: dict):
        try:
            await websocket.send_text(json.dumps(data))
        except Exception:
            self.disconnect(websocket)