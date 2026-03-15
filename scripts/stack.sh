#!/usr/bin/env zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$ROOT_DIR/.sthyra"
RUNTIME_ENV_FILE="$STATE_DIR/runtime-env.sh"
SUPERVISOR_PID_FILE="$STATE_DIR/supervisor.pid"
SUPERVISOR_LOCK_FILE="$STATE_DIR/supervisor.lock"
OPERATOR_MODE_REQUEST_FILE="$STATE_DIR/operator-mode-request.txt"
DESKTOP_PID_FILE="$STATE_DIR/desktop.pid"
SUPERVISOR_LOG="$STATE_DIR/supervisor.log"
DESKTOP_LOG="$STATE_DIR/desktop.log"
DESKTOP_BUILD_LOG="$STATE_DIR/desktop-build.log"
RUNTIME_SNAPSHOT_PATH="$ROOT_DIR/apps/desktop/runtime/runtime_snapshot.json"
SUPERVISOR_BINARY="$ROOT_DIR/target/debug/sthyra-supervisor"
EXPORT_DIR="$STATE_DIR/exports"

: "${STHYRA_DESKTOP_PORT:=4174}"
: "${STHYRA_BINANCE_USE_TESTNET:=1}"
: "${STHYRA_ENABLE_BINANCE_HTTP:=0}"
: "${STHYRA_ENABLE_BINANCE_STREAM:=0}"
: "${STHYRA_ENABLE_BINANCE_TRADING:=0}"
: "${STHYRA_CANCEL_AFTER_SUBMIT:=0}"
: "${STHYRA_SUPERVISOR_INTERVAL_MS:=500}"
: "${STHYRA_RESEARCH_REFRESH_INTERVAL_MS:=1800000}"
: "${STHYRA_INDICATOR_PRUNE_MIN_FITNESS:=0.05}"
: "${STHYRA_INDICATOR_RETENTION_LIMIT:=6}"
: "${STHYRA_AUTO_OPEN:=0}"
: "${STHYRA_PAPER_SESSION_CYCLES:=8}"
: "${STHYRA_PAPER_SESSION_INTERVAL_MS:=1000}"

mkdir -p "$STATE_DIR"

if [[ -f "$RUNTIME_ENV_FILE" ]]; then
  source "$RUNTIME_ENV_FILE"
fi

load_binance_keychain_env() {
  if ! command -v security >/dev/null 2>&1; then
    return 0
  fi

  local api_key api_secret
  api_key="$(security find-generic-password -s sthyra.binance -a api-key -w 2>/dev/null || true)"
  api_secret="$(security find-generic-password -s sthyra.binance -a api-secret -w 2>/dev/null || true)"

  if [[ -n "$api_key" ]]; then
    export STHYRA_BINANCE_API_KEY="$api_key"
  else
    unset STHYRA_BINANCE_API_KEY 2>/dev/null || true
  fi

  if [[ -n "$api_secret" ]]; then
    export STHYRA_BINANCE_API_SECRET="$api_secret"
  else
    unset STHYRA_BINANCE_API_SECRET 2>/dev/null || true
  fi
}

snapshot_field() {
  local field_path="$1"

  [[ -f "$RUNTIME_SNAPSHOT_PATH" ]] || return 1
  python3 - <<'PY' "$RUNTIME_SNAPSHOT_PATH" "$field_path"
import json, sys

path = sys.argv[1]
field_path = sys.argv[2].split('.')

with open(path, 'r', encoding='utf-8') as handle:
    payload = json.load(handle)

value = payload
for key in field_path:
    if not isinstance(value, dict) or key not in value:
        raise SystemExit(1)
    value = value[key]

if value is None:
    print("null")
elif isinstance(value, bool):
    print("true" if value else "false")
else:
    print(value)
PY
}

snapshot_updated_at() {
  snapshot_field "updated_at"
}

snapshot_mode() {
  snapshot_field "mode"
}

write_mode_request() {
  local mode="$1"
  printf '%s\n' "$mode" > "$OPERATOR_MODE_REQUEST_FILE"
}

