@echo off
REM ─────────────────────────────────────────────────────────────────────
REM stop.bat — Gracefully stop all bot services (keeps auto-start active)
REM ─────────────────────────────────────────────────────────────────────

cd /d "%~dp0\.."
echo Stopping all services...
docker compose down 2>nul
echo + All services stopped
echo.
echo Note: The bot will auto-restart on next login.
echo To permanently disable auto-start: scripts\uninstall.bat

pause
