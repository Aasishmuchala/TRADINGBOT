@echo off
REM ═══════════════════════════════════════════════════════════════════════
REM install.bat — One-command setup for Crypto Trading Bot on Windows
REM
REM Usage: Right-click → Run as Administrator, or from cmd:
REM   cd crypto-trading-bot
REM   install.bat
REM ═══════════════════════════════════════════════════════════════════════

echo.
echo ===================================================
echo    Crypto Trading Bot — Windows Installer
echo ===================================================
echo.

set "PROJECT_DIR=%~dp0"
REM Remove trailing backslash
if "%PROJECT_DIR:~-1%"=="\" set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"

echo   Project: %PROJECT_DIR%
echo.

REM ── 1. Check prerequisites ─────────────────────────────────────────
echo [1/6] Checking prerequisites...

where docker >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   X Docker not found.
    echo   Install Docker Desktop from: https://www.docker.com/products/docker-desktop/
    pause
    exit /b 1
)
echo   + Docker found

docker info >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   ! Docker Desktop is not running. Starting it...
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe" 2>nul
    echo   Waiting for Docker Desktop to start (this can take 60s)...
    timeout /t 30 /nobreak >nul
    docker info >nul 2>&1
    if %ERRORLEVEL% neq 0 (
        timeout /t 30 /nobreak >nul
        docker info >nul 2>&1
        if %ERRORLEVEL% neq 0 (
            echo   X Docker Desktop failed to start. Please start it manually and re-run.
            pause
            exit /b 1
        )
    )
)
echo   + Docker Desktop is running

docker compose version >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   X Docker Compose not found. Update Docker Desktop.
    pause
    exit /b 1
)
echo   + Docker Compose available
echo.

REM ── 2. Environment file ────────────────────────────────────────────
echo [2/6] Setting up environment...

if not exist "%PROJECT_DIR%\.env" (
    if exist "%PROJECT_DIR%\.env.example" (
        copy "%PROJECT_DIR%\.env.example" "%PROJECT_DIR%\.env" >nul
        echo   ! Created .env from template — add API keys via dashboard Settings
    )
) else (
    echo   + .env file exists
)

if not exist "%PROJECT_DIR%\logs" mkdir "%PROJECT_DIR%\logs"
echo   + Logs directory ready
echo.

REM ── 3. Set PowerShell execution policy ─────────────────────────────
echo [3/6] Configuring PowerShell...

powershell -Command "Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force" 2>nul
echo   + PowerShell execution policy set
echo.

REM ── 4. Register Task Scheduler tasks ───────────────────────────────
echo [4/6] Installing Windows Task Scheduler tasks...

REM Remove existing tasks (ignore errors)
schtasks /Delete /TN "CryptoBot-Launch" /F >nul 2>&1
schtasks /Delete /TN "CryptoBot-HealthCheck" /F >nul 2>&1

REM Create launch task (runs on logon)
schtasks /Create /TN "CryptoBot-Launch" /TR "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%PROJECT_DIR%\scripts\launch.ps1\"" /SC ONLOGON /RL HIGHEST /F >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo   + CryptoBot-Launch: starts bot on login
) else (
    echo   ! CryptoBot-Launch: failed to register (try running as Administrator)
)

REM Create healthcheck task (runs every 5 minutes)
schtasks /Create /TN "CryptoBot-HealthCheck" /TR "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%PROJECT_DIR%\scripts\healthcheck.ps1\"" /SC MINUTE /MO 5 /RL HIGHEST /F >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo   + CryptoBot-HealthCheck: health monitor every 5 min
) else (
    echo   ! CryptoBot-HealthCheck: failed to register (try running as Administrator)
)
echo.

REM ── 5. First launch ────────────────────────────────────────────────
echo [5/6] Starting the bot for the first time...
echo.

powershell -ExecutionPolicy Bypass -File "%PROJECT_DIR%\scripts\launch.ps1"
echo.

REM ── 6. Verify ──────────────────────────────────────────────────────
echo [6/6] Verifying installation...

timeout /t 3 /nobreak >nul

echo.
echo ===================================================
echo    Installation complete!
echo ===================================================
echo.
echo   Dashboard:  http://localhost:3000
echo   Settings:   http://localhost:3000  then click Settings
echo   API:        http://localhost:8000/api/ping
echo   Logs:       %PROJECT_DIR%\logs\
echo.
echo   The bot will:
echo     * Auto-start every time you log into Windows
echo     * Auto-restart crashed containers every 5 minutes
echo     * Send Windows notifications on failures
echo     * Start in Paper Mode (safe — no real trades)
echo.
echo   Next steps:
echo     1. Open http://localhost:3000 and click Settings
echo     2. Paste your Binance API keys
echo     3. Add Bybit + KuCoin keys once verified (48h)
echo     4. Click Test Connection to validate each
echo.
echo   Useful commands:
echo     docker compose logs -f              Live logs
echo     docker compose ps                   Service status
echo     docker compose restart              Restart all
echo     type logs\healthcheck.log           Watchdog history
echo.
echo   To uninstall auto-start:
echo     scripts\uninstall.bat
echo.

pause
