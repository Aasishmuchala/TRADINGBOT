#!/usr/bin/env zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
STATE_DIR="$ROOT_DIR/.sthyra"
PID_FILE="$STATE_DIR/paper-week-monitor.pid"
LOG_FILE="$STATE_DIR/paper-week-monitor.log"
CHECKPOINT_FILE="$STATE_DIR/paper-week-monitor.ndjson"
ALERT_FILE="$STATE_DIR/paper-week-alerts.ndjson"

: "${STHYRA_DESKTOP_PORT:=4174}"
: "${STHYRA_MONITOR_INTERVAL_SECONDS:=3600}"
: "${STHYRA_MONITOR_DURATION_HOURS:=168}"

mkdir -p "$STATE_DIR"

api_base() {
  echo "http://127.0.0.1:$STHYRA_DESKTOP_PORT"
}

is_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

read_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  tr -d '[:space:]' < "$PID_FILE"
}

write_json_line() {
  local target_file="$1"
  local payload="$2"
  printf '%s\n' "$payload" >> "$target_file"
}

log_text() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG_FILE"
}

fetch_json() {
  local endpoint="$1"
  curl -fsS "$(api_base)$endpoint"
}

set_paper_mode() {
  curl -fsS -X POST "$(api_base)/api/operator" \
    -H 'Content-Type: application/json' \
    --data '{"action":"set-mode","targetMode":"Paper"}'
}

run_check() {
  python3 - <<'PY' "$ROOT_DIR" "$CHECKPOINT_FILE" "$ALERT_FILE"
import json
import subprocess
import sys
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

root_dir, checkpoint_path, alert_path = sys.argv[1:4]
base_url = "http://127.0.0.1:{}".format(__import__("os").environ.get("STHYRA_DESKTOP_PORT", "4174"))
timestamp = datetime.now(timezone.utc).isoformat()

def get_json(path):
    with urlopen(base_url + path, timeout=10) as response:
        return json.load(response)

def append_line(path, payload):
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, separators=(",", ":")) + "\n")

alert_messages = []
runtime = None
settings = None
operator = None

try:
    runtime = get_json("/api/runtime-snapshot")
    settings = get_json("/api/settings/trading")
    operator = get_json("/api/operator?eventLimit=8")
except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as error:
    payload = {
        "timestamp": timestamp,
        "level": "critical",
        "kind": "api-unavailable",
        "message": str(error),
    }
    append_line(alert_path, payload)
    append_line(checkpoint_path, {
        "timestamp": timestamp,
        "status": "degraded",
        "error": str(error),
    })
    print(json.dumps({"status": "degraded", "message": str(error)}))
    raise SystemExit(0)

mode = runtime.get("mode")
execution_summary = runtime.get("execution_summary")
trading_enabled = bool(settings.get("tradingEnabled"))
pending_mode = operator.get("pendingModeRequest")
trade_summary = ((operator.get("audit") or {}).get("tradeSummary") or {})
overlay_effect = operator.get("overlayEffect") or {}

checkpoint = {
    "timestamp": timestamp,
    "status": "ok",
    "mode": mode,
    "pending_mode_request": pending_mode,
    "trading_enabled": trading_enabled,
    "transport_enabled": bool(settings.get("transportEnabled")),
    "stream_enabled": bool(settings.get("streamEnabled")),
    "paper_trading_ready": bool(settings.get("paperTradingReady")),
    "execution_summary": execution_summary,
    "cycle": runtime.get("cycle"),
    "positions": len(runtime.get("positions") or []),
    "promoted_indicator": (runtime.get("promoted_indicator") or {}).get("id"),
    "closed_trades": trade_summary.get("closedTrades"),
    "realized_pnl_total": trade_summary.get("realizedPnlTotal"),
    "win_rate": trade_summary.get("winRate"),
    "exact_trade_count": trade_summary.get("exactTradeCount"),
    "overlay_changed_candidates": overlay_effect.get("changed_candidates"),
    "overlay_insufficient_candidates": overlay_effect.get("insufficient_candidates"),
}

