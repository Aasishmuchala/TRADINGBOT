# Execution V0

Current execution behavior:

- Tracks internal order state from intent creation through submit, accept, fill, and reconciliation.
- Supports desync marking as a first-class terminal safety state.
- Rejects invalid execution transitions.

Planned next additions:

- Binance exchange-rule validation.
- Limit, stop, take-profit, and reduce-only order models.
- Partial fills with quantity tracking.
- Retry classification and reconciliation against remote exchange state.
