#!/usr/bin/env zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATASET_DIR="${1:-}"

if [[ -z "$DATASET_DIR" ]]; then
  echo "Usage: ./scripts/research-dataset-smoke.sh /absolute/path/to/datasets"
  exit 1
fi

if [[ ! -d "$DATASET_DIR" ]]; then
  echo "Dataset directory not found: $DATASET_DIR"
  exit 1
fi

if ! find "$DATASET_DIR" -maxdepth 1 -name '*.csv' | grep -q .; then
  echo "No CSV files found in dataset directory: $DATASET_DIR"
  exit 1
fi

cd "$ROOT_DIR"

echo "Validating supervisor build..."
cargo check -p sthyra-supervisor

echo "Running short supervisor smoke cycle with historical research dataset import..."
STHYRA_RESEARCH_DATASET_DIR="$DATASET_DIR" \
STHYRA_SUPERVISOR_CYCLES="${STHYRA_SUPERVISOR_CYCLES:-2}" \
STHYRA_SUPERVISOR_INTERVAL_MS="${STHYRA_SUPERVISOR_INTERVAL_MS:-250}" \
cargo run --bin sthyra-supervisor

SNAPSHOT_PATH="$ROOT_DIR/apps/desktop/runtime/runtime_snapshot.json"

if [[ ! -f "$SNAPSHOT_PATH" ]]; then
  echo "Runtime snapshot missing after smoke run: $SNAPSHOT_PATH"
  exit 1
fi

echo "Smoke run complete. Runtime snapshot updated at: $SNAPSHOT_PATH"