if mode != "Paper":
    alert_messages.append({
        "timestamp": timestamp,
        "level": "high",
        "kind": "mode-drift",
        "message": f"Runtime drifted to {mode}; requesting Paper mode.",
    })
    try:
        result = subprocess.run(
            [
                "curl", "-fsS", "-X", "POST", f"{base_url}/api/operator",
                "-H", "Content-Type: application/json",
                "--data", '{"action":"set-mode","targetMode":"Paper"}'
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        response = json.loads(result.stdout)
        checkpoint["paper_recovery"] = {
            "confirmed": response.get("confirmed"),
            "message": response.get("message"),
        }
    except Exception as error:
        alert_messages.append({
            "timestamp": timestamp,
            "level": "critical",
            "kind": "paper-recovery-failed",
            "message": str(error),
        })
        checkpoint["status"] = "degraded"

if trading_enabled:
    alert_messages.append({
        "timestamp": timestamp,
        "level": "critical",
        "kind": "live-trading-enabled",
        "message": "Trading settings report tradingEnabled=true while week monitor expects paper mode.",
    })
    checkpoint["status"] = "degraded"

if not settings.get("paperTradingReady"):
    alert_messages.append({
        "timestamp": timestamp,
        "level": "high",
        "kind": "paper-not-ready",
        "message": "Paper trading posture is not ready according to settings.",
    })
    checkpoint["status"] = "degraded"

for payload in alert_messages:
    append_line(alert_path, payload)

append_line(checkpoint_path, checkpoint)
print(json.dumps(checkpoint))
PY
}

monitor_loop() {
  local interval_seconds="$STHYRA_MONITOR_INTERVAL_SECONDS"
  local max_checks=$(( (STHYRA_MONITOR_DURATION_HOURS * 3600) / interval_seconds ))
  local current_check=0

  log_text "paper-week monitor started interval=${interval_seconds}s duration_hours=${STHYRA_MONITOR_DURATION_HOURS}"

  while (( current_check < max_checks )); do
    current_check=$((current_check + 1))
    log_text "running monitor check ${current_check}/${max_checks}"
    run_check >> "$LOG_FILE" 2>&1 || true
    sleep "$interval_seconds"
  done

  log_text "paper-week monitor finished after ${max_checks} checks"
  rm -f "$PID_FILE"
}

start_monitor() {
  local existing_pid
  existing_pid="$(read_pid 2>/dev/null || true)"
  if is_running "$existing_pid"; then
    echo "paper-week monitor already running on PID $existing_pid"
    return 0
  fi

  nohup "$SCRIPT_PATH" run >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  echo "paper-week monitor started on PID $(cat "$PID_FILE")"
}

stop_monitor() {
  local pid
  pid="$(read_pid 2>/dev/null || true)"
  if ! is_running "$pid"; then
    rm -f "$PID_FILE"
    echo "paper-week monitor is not running"
    return 0
  fi

  kill "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "paper-week monitor stopped"
}

status_monitor() {
  local pid
  pid="$(read_pid 2>/dev/null || true)"
  if is_running "$pid"; then
    echo "paper-week monitor running (PID $pid)"
  else
    echo "paper-week monitor stopped"
  fi
  echo "Checkpoint file: $CHECKPOINT_FILE"
  echo "Alert file: $ALERT_FILE"
  echo "Log file: $LOG_FILE"
}

case "${1:-}" in
  start)
    start_monitor
    ;;
  stop)
    stop_monitor
    ;;
  status)
    status_monitor
    ;;
  run)
    monitor_loop
    ;;
  run-once)
    run_check
    ;;
  *)
    echo "Usage: scripts/paper-week-monitor.sh <start|stop|status|run|run-once>"
    exit 1
    ;;
esac