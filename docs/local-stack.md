# Local Stack

Use the root stack controller to run Sthyra Quant OS without fighting random local ports or unrelated background processes.

## Commands

From the repository root:

```bash
./scripts/stack.sh start
./scripts/stack.sh start-supervisor
./scripts/stack.sh status
./scripts/stack.sh health
./scripts/stack.sh open
./scripts/stack.sh restart-supervisor
./scripts/stack.sh stop-supervisor
./scripts/stack.sh stop
./scripts/research-dataset-smoke.sh /absolute/path/to/datasets
```

## Default Behavior

- Starts the supervisor in indefinite mode.
- Starts the desktop app on port `4174`.
- Writes PID files and logs under `.sthyra/`.
- Waits for the dashboard API before reporting the stack as ready.

## Common Flags

```bash
STHYRA_AUTO_OPEN=1 ./scripts/stack.sh start
STHYRA_DESKTOP_PORT=4175 ./scripts/stack.sh start
STHYRA_ENABLE_BINANCE_HTTP=1 STHYRA_ENABLE_BINANCE_STREAM=1 ./scripts/stack.sh start
STHYRA_ENABLE_BINANCE_HTTP=1 STHYRA_ENABLE_BINANCE_STREAM=1 STHYRA_ENABLE_BINANCE_TRADING=1 ./scripts/stack.sh start
```

## Log Files

- `.sthyra/supervisor.log`
- `.sthyra/desktop.log`

## Historical Research Import

- Set `STHYRA_RESEARCH_DATASET_DIR` to import per-symbol candle CSVs into supervisor research frames.
- Dataset format and usage are documented in [docs/research-datasets.md](/Users/aasish/Desktop/TRADINGFb/docs/research-datasets.md).

## Workflow

1. Supervisor runs continuously and rewrites `apps/desktop/runtime/runtime_snapshot.json`.
2. Desktop app exposes `/api/runtime-snapshot` and refreshes the dashboard from that local endpoint.
3. Desktop app also exposes `/api/operator` for local-only operator actions: stack status, audit export, supervisor restart, emergency stop, and queued mode changes.
4. Operator events are persisted under `.sthyra/operator-events.ndjson`, and queued mode requests are written to `.sthyra/operator-mode-request.txt`.
5. The Operations tab in the dashboard drives those operator actions, shows the persistent operator log, and gates emergency stop behind a two-step confirmation.
6. `health` confirms the API, UI, and snapshot file are all reachable.