wait_for_snapshot_mode() {
  local target_mode="$1"
  local baseline_updated_at="$2"
  local attempts="${3:-40}"
  local current_mode current_updated_at

  for ((i = 1; i <= attempts; i++)); do
    current_mode="$(snapshot_mode 2>/dev/null || true)"
    current_updated_at="$(snapshot_updated_at 2>/dev/null || true)"

    if [[ "$current_mode" == "$target_mode" && ( -z "$baseline_updated_at" || "$current_updated_at" != "$baseline_updated_at" ) ]]; then
      return 0
    fi

    sleep 0.25
  done

  return 1
}

print_snapshot_summary() {
  local mode updated_at execution_summary promoted_id overlay_enabled leaderboard_count

  mode="$(snapshot_mode 2>/dev/null || echo unknown)"
  updated_at="$(snapshot_updated_at 2>/dev/null || echo unknown)"
  execution_summary="$(snapshot_field "execution_summary" 2>/dev/null || echo unknown)"
  promoted_id="$(snapshot_field "promoted_indicator.id" 2>/dev/null || echo null)"
  overlay_enabled="$(snapshot_field "promoted_indicator.overlay_enabled" 2>/dev/null || echo unknown)"
  leaderboard_count="$(snapshot_field "promoted_indicator.leaderboard_count" 2>/dev/null || echo unknown)"

  echo "Snapshot mode: $mode"
  echo "Snapshot updated: $updated_at"
  echo "Execution summary: $execution_summary"
  echo "Promoted indicator: $promoted_id"
  echo "Indicator overlay enabled: $overlay_enabled"
  echo "Indicator leaderboard count: $leaderboard_count"
}

export_paper_session_artifact() {
  local label="$1"
  local timestamp artifact_path overlay_state

  mkdir -p "$EXPORT_DIR"
  timestamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
  overlay_state="enabled"
  if [[ "${STHYRA_DISABLE_PROMOTED_INDICATORS:-0}" == "1" ]]; then
    overlay_state="disabled"
  fi
  artifact_path="$EXPORT_DIR/paper-session-${timestamp}-${label}-${overlay_state}.json"

  python3 - <<'PY' "$RUNTIME_SNAPSHOT_PATH" "$artifact_path" "$label" "$overlay_state"
import json, sys

snapshot_path, artifact_path, label, overlay_state = sys.argv[1:5]

with open(snapshot_path, 'r', encoding='utf-8') as handle:
    snapshot = json.load(handle)

payload = {
    "label": label,
    "overlay_state": overlay_state,
    "generated_at": snapshot.get("updated_at"),
    "snapshot": snapshot,
}

with open(artifact_path, 'w', encoding='utf-8') as handle:
    json.dump(payload, handle, indent=2)
PY

  echo "$artifact_path"
}

is_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

read_pid() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  tr -d '[:space:]' < "$file"
}

read_supervisor_lock_pid() {
  [[ -f "$SUPERVISOR_LOCK_FILE" ]] || return 1
  sed -n 's/^pid=//p' "$SUPERVISOR_LOCK_FILE" | head -n 1 | tr -d '[:space:]'
}

supervisor_pid() {
  local lock_pid pid_file_pid

  lock_pid="$(read_supervisor_lock_pid 2>/dev/null || true)"
  if is_running "$lock_pid"; then
    echo "$lock_pid"
    return 0
  fi

  pid_file_pid="$(read_pid "$SUPERVISOR_PID_FILE" 2>/dev/null || true)"
  if is_running "$pid_file_pid"; then
    echo "$pid_file_pid"
    return 0
  fi

  return 1
}

ensure_supervisor_binary() {
  if [[ ! -x "$SUPERVISOR_BINARY" || "$ROOT_DIR/crates/supervisor/src/main.rs" -nt "$SUPERVISOR_BINARY" ]]; then
    echo "Building supervisor binary..."
    (cd "$ROOT_DIR" && cargo build --bin sthyra-supervisor >/dev/null)
  fi
}

wait_for_http() {
  local url="$1"
  local attempts=40

  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done

  return 1
}

dashboard_url() {
  echo "http://localhost:$STHYRA_DESKTOP_PORT"
}

open_dashboard() {
  local url
  url="$(dashboard_url)"

  if command -v open >/dev/null 2>&1; then
    open "$url"
    return 0
  fi

  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 &
    return 0
  fi

  echo "Open manually: $url"
}

