# Go-Live Checklist

Use this checklist before enabling live Binance trading on a local Sthyra installation.

## Release Gate

1. Confirm `cargo test` passes from the repository root.
2. Confirm `npm run build` passes from `apps/desktop`.
3. Confirm `./scripts/stack.sh restart` and `./scripts/stack.sh health` both succeed.
4. Confirm the dashboard loads on `http://localhost:4174` and the Operations tab remains responsive.

## Trading Gate

1. Start in `Research` mode and confirm the snapshot is refreshing without incidents.
2. Switch to `Paper` mode and let the supervisor run long enough to produce fresh order intents and execution events.
3. Review the execution ledger, operator log, and anomaly panel for drift, duplicate actions, or repeated maintenance churn.
4. Validate exchange connectivity and account reads before enabling any trading flags.
5. Enable live trading only after risk limits, symbol filters, and account balances have been reviewed against the current Binance account.

## Secrets Gate

1. Verify Binance credentials are loaded from the local secrets path expected by the runtime.
2. Confirm no credentials are committed to the repository or exported in audit bundles.
3. Back up the current local configuration before the first live session.

## Operator Recovery

1. Verify `Emergency Stop` succeeds from the dashboard.
2. Verify `Restart Supervisor` succeeds and the runtime returns to a healthy state.
3. Export an audit bundle and confirm it contains current operator events, incidents, intents, and execution events.
4. Record where `.sthyra/` is being backed up for post-incident review.

## Post-Session

1. Export the audit bundle for the session.
2. Review anomalies and maintenance actions before the next session.
3. Compact the audit database if retention pressure is elevated.
4. Return the runtime to `Research` or stop the stack fully when trading is complete.
