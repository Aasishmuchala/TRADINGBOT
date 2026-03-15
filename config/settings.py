from pydantic_settings import BaseSettings
from pydantic import Field
from typing import Optional


class Settings(BaseSettings):
    """Central configuration for crypto trading bot using environment variables."""
    
    # Exchange API keys
    binance_api_key: str = Field(default="", alias="BINANCE_API_KEY")
    binance_api_secret: str = Field(default="", alias="BINANCE_API_SECRET")
    bybit_api_key: str = Field(default="", alias="BYBIT_API_KEY")
    bybit_api_secret: str = Field(default="", alias="BYBIT_API_SECRET")
    kucoin_api_key: str = Field(default="", alias="KUCOIN_API_KEY")
    kucoin_api_secret: str = Field(default="", alias="KUCOIN_API_SECRET")
    kucoin_passphrase: str = Field(default="", alias="KUCOIN_PASSPHRASE")
    
    # Infrastructure
    redis_url: str = Field(default="redis://redis:6379/0", alias="REDIS_URL")
    database_url: str = Field(
        default="postgresql://trader:trader@timescaledb:5432/trading",
        alias="DATABASE_URL"
    )
    
    # Trading parameters
    initial_capital: float = Field(default=10000.0, alias="INITIAL_CAPITAL")
    max_leverage: float = Field(default=2.0, alias="MAX_LEVERAGE")
    daily_drawdown_limit: float = Field(default=0.03, alias="DAILY_DRAWDOWN_LIMIT")
    portfolio_heat_limit: float = Field(default=0.30, alias="PORTFOLIO_HEAT_LIMIT")
    kelly_fraction: float = Field(default=0.5, alias="KELLY_FRACTION")
    per_asset_limit: float = Field(default=0.15, alias="PER_ASSET_LIMIT")
    
    # Mode and logging
    paper_mode: bool = Field(default=True, alias="PAPER_MODE")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    
    # Notifications
    telegram_bot_token: Optional[str] = Field(default=None, alias="TELEGRAM_BOT_TOKEN")
    telegram_chat_id: Optional[str] = Field(default=None, alias="TELEGRAM_CHAT_ID")
    
    # Email alerts
    smtp_host: Optional[str] = Field(default=None, alias="SMTP_HOST")
    smtp_port: int = Field(default=587, alias="SMTP_PORT")
    smtp_user: Optional[str] = Field(default=None, alias="SMTP_USER")
    smtp_pass: Optional[str] = Field(default=None, alias="SMTP_PASS")
    alert_email: Optional[str] = Field(default=None, alias="ALERT_EMAIL")
    
    class Config:
        env_file = ".env"
        case_sensitive = False


# Global settings instance
settings = Settings()