start_supervisor() {
  local existing_pid
  existing_pid="$(supervisor_pid 2>/dev/null || true)"
  if is_running "$existing_pid"; then
    echo "Supervisor already running on PID $existing_pid"
    echo "$existing_pid" > "$SUPERVISOR_PID_FILE"
    return 0
  fi

  rm -f "$SUPERVISOR_PID_FILE" "$SUPERVISOR_LOCK_FILE"
  ensure_supervisor_binary
  load_binance_keychain_env

  echo "Starting supervisor..."
  nohup env \
    STHYRA_SUPERVISOR_CYCLES=0 \
    STHYRA_SUPERVISOR_INTERVAL_MS="$STHYRA_SUPERVISOR_INTERVAL_MS" \
    STHYRA_RESEARCH_REFRESH_INTERVAL_MS="$STHYRA_RESEARCH_REFRESH_INTERVAL_MS" \
    STHYRA_INDICATOR_PRUNE_MIN_FITNESS="$STHYRA_INDICATOR_PRUNE_MIN_FITNESS" \
    STHYRA_INDICATOR_RETENTION_LIMIT="$STHYRA_INDICATOR_RETENTION_LIMIT" \
    STHYRA_BINANCE_USE_TESTNET="$STHYRA_BINANCE_USE_TESTNET" \
    STHYRA_ENABLE_BINANCE_HTTP="$STHYRA_ENABLE_BINANCE_HTTP" \
    STHYRA_ENABLE_BINANCE_STREAM="$STHYRA_ENABLE_BINANCE_STREAM" \
    STHYRA_ENABLE_BINANCE_TRADING="$STHYRA_ENABLE_BINANCE_TRADING" \
    STHYRA_CANCEL_AFTER_SUBMIT="$STHYRA_CANCEL_AFTER_SUBMIT" \
    "$SUPERVISOR_BINARY" >> "$SUPERVISOR_LOG" 2>&1 &
  echo $! > "$SUPERVISOR_PID_FILE"

  for _ in {1..40}; do
    existing_pid="$(supervisor_pid 2>/dev/null || true)"
    if is_running "$existing_pid"; then
      echo "$existing_pid" > "$SUPERVISOR_PID_FILE"
      return 0
    fi
    sleep 0.25
  done

  echo "Supervisor start timed out; inspect $SUPERVISOR_LOG"
  return 1
}

start_desktop() {
  local existing_pid
  existing_pid="$(read_pid "$DESKTOP_PID_FILE" 2>/dev/null || true)"
  if is_running "$existing_pid"; then
    echo "Desktop already running on PID $existing_pid"
    return 0
  fi

  echo "Building desktop app..."
  (
    cd "$ROOT_DIR/apps/desktop"
    npm run build >"$DESKTOP_BUILD_LOG" 2>&1
  )

  echo "Starting desktop on port $STHYRA_DESKTOP_PORT..."
  nohup zsh -c "cd '$ROOT_DIR/apps/desktop' && node ./node_modules/next/dist/bin/next start -p '$STHYRA_DESKTOP_PORT' >> '$DESKTOP_LOG' 2>&1" >/dev/null 2>&1 &
  local desktop_pid
  desktop_pid="$!"

  for _ in {1..20}; do
    if is_running "$desktop_pid"; then
      echo "$desktop_pid" > "$DESKTOP_PID_FILE"
      return 0
    fi
    sleep 0.1
  done

  echo "Desktop failed to start; inspect $DESKTOP_LOG and $DESKTOP_BUILD_LOG"
  return 1
}

stop_process() {
  local name="$1"
  local file="$2"
  local pid
  pid="$(read_pid "$file" 2>/dev/null || true)"

  if ! is_running "$pid"; then
    rm -f "$file"
    echo "$name is not running"
    return 0
  fi

  echo "Stopping $name (PID $pid)..."
  kill "$pid" 2>/dev/null || true
  for _ in {1..20}; do
    if ! is_running "$pid"; then
      rm -f "$file"
      echo "$name stopped"
      return 0
    fi
    sleep 0.1
  done

  kill -9 "$pid" 2>/dev/null || true
  rm -f "$file"
  echo "$name force-stopped"
}

