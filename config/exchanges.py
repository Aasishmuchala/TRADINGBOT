"""Exchange registry and configuration."""

EXCHANGES = {
    "binance": {
        "ccxt_id": "binance",
        "ws_supported": True,
        "rest_fallback_interval": 1.0,
    },
    "bybit": {
        "ccxt_id": "bybit",
        "ws_supported": True,
        "rest_fallback_interval": 1.0,
    },
    "kucoin": {
        "ccxt_id": "kucoin",
        "ws_supported": True,
        "rest_fallback_interval": 1.0,
    },
}