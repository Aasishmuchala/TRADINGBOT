"""Correlation Engine — Rolling pairwise correlation computation."""
import asyncio
import time
from itertools import combinations
from typing import Optional
from collections import defaultdict

import numpy as np
import structlog

from config.settings import Settings
from config.assets import TRACKED_ASSETS
from core.heartbeat import HeartbeatMixin
from core.redis_client import RedisClient

logger = structlog.get_logger()


class CorrelationEngine:
    """Computes rolling pairwise correlations from price returns."""

    def __init__(self, window: int = 60):
        self.window = window  # Number of data points (1 per second = 60s window)
        self.price_buffers: dict[str, list[float]] = defaultdict(list)
        self.max_buffer = window * 2  # Keep extra for stability

    def add_price(self, asset: str, price: float):
        """Add a price observation for an asset."""
        buf = self.price_buffers[asset]
        buf.append(price)
        if len(buf) > self.max_buffer:
            self.price_buffers[asset] = buf[-self.max_buffer:]

    def compute_returns(self, asset: str) -> Optional[np.ndarray]:
        """Compute log returns for an asset."""
        buf = self.price_buffers.get(asset, [])
        if len(buf) < self.window + 1:
            return None

        prices = np.array(buf[-(self.window + 1):])
        # Filter zeros
        if np.any(prices <= 0):
            return None

        returns = np.diff(np.log(prices))
        return returns

    def compute_correlation(self, asset_a: str, asset_b: str) -> Optional[float]:
        """Compute Pearson correlation between two assets' returns."""
        returns_a = self.compute_returns(asset_a)
        returns_b = self.compute_returns(asset_b)

        if returns_a is None or returns_b is None:
            return None

        if len(returns_a) != len(returns_b):
            min_len = min(len(returns_a), len(returns_b))
            returns_a = returns_a[-min_len:]
            returns_b = returns_b[-min_len:]

        if len(returns_a) < 10:
            return None

        # Check for zero variance
        if np.std(returns_a) < 1e-10 or np.std(returns_b) < 1e-10:
            return 0.0

        corr = np.corrcoef(returns_a, returns_b)[0, 1]

        # Handle NaN
        if np.isnan(corr):
            return 0.0

        return float(corr)

    def compute_all_pairs(self, assets: list[str]) -> dict[tuple[str, str], float]:
        """Compute all pairwise correlations."""
        results = {}
        for a, b in combinations(assets, 2):
            corr = self.compute_correlation(a, b)
            if corr is not None:
                results[(a, b)] = corr
        return results


class CorrelationEngineService(HeartbeatMixin):
    """Service that continuously computes and caches pairwise correlations."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.redis: Optional[RedisClient] = None
        self.service_name = "correlation_engine"
        self.engine = CorrelationEngine(window=60)
        self.compute_interval = 10  # Recompute every 10 seconds
        self.assets = [pair.replace("/", "") for pair in TRACKED_ASSETS]
        self.asset_pairs = TRACKED_ASSETS  # Original format for Redis keys

    async def start(self):
        self.redis = RedisClient(self.settings.redis_url)
        await self.redis.connect()

        await self.redis.create_consumer_group("raw_ticks", "correlation_group")

        logger.info("correlation_engine.started", assets=len(self.assets))
        await asyncio.gather(
            self._consume_ticks(),
            self._compute_loop(),
            self.run_heartbeat(self.redis),
        )

    async def _consume_ticks(self):
        """Consume raw ticks to build price buffers."""
        while True:
            try:
                messages = await self.redis.consume(
                    "raw_ticks", "correlation_group", self.service_name,
                    count=100, block_ms=500,
                )
                for msg_id, data in messages:
                    asset = data.get("asset", "")
                    price = float(data.get("price", 0))
                    if asset and price > 0:
                        self.engine.add_price(asset, price)
                    await self.redis.ack("raw_ticks", "correlation_group", msg_id)
            except Exception as e:
                logger.error("correlation_engine.consume_error", error=str(e))
                await asyncio.sleep(1)

    async def _compute_loop(self):
        """Periodically compute and cache all correlations."""
        while True:
            await asyncio.sleep(self.compute_interval)
            try:
                assets_with_data = [
                    a for a in self.asset_pairs
                    if len(self.engine.price_buffers.get(a, [])) > 60
                ]

                if len(assets_with_data) < 2:
                    continue

                pairs = self.engine.compute_all_pairs(assets_with_data)

                # Cache in Redis
                for (a, b), corr in pairs.items():
                    await self.redis.cache_correlation(a, b, corr)

                # Publish correlation matrix for dashboard
                matrix_data = {
                    f"{a}|{b}": round(corr, 4)
                    for (a, b), corr in pairs.items()
                }
                matrix_data["timestamp"] = time.time()
                matrix_data["pairs_computed"] = len(pairs)

                await self.redis.publish("correlation_updates", matrix_data)

                # Find highly correlated pairs and alert
                high_corr = {
                    f"{a}|{b}": round(corr, 4)
                    for (a, b), corr in pairs.items()
                    if abs(corr) > 0.85
                }
                if high_corr:
                    logger.info(
                        "correlation_engine.high_correlation",
                        pairs=high_corr,
                    )

            except Exception as e:
                logger.error("correlation_engine.compute_error", error=str(e))


async def main():
    settings = Settings()
    service = CorrelationEngineService(settings)
    await service.start()


if __name__ == "__main__":
    asyncio.run(main())
