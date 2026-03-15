# Portfolio and Patch Sandbox V0

Current portfolio behavior:

- Aggregates total notional exposure.
- Computes maximum single-symbol concentration.
- Computes maximum correlation-bucket concentration.

Current patch-sandbox behavior:

- Rejects proposals when tests, replay, or invariant checks fail.
- Allows automatic promotion only for non-critical modules that pass all checks.
- Requires manual review for critical modules even when all checks pass.
