import asyncio
import time
import ccxt.pro as ccxtpro
import ccxt
import structlog
from typing import Callable, Optional

logger = structlog.get_logger()

class ExchangeConnector:
    """Dual-mode WS/REST connector for a single exchange."""
    
    def __init__(self, exchange_id: str, api_key: str = "", api_secret: str = "",
                 passphrase: str = "", on_tick: Callable = None, on_orderbook: Callable = None):
        self.exchange_id = exchange_id
        self.on_tick = on_tick
        self.on_orderbook = on_orderbook
        self.in_fallback = False
        self._ws_exchange = None
        self._rest_exchange = None
        self._running = False
        self._last_ws_message = 0.0
        self._ws_timeout = 10.0  # seconds before fallback
        self._rest_interval = 1.0
        self._reconnect_interval = 30.0
        
        # Create exchanges
        exchange_class_ws = getattr(ccxtpro, exchange_id)
        exchange_class_rest = getattr(ccxt, exchange_id)
        
        config = {"apiKey": api_key, "secret": api_secret, "enableRateLimit": True}
        if passphrase:
            config["password"] = passphrase
        
        self._ws_exchange = exchange_class_ws(config)
        self._rest_exchange = exchange_class_rest(config)
    
    async def start(self, symbols: list[str]):
        """Start watching symbols via WebSocket, with REST fallback."""
        self._running = True
        self._last_ws_message = time.time()
        
        # Launch WS watchers and fallback monitor concurrently
        tasks = [
            asyncio.create_task(self._watch_trades(symbols)),
            asyncio.create_task(self._watch_orderbook(symbols)),
            asyncio.create_task(self._monitor_connection(symbols)),
        ]
        await asyncio.gather(*tasks, return_exceptions=True)
    
    async def stop(self):
        self._running = False
        if self._ws_exchange:
            await self._ws_exchange.close()
    
    async def _watch_trades(self, symbols: list[str]):
        """Watch trades via WebSocket."""
        while self._running:
            try:
                for symbol in symbols:
                    trades = await self._ws_exchange.watch_trades(symbol)
                    self._last_ws_message = time.time()
                    self.in_fallback = False
                    if self.on_tick:
                        for trade in trades:
                            await self.on_tick(self.exchange_id, symbol, {
                                "price": trade["price"],
                                "amount": trade["amount"],
                                "side": trade["side"],
                                "timestamp": trade["timestamp"] / 1000.0,
                            })
            except Exception as e:
                logger.warning("ws_trades_error", exchange=self.exchange_id, error=str(e))
                await asyncio.sleep(1)
    
    async def _watch_orderbook(self, symbols: list[str]):
        """Watch order book via WebSocket."""
        while self._running:
            try:
                for symbol in symbols:
                    ob = await self._ws_exchange.watch_order_book(symbol, limit=10)
                    self._last_ws_message = time.time()
                    if self.on_orderbook:
                        await self.on_orderbook(self.exchange_id, symbol, {
                            "bids": ob["bids"][:10],
                            "asks": ob["asks"][:10],
                            "timestamp": ob.get("timestamp", time.time() * 1000) / 1000.0,
                        })
            except Exception as e:
                logger.warning("ws_orderbook_error", exchange=self.exchange_id, error=str(e))
                await asyncio.sleep(1)
    
    async def _monitor_connection(self, symbols: list[str]):
        """Monitor WS health, switch to REST fallback if needed."""
        while self._running:
            await asyncio.sleep(2)
            elapsed = time.time() - self._last_ws_message
            
            if elapsed > self._ws_timeout and not self.in_fallback:
                logger.warning("ws_timeout_fallback", exchange=self.exchange_id, elapsed=elapsed)
                self.in_fallback = True
                asyncio.create_task(self._rest_fallback_loop(symbols))
            
            if self.in_fallback and elapsed < 2.0:
                logger.info("ws_recovered", exchange=self.exchange_id)
                self.in_fallback = False
    
    async def _rest_fallback_loop(self, symbols: list[str]):
        """Poll REST API while WebSocket is down."""
        logger.info("rest_fallback_started", exchange=self.exchange_id)
        while self._running and self.in_fallback:
            try:
                for symbol in symbols:
                    ticker = self._rest_exchange.fetch_ticker(symbol)
                    if self.on_tick:
                        await self.on_tick(self.exchange_id, symbol, {
                            "price": ticker["last"],
                            "amount": ticker.get("quoteVolume", 0),
                            "side": "unknown",
                            "timestamp": time.time(),
                        })
                    ob = self._rest_exchange.fetch_order_book(symbol, limit=10)
                    if self.on_orderbook:
                        await self.on_orderbook(self.exchange_id, symbol, {
                            "bids": ob["bids"][:10],
                            "asks": ob["asks"][:10],
                            "timestamp": time.time(),
                        })
            except Exception as e:
                logger.error("rest_fallback_error", exchange=self.exchange_id, error=str(e))
            await asyncio.sleep(self._rest_interval)