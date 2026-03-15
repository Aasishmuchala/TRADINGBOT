"""Smart Order Router — Selects optimal exchange for order execution."""
import time
from dataclasses import dataclass
from typing import Optional

import structlog

from core.redis_client import RedisClient

logger = structlog.get_logger()


@dataclass
class ExchangeScore:
    exchange: str
    latency_ms: float
    spread_bps: float
    fee_bps: float
    total_cost_bps: float  # Combined cost estimate
    available: bool


class SmartOrderRouter:
    """Routes orders to the exchange with lowest expected execution cost.
    
    Cost = estimated_slippage + fee + latency_penalty
    """

    # Fee schedule (maker/taker in bps) — conservative taker rates
    FEE_SCHEDULE = {
        "binance": {"maker": 1.0, "taker": 1.0},
        "bybit": {"maker": 1.0, "taker": 1.0},
        "kucoin": {"maker": 2.0, "taker": 6.0},
    }

    # Latency penalty: additional bps cost per 100ms of latency
    LATENCY_PENALTY_PER_100MS = 0.5  # 0.5 bps per 100ms

    # Exchanges considered unavailable above this latency
    MAX_ACCEPTABLE_LATENCY_MS = 5000

    def __init__(self, redis: RedisClient):
        self.redis = redis

    async def select_exchange(
        self,
        asset: str,
        side: str,
        order_size_usd: float,
    ) -> Optional[str]:
        """Select the best exchange for this order.
        
        Args:
            asset: Trading pair (e.g., "BTC/USDT")
            side: "buy" or "sell"
            order_size_usd: Order notional in USD
        
        Returns:
            Exchange name or None if all exchanges unavailable
        """
        scores = await self._score_exchanges(asset, side, order_size_usd)
        available = [s for s in scores if s.available]

        if not available:
            logger.error("router.no_available_exchange", asset=asset)
            return None

        best = min(available, key=lambda s: s.total_cost_bps)
        logger.info(
            "router.selected",
            exchange=best.exchange,
            cost_bps=best.total_cost_bps,
            latency_ms=best.latency_ms,
            asset=asset,
        )
        return best.exchange

    async def _score_exchanges(
        self,
        asset: str,
        side: str,
        order_size_usd: float,
    ) -> list[ExchangeScore]:
        """Score all exchanges for routing decision."""
        scores = []

        for exchange_name in self.FEE_SCHEDULE:
            latency = await self.redis.get_latency(exchange_name)
            if latency is None:
                latency = 9999.0

            available = latency < self.MAX_ACCEPTABLE_LATENCY_MS

            # Get fee
            fee_type = "taker"  # Default to taker for market orders
            fee_bps = self.FEE_SCHEDULE[exchange_name][fee_type]

            # Estimate spread from orderbook data (cached in Redis)
            spread_bps = await self._get_spread(exchange_name, asset)

            # Latency cost penalty
            latency_cost = (latency / 100.0) * self.LATENCY_PENALTY_PER_100MS

            total_cost = fee_bps + spread_bps + latency_cost

            scores.append(ExchangeScore(
                exchange=exchange_name,
                latency_ms=latency,
                spread_bps=spread_bps,
                fee_bps=fee_bps,
                total_cost_bps=round(total_cost, 2),
                available=available,
            ))

        return scores

    async def _get_spread(self, exchange: str, asset: str) -> float:
        """Get current spread from Redis-cached orderbook data."""
        try:
            key = f"orderbook:{exchange}:{asset}"
            data = await self.redis.redis.hgetall(key)
            if data:
                best_bid = float(data.get("best_bid", 0))
                best_ask = float(data.get("best_ask", 0))
                if best_bid > 0 and best_ask > 0:
                    mid = (best_bid + best_ask) / 2.0
                    spread = (best_ask - best_bid) / mid * 10000  # Convert to bps
                    return round(spread, 2)
        except Exception as e:
            logger.debug("router.spread_fetch_failed", exchange=exchange, asset=asset, error=str(e))
        
        # Default spread estimate
        return 2.0  # 2 bps default

    async def get_routing_summary(self, asset: str) -> list[dict]:
        """Return routing scores for all exchanges (for dashboard)."""
        scores = await self._score_exchanges(asset, "buy", 1000)
        return [
            {
                "exchange": s.exchange,
                "latency_ms": s.latency_ms,
                "spread_bps": s.spread_bps,
                "fee_bps": s.fee_bps,
                "total_cost_bps": s.total_cost_bps,
                "available": s.available,
            }
            for s in scores
        ]
