# Watchdog and Self-Heal V0

Current watchdog behavior:

- Halts on exchange desync.
- Moves into protected-only on stale feeds, repeated order failures, or missed heartbeats.
- Marks degraded on CPU pressure, disk pressure, or degraded feed quality.

Current self-heal behavior:

- Reconnects market streams on stale-feed protection events.
- Resyncs account state and downgrades to paper on repeated order failures.
- Halts trading on critical failures.
- Only emits safe recovery actions; it does not patch or rewrite critical modules.
