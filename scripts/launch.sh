#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# launch.sh — Start the crypto trading bot (Docker Compose)
# Called by macOS LaunchAgent on login, or manually.
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT_DIR/logs"
TIMESTAMP=$(date '+%Y-%m-%d_%H-%M-%S')

mkdir -p "$LOG_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_DIR/launch.log"; }

# ── 1. Wait for Docker Desktop to be ready ────────────────────────────
log "Waiting for Docker Desktop..."

MAX_WAIT=120  # seconds
WAITED=0
while ! docker info >/dev/null 2>&1; do
    if [ $WAITED -ge $MAX_WAIT ]; then
        log "ERROR: Docker Desktop not ready after ${MAX_WAIT}s. Attempting to start it..."
        open -a "Docker" 2>/dev/null || true
        sleep 15
        if ! docker info >/dev/null 2>&1; then
            log "FATAL: Docker Desktop still not available. Exiting."
            exit 1
        fi
    fi
    sleep 3
    WAITED=$((WAITED + 3))
done
log "Docker Desktop is ready (waited ${WAITED}s)"

# ── 2. Navigate to project ────────────────────────────────────────────
cd "$PROJECT_DIR"

# ── 3. Ensure .env exists ─────────────────────────────────────────────
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example .env
        log "Created .env from .env.example — add your API keys via the dashboard Settings page"
    else
        log "WARNING: No .env or .env.example found"
    fi
fi

# ── 4. Pull latest images (skip on first launch if slow) ─────────────
log "Pulling Docker images..."
docker compose pull --quiet 2>/dev/null || docker-compose pull --quiet 2>/dev/null || true

# ── 5. Start infrastructure first ─────────────────────────────────────
log "Starting infrastructure (Redis + TimescaleDB)..."
docker compose up -d redis timescaledb 2>/dev/null || docker-compose up -d redis timescaledb

# Wait for TimescaleDB to accept connections
log "Waiting for TimescaleDB to be ready..."
WAITED=0
while ! docker compose exec -T timescaledb pg_isready -U trader -d trading >/dev/null 2>&1; do
    sleep 2
    WAITED=$((WAITED + 2))
    if [ $WAITED -ge 60 ]; then
        log "WARNING: TimescaleDB slow to start, proceeding anyway..."
        break
    fi
done
log "TimescaleDB ready (waited ${WAITED}s)"

# ── 6. Run migrations (idempotent) ───────────────────────────────────
log "Running database migrations..."
docker compose exec -T timescaledb psql -U trader -d trading \
    -f /migrations/001_initial_schema.sql 2>/dev/null || true

# ── 7. Start all services ─────────────────────────────────────────────
log "Starting all services..."
docker compose up -d 2>/dev/null || docker-compose up -d

# ── 8. Verify ─────────────────────────────────────────────────────────
sleep 5
RUNNING=$(docker compose ps --format '{{.State}}' 2>/dev/null | grep -c "running" || echo "0")
TOTAL=$(docker compose ps --format '{{.State}}' 2>/dev/null | wc -l | tr -d ' ' || echo "0")

log "Bot started: ${RUNNING}/${TOTAL} services running"
log "Dashboard: http://localhost:3000"
log "API: http://localhost:8000/api/ping"
log "──────────────────────────────────────────────"
