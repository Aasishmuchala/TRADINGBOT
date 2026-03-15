"""Settings API — Read/write .env configuration from the dashboard."""
import os
import re
from pathlib import Path
from typing import Optional

import structlog
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = structlog.get_logger()
router = APIRouter(prefix="/api/settings", tags=["settings"])

# Path to the .env file (project root)
ENV_PATH = Path(__file__).resolve().parents[3] / ".env"
ENV_EXAMPLE_PATH = Path(__file__).resolve().parents[3] / ".env.example"


# ── Request / Response Models ─────────────────────────────────────────

class ExchangeKeys(BaseModel):
    api_key: str = ""
    api_secret: str = ""
    passphrase: Optional[str] = None  # Only KuCoin needs this


class AlertSettings(BaseModel):
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_pass: str = ""
    alert_email: str = ""


class TradingParams(BaseModel):
    initial_capital: float = 10000.0
    max_leverage: float = 2.0
    daily_drawdown_limit: float = 0.03
    portfolio_heat_limit: float = 0.30
    kelly_fraction: float = 0.5
    per_asset_limit: float = 0.15
    paper_mode: bool = True


class AllSettings(BaseModel):
    binance: ExchangeKeys = ExchangeKeys()
    bybit: ExchangeKeys = ExchangeKeys()
    kucoin: ExchangeKeys = ExchangeKeys()
    alerts: AlertSettings = AlertSettings()
    trading: TradingParams = TradingParams()


class SettingsResponse(BaseModel):
    """Same as AllSettings but with secrets masked."""
    binance: dict
    bybit: dict
    kucoin: dict
    alerts: dict
    trading: dict
    env_file_exists: bool
    status: str


# ── Helpers ───────────────────────────────────────────────────────────

def _mask(value: str) -> str:
    """Mask a secret, showing only the last 4 characters."""
    if not value or len(value) <= 4:
        return "••••" if value else ""
    return "•" * (len(value) - 4) + value[-4:]


def _read_env() -> dict[str, str]:
    """Parse the .env file into a dict."""
    env = {}
    path = ENV_PATH if ENV_PATH.exists() else ENV_EXAMPLE_PATH
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip()
    return env


def _write_env(updates: dict[str, str]):
    """Update the .env file, preserving comments and structure."""
    # If .env doesn't exist, copy from .env.example
    if not ENV_PATH.exists():
        if ENV_EXAMPLE_PATH.exists():
            ENV_PATH.write_text(ENV_EXAMPLE_PATH.read_text())
        else:
            ENV_PATH.write_text("")

    lines = ENV_PATH.read_text().splitlines()
    existing_keys = set()
    new_lines = []

    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key = stripped.split("=", 1)[0].strip()
            if key in updates:
                new_lines.append(f"{key}={updates[key]}")
                existing_keys.add(key)
            else:
                new_lines.append(line)
        else:
            new_lines.append(line)

    # Append any new keys that weren't already in the file
    for key, value in updates.items():
        if key not in existing_keys:
            new_lines.append(f"{key}={value}")

    ENV_PATH.write_text("\n".join(new_lines) + "\n")
    logger.info("settings.env_updated", keys=list(updates.keys()))


# ── Endpoints ─────────────────────────────────────────────────────────

@router.get("", response_model=SettingsResponse)
async def get_settings():
    """Get all settings with secrets masked."""
    env = _read_env()

    SECRET_KEYS = {
        "BINANCE_API_KEY", "BINANCE_API_SECRET",
        "BYBIT_API_KEY", "BYBIT_API_SECRET",
        "KUCOIN_API_KEY", "KUCOIN_API_SECRET", "KUCOIN_PASSPHRASE",
        "TELEGRAM_BOT_TOKEN", "SMTP_PASS",
    }

    return SettingsResponse(
        binance={
            "api_key": _mask(env.get("BINANCE_API_KEY", "")),
            "api_secret": _mask(env.get("BINANCE_API_SECRET", "")),
            "has_key": bool(env.get("BINANCE_API_KEY")),
            "has_secret": bool(env.get("BINANCE_API_SECRET")),
        },
        bybit={
            "api_key": _mask(env.get("BYBIT_API_KEY", "")),
            "api_secret": _mask(env.get("BYBIT_API_SECRET", "")),
            "has_key": bool(env.get("BYBIT_API_KEY")),
            "has_secret": bool(env.get("BYBIT_API_SECRET")),
        },
        kucoin={
            "api_key": _mask(env.get("KUCOIN_API_KEY", "")),
            "api_secret": _mask(env.get("KUCOIN_API_SECRET", "")),
            "passphrase": _mask(env.get("KUCOIN_PASSPHRASE", "")),
            "has_key": bool(env.get("KUCOIN_API_KEY")),
            "has_secret": bool(env.get("KUCOIN_API_SECRET")),
            "has_passphrase": bool(env.get("KUCOIN_PASSPHRASE")),
        },
        alerts={
            "telegram_bot_token": _mask(env.get("TELEGRAM_BOT_TOKEN", "")),
            "telegram_chat_id": env.get("TELEGRAM_CHAT_ID", ""),
            "smtp_host": env.get("SMTP_HOST", ""),
            "smtp_port": int(env.get("SMTP_PORT", "587")),
            "smtp_user": env.get("SMTP_USER", ""),
            "smtp_pass": _mask(env.get("SMTP_PASS", "")),
            "alert_email": env.get("ALERT_EMAIL", ""),
        },
        trading={
            "initial_capital": float(env.get("INITIAL_CAPITAL", "10000")),
            "max_leverage": float(env.get("MAX_LEVERAGE", "2.0")),
            "daily_drawdown_limit": float(env.get("DAILY_DRAWDOWN_LIMIT", "0.03")),
            "portfolio_heat_limit": float(env.get("PORTFOLIO_HEAT_LIMIT", "0.30")),
            "kelly_fraction": float(env.get("KELLY_FRACTION", "0.5")),
            "per_asset_limit": float(env.get("PER_ASSET_LIMIT", "0.15")),
            "paper_mode": env.get("PAPER_MODE", "true").lower() == "true",
        },
        env_file_exists=ENV_PATH.exists(),
        status="ok",
    )


