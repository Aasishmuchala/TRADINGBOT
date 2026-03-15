# Risk Gate V0

Current implementation scope:

- Rejects all non-live modes for live order approval.
- Rejects degraded system health.
- Rejects daily, weekly, or monthly drawdown breaches.
- Rejects leverage breaches.
- Rejects concurrent-position breaches.
- Rejects non-approved confluence decisions.

Planned next additions:

- Correlated exposure limits.
- Symbol concentration limits.
- Liquidity-adjusted size rules.
- Slippage guardrails.
- Cooldown windows after losses.
- Protected-mode and forced-paper escalation outputs.
