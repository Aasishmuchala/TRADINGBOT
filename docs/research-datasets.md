# Research Datasets

The supervisor can extend its replay and research frame set with per-symbol historical candle CSV files.

## Enable Import

Set `STHYRA_RESEARCH_DATASET_DIR` to a directory containing one CSV file per symbol:

```bash
STHYRA_RESEARCH_DATASET_DIR=/absolute/path/to/datasets \
STHYRA_SUPERVISOR_CYCLES=3 \
cargo run --bin sthyra-supervisor
```

Expected file naming:

- `BTCUSDT.csv`
- `ETHUSDT.csv`
- `SOLUSDT.csv`

The filename stem must match the symbol name used by the supervisor.

## Supported CSV Shapes

The importer accepts either a compact 6-column candle format or Binance-style kline exports.

Compact format:

```csv
open_time_ms,open,high,low,close,volume
1704067200000,42210.5,42340.1,42180.0,42305.3,184.2
1704067260000,42305.3,42388.4,42295.0,42340.8,96.7
```

Binance-style rows are also accepted as long as the first six columns are:

```text
open_time_ms,open,high,low,close,volume,...
```

Header rows and malformed lines are skipped.

## Import Rules

- At least 30 valid candles are required for a symbol to contribute replay frames.
- The supervisor combines imported historical contexts with its live symbol contexts.
- Imported candles currently affect research and model promotion inputs, not the dashboard chart history directly.

## Smoke Test

Use the helper script from the repository root:

```bash
./scripts/research-dataset-smoke.sh /absolute/path/to/datasets
```

That script validates the Rust path and runs a short supervisor cycle with `STHYRA_RESEARCH_DATASET_DIR` set.