status() {
  local active_supervisor_pid desktop_pid current_snapshot_mode current_snapshot_updated_at
  active_supervisor_pid="$(supervisor_pid 2>/dev/null || true)"
  desktop_pid="$(read_pid "$DESKTOP_PID_FILE" 2>/dev/null || true)"

  if is_running "$active_supervisor_pid"; then
    echo "Supervisor: running (PID $active_supervisor_pid)"
  else
    echo "Supervisor: stopped"
  fi

  if is_running "$desktop_pid"; then
    echo "Desktop: running (PID $desktop_pid, port $STHYRA_DESKTOP_PORT)"
  else
    echo "Desktop: stopped"
  fi

  if [[ -f "$RUNTIME_SNAPSHOT_PATH" ]]; then
    current_snapshot_mode="$(snapshot_mode 2>/dev/null || echo unknown)"
    current_snapshot_updated_at="$(snapshot_updated_at 2>/dev/null || echo unknown)"
    echo "Snapshot: $RUNTIME_SNAPSHOT_PATH"
    echo "Snapshot mode: $current_snapshot_mode"
    echo "Snapshot updated: $current_snapshot_updated_at"
  fi

  echo "Supervisor log: $SUPERVISOR_LOG"
  echo "Desktop log: $DESKTOP_LOG"
  echo "Desktop build log: $DESKTOP_BUILD_LOG"
}

health() {
  local api_url="http://localhost:$STHYRA_DESKTOP_PORT/api/runtime-snapshot"
  local page_url="http://localhost:$STHYRA_DESKTOP_PORT"
  local active_supervisor_pid

  active_supervisor_pid="$(supervisor_pid 2>/dev/null || true)"
  if is_running "$active_supervisor_pid"; then
    echo "Supervisor process OK: $active_supervisor_pid"
  else
    echo "Supervisor process FAIL"
    return 1
  fi

  if wait_for_http "$api_url"; then
    echo "API OK: $api_url"
  else
    echo "API FAIL: $api_url"
    return 1
  fi

  if wait_for_http "$page_url"; then
    echo "UI OK: $page_url"
  else
    echo "UI FAIL: $page_url"
    return 1
  fi

  if [[ -f "$RUNTIME_SNAPSHOT_PATH" ]]; then
    echo "Snapshot OK"
  else
    echo "Snapshot missing"
    return 1
  fi
}

start() {
  start_supervisor
  start_desktop
  echo "Waiting for dashboard API..."
  if ! wait_for_http "$(dashboard_url)/api/runtime-snapshot"; then
    echo "Stack start timed out; inspect logs in $STATE_DIR"
    exit 1
  fi
  echo "Stack started"
  if [[ "$STHYRA_AUTO_OPEN" == "1" ]]; then
    open_dashboard
  fi
  status
}

