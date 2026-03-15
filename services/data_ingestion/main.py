import asyncio
import time
import structlog
from config.settings import Settings
from config.exchanges import EXCHANGES
from config.assets import TRACKED_PAIRS
from core.redis_client import RedisClient
from core.heartbeat import HeartbeatMixin
from services.data_ingestion.exchange_connector import ExchangeConnector

logger = structlog.get_logger()

class DataIngestionService(HeartbeatMixin):
    service_name = "data-ingestion"
    
    def __init__(self):
        self.settings = Settings()
        self.redis = RedisClient(self.settings)
        super().__init__(self.redis)
        self.connectors: list[ExchangeConnector] = []
    
    async def on_tick(self, exchange: str, symbol: str, tick: dict):
        """Publish tick to Redis Stream."""
        await self.redis.publish("raw_ticks", {
            "exchange": exchange,
            "symbol": symbol,
            "price": tick["price"],
            "amount": tick["amount"],
            "side": tick["side"],
            "timestamp": tick["timestamp"],
            "received_at": time.time(),
        })
    
    async def on_orderbook(self, exchange: str, symbol: str, ob: dict):
        """Publish order book snapshot to Redis Stream."""
        await self.redis.publish("raw_orderbook", {
            "exchange": exchange,
            "symbol": symbol,
            "bids": ob["bids"],
            "asks": ob["asks"],
            "timestamp": ob["timestamp"],
            "received_at": time.time(),
        })
    
    async def start(self):
        await self.redis.connect()
        await self.start_heartbeat()
        logger.info("data_ingestion_starting", exchanges=list(EXCHANGES.keys()), pairs=len(TRACKED_PAIRS))
        
        # Get API keys per exchange
        exchange_keys = {
            "binance": (self.settings.BINANCE_API_KEY, self.settings.BINANCE_API_SECRET, ""),
            "bybit": (self.settings.BYBIT_API_KEY, self.settings.BYBIT_API_SECRET, ""),
            "kucoin": (self.settings.KUCOIN_API_KEY, self.settings.KUCOIN_API_SECRET, self.settings.KUCOIN_PASSPHRASE),
        }
        
        tasks = []
        for name, config in EXCHANGES.items():
            key, secret, passphrase = exchange_keys.get(name, ("", "", ""))
            connector = ExchangeConnector(
                exchange_id=config["ccxt_id"],
                api_key=key,
                api_secret=secret,
                passphrase=passphrase,
                on_tick=self.on_tick,
                on_orderbook=self.on_orderbook,
            )
            self.connectors.append(connector)
            tasks.append(asyncio.create_task(connector.start(TRACKED_PAIRS)))
        
        logger.info("data_ingestion_started", connectors=len(self.connectors))
        await asyncio.gather(*tasks, return_exceptions=True)
    
    async def stop(self):
        for c in self.connectors:
            await c.stop()
        await self.stop_heartbeat()
        await self.redis.close()

async def main():
    service = DataIngestionService()
    try:
        await service.start()
    except KeyboardInterrupt:
        await service.stop()

if __name__ == "__main__":
    asyncio.run(main())