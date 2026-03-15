@echo off
REM ─────────────────────────────────────────────────────────────────────
REM uninstall.bat — Remove Task Scheduler tasks and stop the bot
REM ─────────────────────────────────────────────────────────────────────

echo.
echo Uninstalling Crypto Trading Bot auto-start...
echo.

schtasks /Delete /TN "CryptoBot-Launch" /F >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo   + Removed CryptoBot-Launch task
) else (
    echo   - CryptoBot-Launch was not registered
)

schtasks /Delete /TN "CryptoBot-HealthCheck" /F >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo   + Removed CryptoBot-HealthCheck task
) else (
    echo   - CryptoBot-HealthCheck was not registered
)

echo.
set /p STOP="Also stop all Docker containers now? (y/N): "
if /i "%STOP%"=="y" (
    cd /d "%~dp0\.."
    docker compose down 2>nul
    echo   + All containers stopped
)

echo.
echo Done. The bot will no longer auto-start on login.
echo Your data in TimescaleDB and .env file are preserved.
echo To re-install: install.bat
echo.

pause
