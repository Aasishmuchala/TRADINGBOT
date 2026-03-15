import redis.asyncio as aioredis
import json
import time
from typing import Optional
from config.settings import Settings

class RedisClient:
    """Async Redis client with stream operation helpers."""
    
    def __init__(self, settings: Settings = None):
        self.settings = settings or Settings()
        self._client: Optional[aioredis.Redis] = None
    
    async def connect(self):
        self._client = aioredis.from_url(
            self.settings.REDIS_URL,
            decode_responses=True
        )
        await self._client.ping()
    
    async def close(self):
        if self._client:
            await self._client.close()
    
    @property
    def client(self) -> aioredis.Redis:
        if not self._client:
            raise RuntimeError("Redis not connected. Call connect() first.")
        return self._client
    
    # --- Stream Operations ---
    
    async def publish(self, stream: str, data: dict, maxlen: int = 10000) -> str:
        """Add message to stream with approximate trimming."""
        payload = {k: json.dumps(v) if isinstance(v, (dict, list)) else str(v) for k, v in data.items()}
        return await self.client.xadd(stream, payload, maxlen=maxlen, approximate=True)
    
    async def create_consumer_group(self, stream: str, group: str, start_id: str = "0"):
        """Create consumer group, ignore if exists."""
        try:
            await self.client.xgroup_create(stream, group, id=start_id, mkstream=True)
        except aioredis.ResponseError as e:
            if "BUSYGROUP" not in str(e):
                raise
    
    async def consume(self, stream: str, group: str, consumer: str, 
                      count: int = 10, block: int = 1000) -> list:
        """Read from consumer group. Returns list of (message_id, data) tuples."""
        results = await self.client.xreadgroup(
            groupname=group, consumername=consumer,
            streams={stream: ">"}, count=count, block=block
        )
        messages = []
        if results:
            for stream_name, stream_msgs in results:
                for msg_id, data in stream_msgs:
                    # Deserialize JSON fields
                    parsed = {}
                    for k, v in data.items():
                        try:
                            parsed[k] = json.loads(v)
                        except (json.JSONDecodeError, TypeError):
                            parsed[k] = v
                    messages.append((msg_id, parsed))
        return messages
    
    async def ack(self, stream: str, group: str, message_id: str):
        """Acknowledge message processing."""
        await self.client.xack(stream, group, message_id)
    
    async def get_pending_count(self, stream: str, group: str) -> int:
        """Get number of pending (unacknowledged) messages."""
        try:
            info = await self.client.xpending(stream, group)
            return info.get("pending", 0) if isinstance(info, dict) else (info[0] if info else 0)
        except Exception:
            return 0
    
    async def move_to_dead_letter(self, stream: str, group: str, message_id: str, data: dict):
        """Move failed message to dead_letters stream."""
        await self.publish("dead_letters", {
            "original_stream": stream,
            "original_id": message_id,
            "data": data,
            "failed_at": time.time()
        })
        await self.ack(stream, group, message_id)
    
    # --- Hash Operations (Feature Store) ---
    
    async def set_features(self, timeframe: str, asset: str, features: dict):
        """Store feature snapshot in Redis hash."""
        key = f"features:{timeframe}:{asset}"
        payload = {k: json.dumps(v) if isinstance(v, (dict, list)) else str(v) for k, v in features.items()}
        payload["computed_at"] = str(time.time())
        await self.client.hset(key, mapping=payload)
    
    async def get_features(self, timeframe: str, asset: str) -> Optional[dict]:
        """Retrieve feature snapshot from Redis hash."""
        key = f"features:{timeframe}:{asset}"
        data = await self.client.hgetall(key)
        if not data:
            return None
        parsed = {}
        for k, v in data.items():
            try:
                parsed[k] = json.loads(v)
            except (json.JSONDecodeError, TypeError):
                parsed[k] = v
        return parsed
    
    # --- Correlation Cache ---
    
    async def set_correlation(self, asset_a: str, asset_b: str, value: float):
        """Cache pairwise correlation."""
        key = f"correlations:{asset_a}:{asset_b}"
        await self.client.set(key, str(value), ex=120)  # expires in 120s
    
    async def get_correlation(self, asset_a: str, asset_b: str) -> Optional[float]:
        """Get cached correlation, returns None if expired."""
        key = f"correlations:{asset_a}:{asset_b}"
        val = await self.client.get(key)
        if val is None:
            # Try reverse pair
            key = f"correlations:{asset_b}:{asset_a}"
            val = await self.client.get(key)
        return float(val) if val else None
    
    # --- Latency Cache ---
    
    async def set_latency(self, exchange: str, p50: float, p95: float, p99: float):
        """Cache exchange latency metrics."""
        key = f"latency:{exchange}"
        await self.client.hset(key, mapping={"p50": str(p50), "p95": str(p95), "p99": str(p99), "updated_at": str(time.time())})
    
    async def get_latency(self, exchange: str) -> Optional[dict]:
        """Get cached latency metrics."""
        key = f"latency:{exchange}"
        data = await self.client.hgetall(key)
        if not data:
            return None
        return {k: float(v) for k, v in data.items()}
    
    # --- Heartbeat ---
    
    async def send_heartbeat(self, service_name: str):
        """Send heartbeat for watchdog monitoring."""
        key = f"heartbeat:{service_name}"
        await self.client.set(key, str(time.time()), ex=15)  # expires in 15s (3 missed = dead)
    
    async def check_heartbeat(self, service_name: str) -> Optional[float]:
        """Check last heartbeat time. None means dead."""
        key = f"heartbeat:{service_name}"
        val = await self.client.get(key)
        return float(val) if val else None
