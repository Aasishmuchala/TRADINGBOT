#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# stop.sh — Gracefully stop all bot services (keeps auto-start active)
# ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"
echo "Stopping all services..."
docker compose down 2>/dev/null || docker-compose down 2>/dev/null
echo "✓ All services stopped"
echo ""
echo "Note: The bot will auto-restart on next login."
echo "To permanently disable auto-start: bash scripts/uninstall.sh"
