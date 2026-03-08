# Mode Authority V0

Current rules implemented:

- Research can move to backtest, replay, or paper only by operator request.
- Paper can move to semi-auto only by operator request.
- Semi-auto can move to full-auto only by operator request.
- Any mode can move to protected on degraded health, stale feeds, exchange desync, or repeated order failures.
- Any mode can move to paper on degraded health or repeated order failures.
- Any mode can move to halted on drawdown breaches, exchange desync, repeated order failures, or degraded health.

Current restriction:

- Direct escalation from research to full-auto is forbidden.
