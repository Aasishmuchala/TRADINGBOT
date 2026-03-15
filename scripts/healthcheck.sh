#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# healthcheck.sh — Runs every 5 minutes via LaunchAgent.
# Checks all Docker containers and restarts any that have exited.
# Also monitors disk space, memory, and Docker health.
# ─────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT_DIR/logs"
LOG_FILE="$LOG_DIR/healthcheck.log"

mkdir -p "$LOG_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

# Rotate log if > 10MB
if [ -f "$LOG_FILE" ] && [ "$(stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)" -gt 10485760 ]; then
    mv "$LOG_FILE" "$LOG_FILE.old"
    log "Log rotated"
fi

# ── 1. Check Docker is running ────────────────────────────────────────
if ! docker info >/dev/null 2>&1; then
    log "ALERT: Docker not running. Attempting to start Docker Desktop..."
    open -a "Docker" 2>/dev/null || true
    sleep 20
    if ! docker info >/dev/null 2>&1; then
        log "CRITICAL: Docker still not running after restart attempt"
        # Send notification via macOS
        osascript -e 'display notification "Docker Desktop is not running! Trading bot is DOWN." with title "Crypto Bot Alert" sound name "Basso"' 2>/dev/null || true
        exit 1
    fi
    log "Docker Desktop restarted successfully"
fi

cd "$PROJECT_DIR"

# ── 2. Check container health ─────────────────────────────────────────
EXITED=$(docker compose ps --format '{{.Name}} {{.State}}' 2>/dev/null | grep -i "exited" || true)

if [ -n "$EXITED" ]; then
    log "ALERT: Found exited containers:"
    echo "$EXITED" | while read -r line; do
        log "  - $line"
    done

    # Restart exited containers
    log "Restarting exited containers..."
    docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null
    sleep 5

    # Verify restart
    STILL_EXITED=$(docker compose ps --format '{{.Name}} {{.State}}' 2>/dev/null | grep -i "exited" || true)
    if [ -n "$STILL_EXITED" ]; then
        log "CRITICAL: Containers still exited after restart:"
        echo "$STILL_EXITED" | while read -r line; do
            log "  - $line"
        done
        osascript -e 'display notification "Some trading bot services failed to restart!" with title "Crypto Bot Alert" sound name "Basso"' 2>/dev/null || true
    else
        log "All containers restarted successfully"
        osascript -e 'display notification "Trading bot services recovered automatically." with title "Crypto Bot" sound name "Pop"' 2>/dev/null || true
    fi
else
    # Count running services
    RUNNING=$(docker compose ps --format '{{.State}}' 2>/dev/null | grep -ci "running" || echo "0")
    log "OK: ${RUNNING} services running"
fi

# ── 3. Check API responsiveness ───────────────────────────────────────
API_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:8000/api/ping 2>/dev/null || echo "000")

if [ "$API_STATUS" != "200" ]; then
    log "WARNING: Dashboard API not responding (HTTP $API_STATUS). Restarting dashboard_api..."
    docker compose restart dashboard_api 2>/dev/null || true
else
    log "OK: Dashboard API healthy"
fi

# ── 4. Check disk space ──────────────────────────────────────────────
DISK_USAGE=$(df -h / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
if [ "$DISK_USAGE" -gt 90 ]; then
    log "WARNING: Disk usage at ${DISK_USAGE}%"
    # Prune old Docker resources
    docker system prune -f --volumes --filter "until=168h" >/dev/null 2>&1 || true
    log "Ran Docker prune to free space"
    osascript -e "display notification \"Disk usage at ${DISK_USAGE}%. Docker cleanup performed.\" with title \"Crypto Bot Alert\" sound name \"Basso\"" 2>/dev/null || true
fi

# ── 5. Check Docker resource usage ───────────────────────────────────
DOCKER_MEM=$(docker stats --no-stream --format '{{.MemUsage}}' 2>/dev/null | head -1 || echo "unknown")
log "Docker memory: $DOCKER_MEM (first container)"

# ── 6. Check Redis connectivity ──────────────────────────────────────
REDIS_PING=$(docker compose exec -T redis redis-cli ping 2>/dev/null || echo "FAIL")
if [ "$REDIS_PING" != "PONG" ]; then
    log "ALERT: Redis not responding. Restarting..."
    docker compose restart redis 2>/dev/null || true
else
    log "OK: Redis healthy"
fi

# ── 7. Check TimescaleDB connectivity ────────────────────────────────
PG_READY=$(docker compose exec -T timescaledb pg_isready -U trader -d trading 2>/dev/null && echo "OK" || echo "FAIL")
if [ "$PG_READY" != "OK" ]; then
    log "ALERT: TimescaleDB not responding. Restarting..."
    docker compose restart timescaledb 2>/dev/null || true
else
    log "OK: TimescaleDB healthy"
fi

log "──────────────────────────────────────────────"
