#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# install.sh — One-command setup for the Crypto Trading Bot on macOS
#
# Usage:
#   cd crypto-trading-bot
#   chmod +x install.sh && ./install.sh
#
# What this does:
#   1. Checks prerequisites (Docker Desktop, docker compose)
#   2. Creates .env from template if missing
#   3. Makes scripts executable
#   4. Installs two macOS LaunchAgents:
#      - com.cryptobot.trading     → Starts bot on login
#      - com.cryptobot.healthcheck → Health monitor every 5 min
#   5. Starts the bot immediately
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

echo ""
echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════${NC}"
echo -e "${CYAN}${BOLD}   Crypto Trading Bot — macOS Installer${NC}"
echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Project: ${BLUE}$PROJECT_DIR${NC}"
echo ""

# ── 1. Check prerequisites ────────────────────────────────────────────
echo -e "${BOLD}[1/6] Checking prerequisites...${NC}"

# Docker
if ! command -v docker &>/dev/null; then
    echo -e "${RED}✗ Docker not found.${NC}"
    echo "  Install Docker Desktop from: https://www.docker.com/products/docker-desktop/"
    echo "  After installing, open Docker Desktop and complete the setup."
    exit 1
fi
echo -e "  ${GREEN}✓${NC} Docker found: $(docker --version | head -1)"

# Docker running?
if docker info >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} Docker Desktop is running"
else
    echo -e "  ${YELLOW}⚠${NC} Docker Desktop is not running. Starting it..."
    open -a "Docker" 2>/dev/null || true
    echo "  Waiting for Docker Desktop to start (this can take 30-60s)..."
    WAITED=0
    while ! docker info >/dev/null 2>&1; do
        sleep 3
        WAITED=$((WAITED + 3))
        if [ $WAITED -ge 90 ]; then
            echo -e "  ${RED}✗ Docker Desktop failed to start. Please start it manually and re-run this script.${NC}"
            exit 1
        fi
    done
    echo -e "  ${GREEN}✓${NC} Docker Desktop started (took ${WAITED}s)"
fi

# Docker Compose
if docker compose version >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} Docker Compose: $(docker compose version --short 2>/dev/null || echo 'available')"
elif command -v docker-compose &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} docker-compose: $(docker-compose --version | head -1)"
else
    echo -e "${RED}✗ Neither 'docker compose' nor 'docker-compose' found.${NC}"
    echo "  Update Docker Desktop to get the compose plugin."
    exit 1
fi

echo ""

# ── 2. Environment file ──────────────────────────────────────────────
echo -e "${BOLD}[2/6] Setting up environment...${NC}"

if [ -f "$PROJECT_DIR/.env" ]; then
    echo -e "  ${GREEN}✓${NC} .env file exists"
else
    cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
    echo -e "  ${YELLOW}⚠${NC} Created .env from template"
    echo -e "  ${YELLOW}  → Add your API keys via the dashboard Settings page (http://localhost:3000)${NC}"
fi

mkdir -p "$PROJECT_DIR/logs"
echo -e "  ${GREEN}✓${NC} Logs directory ready"
echo ""

# ── 3. Make scripts executable ────────────────────────────────────────
echo -e "${BOLD}[3/6] Preparing scripts...${NC}"

chmod +x "$PROJECT_DIR/scripts/launch.sh"
chmod +x "$PROJECT_DIR/scripts/healthcheck.sh"
echo -e "  ${GREEN}✓${NC} Scripts are executable"
echo ""

# ── 4. Install LaunchAgents ───────────────────────────────────────────
echo -e "${BOLD}[4/6] Installing macOS LaunchAgents...${NC}"

mkdir -p "$LAUNCH_AGENTS_DIR"

# Unload existing agents if present (ignore errors)
launchctl unload "$LAUNCH_AGENTS_DIR/com.cryptobot.trading.plist" 2>/dev/null || true
launchctl unload "$LAUNCH_AGENTS_DIR/com.cryptobot.healthcheck.plist" 2>/dev/null || true

# Copy plists with correct project path
sed "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
    "$PROJECT_DIR/scripts/com.cryptobot.trading.plist" \
    > "$LAUNCH_AGENTS_DIR/com.cryptobot.trading.plist"

sed "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
    "$PROJECT_DIR/scripts/com.cryptobot.healthcheck.plist" \
    > "$LAUNCH_AGENTS_DIR/com.cryptobot.healthcheck.plist"

echo -e "  ${GREEN}✓${NC} com.cryptobot.trading     → Starts bot on login"
echo -e "  ${GREEN}✓${NC} com.cryptobot.healthcheck → Health check every 5 min"

# Load the agents
launchctl load "$LAUNCH_AGENTS_DIR/com.cryptobot.trading.plist"
launchctl load "$LAUNCH_AGENTS_DIR/com.cryptobot.healthcheck.plist"

echo -e "  ${GREEN}✓${NC} LaunchAgents loaded"
echo ""

# ── 5. First launch ──────────────────────────────────────────────────
echo -e "${BOLD}[5/6] Starting the bot for the first time...${NC}"
echo ""

bash "$PROJECT_DIR/scripts/launch.sh"
echo ""

# ── 6. Verify ─────────────────────────────────────────────────────────
echo -e "${BOLD}[6/6] Verifying installation...${NC}"

sleep 3

# Check API
API_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://localhost:8000/api/ping 2>/dev/null || echo "000")

if [ "$API_STATUS" = "200" ]; then
    echo -e "  ${GREEN}✓${NC} Dashboard API responding"
else
    echo -e "  ${YELLOW}⚠${NC} Dashboard API not yet responding (may need a few more seconds)"
fi

# Check container count
RUNNING=$(docker compose ps --format '{{.State}}' 2>/dev/null | grep -ci "running" || echo "0")
echo -e "  ${GREEN}✓${NC} ${RUNNING} Docker containers running"

echo ""
echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}   Installation complete!${NC}"
echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}Dashboard:${NC}  ${BLUE}http://localhost:3000${NC}"
echo -e "  ${BOLD}Settings:${NC}   ${BLUE}http://localhost:3000${NC} → ⚙ Settings"
echo -e "  ${BOLD}API:${NC}        ${BLUE}http://localhost:8000/api/ping${NC}"
echo -e "  ${BOLD}Logs:${NC}       ${BLUE}$PROJECT_DIR/logs/${NC}"
echo ""
echo -e "  ${BOLD}The bot will:${NC}"
echo -e "    • Auto-start every time you log into your Mac"
echo -e "    • Auto-restart crashed containers every 5 minutes"
echo -e "    • Send macOS notifications on failures"
echo -e "    • Start in ${GREEN}Paper Mode${NC} (safe — no real trades)"
echo ""
echo -e "  ${BOLD}Next steps:${NC}"
echo -e "    1. Open ${BLUE}http://localhost:3000${NC} → ⚙ Settings"
echo -e "    2. Paste your Binance API keys"
echo -e "    3. Add Bybit + KuCoin keys once verified (48h)"
echo -e "    4. Click 'Test Connection' to validate each"
echo ""
echo -e "  ${BOLD}Useful commands:${NC}"
echo -e "    ${CYAN}docker compose logs -f${NC}              # Live logs"
echo -e "    ${CYAN}docker compose ps${NC}                   # Service status"
echo -e "    ${CYAN}docker compose restart${NC}              # Restart all"
echo -e "    ${CYAN}cat logs/healthcheck.log${NC}            # Watchdog history"
echo ""
echo -e "  ${BOLD}To uninstall auto-start:${NC}"
echo -e "    ${CYAN}bash $PROJECT_DIR/scripts/uninstall.sh${NC}"
echo ""
