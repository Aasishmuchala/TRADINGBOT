# Binance Exchange Layer V0

Current exchange-layer behavior:

- Models Binance REST and WebSocket base URLs for testnet and mainnet.
- Models core endpoints for exchange info, account, positions, open orders, and order placement.
- Validates quantity, price, leverage, tick size, step size, and min notional against local exchange rules.
- Reconciles local and exchange account snapshots for position and order mismatches.

Current limitation:

- Network transport and signature generation are not implemented yet.
- Exchange responses are not parsed yet.