@router.post("/exchange/{exchange_name}")
async def update_exchange_keys(exchange_name: str, keys: ExchangeKeys):
    """Update API keys for a specific exchange."""
    exchange_name = exchange_name.lower()
    prefix_map = {
        "binance": "BINANCE",
        "bybit": "BYBIT",
        "kucoin": "KUCOIN",
    }

    if exchange_name not in prefix_map:
        raise HTTPException(status_code=400, detail=f"Unknown exchange: {exchange_name}")

    prefix = prefix_map[exchange_name]
    updates = {}

    if keys.api_key:
        updates[f"{prefix}_API_KEY"] = keys.api_key
    if keys.api_secret:
        updates[f"{prefix}_API_SECRET"] = keys.api_secret
    if keys.passphrase is not None and exchange_name == "kucoin":
        updates[f"{prefix}_PASSPHRASE"] = keys.passphrase

    if not updates:
        raise HTTPException(status_code=400, detail="No keys provided")

    _write_env(updates)
    return {
        "status": "saved",
        "exchange": exchange_name,
        "keys_updated": list(updates.keys()),
        "note": "Restart the bot services to apply new keys (docker-compose restart)",
    }


@router.post("/alerts")
async def update_alerts(alerts: AlertSettings):
    """Update alert/notification settings."""
    updates = {}
    if alerts.telegram_bot_token:
        updates["TELEGRAM_BOT_TOKEN"] = alerts.telegram_bot_token
    if alerts.telegram_chat_id:
        updates["TELEGRAM_CHAT_ID"] = alerts.telegram_chat_id
    if alerts.smtp_host:
        updates["SMTP_HOST"] = alerts.smtp_host
    updates["SMTP_PORT"] = str(alerts.smtp_port)
    if alerts.smtp_user:
        updates["SMTP_USER"] = alerts.smtp_user
    if alerts.smtp_pass:
        updates["SMTP_PASS"] = alerts.smtp_pass
    if alerts.alert_email:
        updates["ALERT_EMAIL"] = alerts.alert_email

    _write_env(updates)
    return {"status": "saved", "keys_updated": list(updates.keys())}


@router.post("/trading")
async def update_trading(params: TradingParams):
    """Update trading parameters."""
    updates = {
        "INITIAL_CAPITAL": str(params.initial_capital),
        "MAX_LEVERAGE": str(params.max_leverage),
        "DAILY_DRAWDOWN_LIMIT": str(params.daily_drawdown_limit),
        "PORTFOLIO_HEAT_LIMIT": str(params.portfolio_heat_limit),
        "KELLY_FRACTION": str(params.kelly_fraction),
        "PER_ASSET_LIMIT": str(params.per_asset_limit),
        "PAPER_MODE": str(params.paper_mode).lower(),
    }

    _write_env(updates)
    return {"status": "saved", "keys_updated": list(updates.keys())}


@router.post("/test-connection/{exchange_name}")
async def test_exchange_connection(exchange_name: str):
    """Test if exchange API keys are valid by making a simple API call."""
    import ccxt.async_support as ccxt

    exchange_name = exchange_name.lower()
    env = _read_env()

    creds = {}
    if exchange_name == "binance":
        creds = {
            "apiKey": env.get("BINANCE_API_KEY", ""),
            "secret": env.get("BINANCE_API_SECRET", ""),
        }
        exchange = ccxt.binance(creds)
    elif exchange_name == "bybit":
        creds = {
            "apiKey": env.get("BYBIT_API_KEY", ""),
            "secret": env.get("BYBIT_API_SECRET", ""),
        }
        exchange = ccxt.bybit(creds)
    elif exchange_name == "kucoin":
        creds = {
            "apiKey": env.get("KUCOIN_API_KEY", ""),
            "secret": env.get("KUCOIN_API_SECRET", ""),
            "password": env.get("KUCOIN_PASSPHRASE", ""),
        }
        exchange = ccxt.kucoin(creds)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown exchange: {exchange_name}")

    if not creds.get("apiKey"):
        return {"exchange": exchange_name, "connected": False, "error": "No API key configured"}

    try:
        exchange.enableRateLimit = True
        exchange.timeout = 10000
        balance = await exchange.fetch_balance()
        await exchange.close()
        usdt_balance = balance.get("USDT", {}).get("total", 0)
        return {
            "exchange": exchange_name,
            "connected": True,
            "usdt_balance": usdt_balance,
            "status": "API keys are valid",
        }
    except Exception as e:
        try:
            await exchange.close()
        except Exception:
            pass
        return {
            "exchange": exchange_name,
            "connected": False,
            "error": str(e),
        }
