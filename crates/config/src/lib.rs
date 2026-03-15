use sthyra_domain::{RiskLimits, RuntimeMode};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExchangeConfig {
    pub exchange_name: String,
    pub primary_symbols: Vec<String>,
    pub use_testnet: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchdogConfig {
    pub heartbeat_timeout_secs: u64,
    pub max_restart_attempts: u8,
    pub stale_feed_timeout_secs: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AppConfig {
    pub mode: RuntimeMode,
    pub exchange: ExchangeConfig,
    pub risk_limits: RiskLimits,
    pub watchdog: WatchdogConfig,
}

impl AppConfig {
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.exchange.exchange_name.trim() != "binance" {
            return Err(ConfigError::UnsupportedExchange);
        }

        if self.exchange.primary_symbols.is_empty() {
            return Err(ConfigError::MissingSymbols);
        }

        self.risk_limits.validate().map_err(ConfigError::Domain)?;

        if self.watchdog.heartbeat_timeout_secs == 0 || self.watchdog.stale_feed_timeout_secs == 0 {
            return Err(ConfigError::InvalidWatchdogThreshold);
        }

        Ok(())
    }
}

#[derive(Debug)]
pub enum ConfigError {
    Domain(sthyra_domain::DomainError),
    InvalidWatchdogThreshold,
    MissingSymbols,
    UnsupportedExchange,
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Domain(error) => write!(formatter, "domain config error: {error}"),
            Self::InvalidWatchdogThreshold => write!(formatter, "watchdog thresholds must be greater than zero"),
            Self::MissingSymbols => write!(formatter, "at least one trading symbol is required"),
            Self::UnsupportedExchange => write!(formatter, "only Binance is supported in V1"),
        }
    }
}

impl std::error::Error for ConfigError {}

pub fn default_local_config() -> AppConfig {
    AppConfig {
        mode: RuntimeMode::Paper,
        exchange: ExchangeConfig {
            exchange_name: "binance".to_string(),
            primary_symbols: vec![
                "BTCUSDT".to_string(),
                "ETHUSDT".to_string(),
                "SOLUSDT".to_string(),
                "BNBUSDT".to_string(),
                "XRPUSDT".to_string(),
                "DOGEUSDT".to_string(),
                "ADAUSDT".to_string(),
                "AVAXUSDT".to_string(),
                "LINKUSDT".to_string(),
                "DOTUSDT".to_string(),
            ],
            use_testnet: true,
        },
        risk_limits: RiskLimits {
            max_risk_per_trade_bps: 50,
            min_model_confidence_bps: 6200,
            max_daily_drawdown_bps: 200,
            max_weekly_drawdown_bps: 500,
            max_monthly_drawdown_bps: 1000,
            max_leverage: 5,
            max_concurrent_positions: 3,
        },
        watchdog: WatchdogConfig {
            heartbeat_timeout_secs: 5,
            max_restart_attempts: 3,
            stale_feed_timeout_secs: 15,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_is_valid() {
        assert!(default_local_config().validate().is_ok());
    }
}
