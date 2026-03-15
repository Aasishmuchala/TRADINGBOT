#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# uninstall.sh — Remove LaunchAgents and stop the bot
# ─────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

echo ""
echo "Uninstalling Crypto Trading Bot auto-start..."
echo ""

# Unload LaunchAgents
launchctl unload "$LAUNCH_AGENTS_DIR/com.cryptobot.trading.plist" 2>/dev/null && \
    echo "  ✓ Unloaded com.cryptobot.trading" || echo "  - com.cryptobot.trading was not loaded"

launchctl unload "$LAUNCH_AGENTS_DIR/com.cryptobot.healthcheck.plist" 2>/dev/null && \
    echo "  ✓ Unloaded com.cryptobot.healthcheck" || echo "  - com.cryptobot.healthcheck was not loaded"

# Remove plist files
rm -f "$LAUNCH_AGENTS_DIR/com.cryptobot.trading.plist"
rm -f "$LAUNCH_AGENTS_DIR/com.cryptobot.healthcheck.plist"
echo "  ✓ Removed LaunchAgent files"

echo ""
read -p "Also stop all Docker containers now? (y/N) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    cd "$PROJECT_DIR"
    docker compose down 2>/dev/null || docker-compose down 2>/dev/null || true
    echo "  ✓ All containers stopped"
fi

echo ""
echo "Done. The bot will no longer auto-start on login."
echo "Your data in TimescaleDB and .env file are preserved."
echo "To re-install: ./install.sh"
echo ""