paper_session() {
  local baseline_updated_at label artifact_path exit_code

  label="${1:-manual}"
  baseline_updated_at="$(snapshot_updated_at 2>/dev/null || true)"

  stop_process "supervisor" "$SUPERVISOR_PID_FILE"
  rm -f "$SUPERVISOR_LOCK_FILE" "$SUPERVISOR_PID_FILE"
  ensure_supervisor_binary
  write_mode_request "Paper"

  echo "Starting paper session..."
  echo "Cycles: $STHYRA_PAPER_SESSION_CYCLES"
  echo "Interval ms: $STHYRA_PAPER_SESSION_INTERVAL_MS"
  echo "Promoted indicators disabled: ${STHYRA_DISABLE_PROMOTED_INDICATORS:-0}"

  set +e
  env \
    STHYRA_SUPERVISOR_CYCLES="$STHYRA_PAPER_SESSION_CYCLES" \
    STHYRA_SUPERVISOR_INTERVAL_MS="$STHYRA_PAPER_SESSION_INTERVAL_MS" \
    STHYRA_RESEARCH_REFRESH_INTERVAL_MS="$STHYRA_RESEARCH_REFRESH_INTERVAL_MS" \
    STHYRA_INDICATOR_PRUNE_MIN_FITNESS="$STHYRA_INDICATOR_PRUNE_MIN_FITNESS" \
    STHYRA_INDICATOR_RETENTION_LIMIT="$STHYRA_INDICATOR_RETENTION_LIMIT" \
    STHYRA_BINANCE_USE_TESTNET="$STHYRA_BINANCE_USE_TESTNET" \
    STHYRA_ENABLE_BINANCE_HTTP="$STHYRA_ENABLE_BINANCE_HTTP" \
    STHYRA_ENABLE_BINANCE_STREAM="$STHYRA_ENABLE_BINANCE_STREAM" \
    STHYRA_ENABLE_BINANCE_TRADING="$STHYRA_ENABLE_BINANCE_TRADING" \
    STHYRA_CANCEL_AFTER_SUBMIT="$STHYRA_CANCEL_AFTER_SUBMIT" \
    STHYRA_DISABLE_PROMOTED_INDICATORS="${STHYRA_DISABLE_PROMOTED_INDICATORS:-0}" \
    "$SUPERVISOR_BINARY" | tee -a "$SUPERVISOR_LOG"
  exit_code=$?
  set -e

  rm -f "$SUPERVISOR_PID_FILE"

  if [[ $exit_code -ne 0 ]]; then
    echo "Paper session failed; inspect $SUPERVISOR_LOG"
    return $exit_code
  fi

  if wait_for_snapshot_mode "Paper" "$baseline_updated_at" 20; then
    echo "Paper mode confirmed in runtime snapshot"
  else
    echo "Paper mode not confirmed in runtime snapshot"
    return 1
  fi

  print_snapshot_summary
  artifact_path="$(export_paper_session_artifact "$label")"
  echo "Paper session artifact: $artifact_path"
}

overlay_compare() {
  cd "$ROOT_DIR"
  "$ROOT_DIR/scripts/overlay-compare.sh" "$@"
}

usage() {
  cat <<'EOF'
Usage: scripts/stack.sh <start|stop|restart|status|health|open|start-supervisor|stop-supervisor|restart-supervisor|paper-session|overlay-compare>

Environment:
  STHYRA_DESKTOP_PORT            Desktop port. Default: 4174
  STHYRA_ENABLE_BINANCE_HTTP     0 or 1
  STHYRA_ENABLE_BINANCE_STREAM   0 or 1
  STHYRA_ENABLE_BINANCE_TRADING  0 or 1
  STHYRA_CANCEL_AFTER_SUBMIT     0 or 1
  STHYRA_SUPERVISOR_INTERVAL_MS  Supervisor cycle interval. Default: 1000
  STHYRA_AUTO_OPEN               Open the dashboard after startup. Default: 0
  STHYRA_PAPER_SESSION_CYCLES    Foreground paper-session cycles. Default: 8
  STHYRA_PAPER_SESSION_INTERVAL_MS Foreground paper-session interval. Default: 1000
  STHYRA_DISABLE_PROMOTED_INDICATORS  Disable promoted indicator overlay for A/B checks. Default: 0
EOF
}

case "${1:-}" in
  start)
    start
    ;;
  start-supervisor)
    start_supervisor
    status
    ;;
  stop)
    stop_process "desktop" "$DESKTOP_PID_FILE"
    stop_process "supervisor" "$SUPERVISOR_PID_FILE"
    ;;
  stop-supervisor)
    stop_process "supervisor" "$SUPERVISOR_PID_FILE"
    rm -f "$SUPERVISOR_LOCK_FILE"
    ;;
  restart)
    stop_process "desktop" "$DESKTOP_PID_FILE"
    stop_process "supervisor" "$SUPERVISOR_PID_FILE"
    start
    ;;
  restart-supervisor)
    stop_process "supervisor" "$SUPERVISOR_PID_FILE"
    rm -f "$SUPERVISOR_LOCK_FILE"
    start_supervisor
    status
    ;;
  status)
    status
    ;;
  health)
    health
    ;;
  paper-session)
    paper_session "${2:-manual}"
    ;;
  overlay-compare)
    shift
    overlay_compare "$@"
    ;;
  open)
    open_dashboard
    ;;
  *)
    usage
    exit 1
    ;;
esac