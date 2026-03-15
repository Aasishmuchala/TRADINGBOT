import asyncio
import structlog
from core.redis_client import RedisClient

logger = structlog.get_logger()

class HeartbeatMixin:
    """Mixin that sends periodic heartbeats to Redis for watchdog monitoring."""
    
    service_name: str = "unknown"
    heartbeat_interval: float = 5.0
    
    def __init__(self, redis_client: RedisClient):
        self._redis = redis_client
        self._heartbeat_task: asyncio.Task = None
    
    async def start_heartbeat(self):
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        logger.info("heartbeat_started", service=self.service_name)
    
    async def stop_heartbeat(self):
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
            logger.info("heartbeat_stopped", service=self.service_name)
    
    async def _heartbeat_loop(self):
        while True:
            try:
                await self._redis.send_heartbeat(self.service_name)
            except Exception as e:
                logger.error("heartbeat_failed", service=self.service_name, error=str(e))
            await asyncio.sleep(self.heartbeat_interval)
