use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RuntimeMode {
    Research,
    Backtest,
    Replay,
    Paper,
    SemiAuto,
    FullAuto,
    Protected,
    Halted,
}

impl RuntimeMode {
    pub fn allows_live_orders(self) -> bool {
        matches!(self, Self::SemiAuto | Self::FullAuto)
    }

    pub fn is_operator_safe(self) -> bool {
        matches!(
            self,
            Self::Research | Self::Backtest | Self::Replay | Self::Paper | Self::Protected | Self::Halted
        )
    }
}

impl fmt::Display for RuntimeMode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Research => write!(formatter, "Research"),
            Self::Backtest => write!(formatter, "Backtest"),
            Self::Replay => write!(formatter, "Replay"),
            Self::Paper => write!(formatter, "Paper"),
            Self::SemiAuto => write!(formatter, "SemiAuto"),
            Self::FullAuto => write!(formatter, "FullAuto"),
            Self::Protected => write!(formatter, "Protected"),
            Self::Halted => write!(formatter, "Halted"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MarketRegime {
    Trending,
    Ranging,
    BreakoutExpansion,
    VolatilityCompression,
    ReversalAttempt,
    Disordered,
    NoTrade,
}

impl fmt::Display for MarketRegime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Trending => write!(formatter, "Trending"),
            Self::Ranging => write!(formatter, "Ranging"),
            Self::BreakoutExpansion => write!(formatter, "BreakoutExpansion"),
            Self::VolatilityCompression => write!(formatter, "VolatilityCompression"),
            Self::ReversalAttempt => write!(formatter, "ReversalAttempt"),
            Self::Disordered => write!(formatter, "Disordered"),
            Self::NoTrade => write!(formatter, "NoTrade"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TradeDecision {
    Approve,
    Reject,
    Watch,
    PaperTest,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RegimeAssessment {
    pub regime: MarketRegime,
    pub confidence: f32,
}

impl RegimeAssessment {
    pub fn new(regime: MarketRegime, confidence: f32) -> Result<Self, DomainError> {
        if !(0.0..=1.0).contains(&confidence) {
            return Err(DomainError::InvalidConfidence(confidence));
        }

        Ok(Self { regime, confidence })
    }

    /// Creates a `RegimeAssessment` clamping `confidence` to `[0.0, 1.0]`.
    /// Use this when the confidence value has already been bounded but floating-point
    /// arithmetic may have introduced a marginal out-of-range result.
    pub fn new_clamped(regime: MarketRegime, confidence: f32) -> Self {
        Self {
            regime,
            confidence: confidence.clamp(0.0, 1.0),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RiskLimits {
    pub max_risk_per_trade_bps: u16,
    pub min_model_confidence_bps: u16,
    pub max_daily_drawdown_bps: u16,
    pub max_weekly_drawdown_bps: u16,
    pub max_monthly_drawdown_bps: u16,
    pub max_leverage: u8,
    pub max_concurrent_positions: u8,
}

impl RiskLimits {
    pub fn validate(&self) -> Result<(), DomainError> {
        if self.max_risk_per_trade_bps == 0 {
            return Err(DomainError::InvalidRiskRule("max_risk_per_trade_bps"));
        }
        if self.min_model_confidence_bps == 0 || self.min_model_confidence_bps > 10_000 {
            return Err(DomainError::InvalidRiskRule("min_model_confidence_bps"));
        }
        if self.max_daily_drawdown_bps == 0
            || self.max_weekly_drawdown_bps == 0
            || self.max_monthly_drawdown_bps == 0
        {
            return Err(DomainError::InvalidRiskRule("drawdown_bps"));
        }
        if self.max_leverage == 0 {
            return Err(DomainError::InvalidRiskRule("max_leverage"));
        }
        if self.max_concurrent_positions == 0 {
            return Err(DomainError::InvalidRiskRule("max_concurrent_positions"));
        }

        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Symbol(pub String);

impl Symbol {
    pub fn new(value: impl Into<String>) -> Result<Self, DomainError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(DomainError::EmptySymbol);
        }
        Ok(Self(value))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OrderIntent {
    pub symbol: Symbol,
    pub mode: RuntimeMode,
    pub decision: TradeDecision,
    pub size_usd: f64,
}

impl OrderIntent {
    pub fn validate(&self) -> Result<(), DomainError> {
        if self.size_usd <= 0.0 {
            return Err(DomainError::InvalidOrderSize(self.size_usd));
        }

        if self.mode == RuntimeMode::FullAuto && self.decision != TradeDecision::Approve {
            return Err(DomainError::InvalidDecisionFlow);
        }

        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum DomainError {
    EmptySymbol,
    InvalidConfidence(f32),
    InvalidDecisionFlow,
    InvalidOrderSize(f64),
    InvalidRiskRule(&'static str),
}

impl fmt::Display for DomainError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptySymbol => write!(formatter, "symbol cannot be empty"),
            Self::InvalidConfidence(value) => write!(formatter, "confidence out of bounds: {value}"),
            Self::InvalidDecisionFlow => write!(formatter, "invalid decision flow for runtime mode"),
            Self::InvalidOrderSize(value) => write!(formatter, "invalid order size: {value}"),
            Self::InvalidRiskRule(rule) => write!(formatter, "invalid risk rule: {rule}"),
        }
    }
}

impl std::error::Error for DomainError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_confidence() {
        let assessment = RegimeAssessment::new(MarketRegime::Trending, 1.2);
        assert!(matches!(assessment, Err(DomainError::InvalidConfidence(_))));
    }

    #[test]
    fn validates_risk_limits() {
        let limits = RiskLimits {
            max_risk_per_trade_bps: 50,
            min_model_confidence_bps: 6200,
            max_daily_drawdown_bps: 200,
            max_weekly_drawdown_bps: 500,
            max_monthly_drawdown_bps: 1000,
            max_leverage: 5,
            max_concurrent_positions: 3,
        };

        assert!(limits.validate().is_ok());
    }

    #[test]
    fn rejects_full_auto_without_approval() {
        let symbol = Symbol::new("BTCUSDT").expect("valid symbol");
        let intent = OrderIntent {
            symbol,
            mode: RuntimeMode::FullAuto,
            decision: TradeDecision::Watch,
            size_usd: 100.0,
        };

        assert!(matches!(intent.validate(), Err(DomainError::InvalidDecisionFlow)));
    }

    #[test]
    fn new_clamped_clamps_out_of_range_confidence() {
        let assessment = RegimeAssessment::new_clamped(MarketRegime::Ranging, 1.5);
        assert_eq!(assessment.confidence, 1.0);

        let assessment = RegimeAssessment::new_clamped(MarketRegime::Ranging, -0.5);
        assert_eq!(assessment.confidence, 0.0);
    }

    #[test]
    fn runtime_mode_display() {
        assert_eq!(RuntimeMode::Paper.to_string(), "Paper");
        assert_eq!(RuntimeMode::FullAuto.to_string(), "FullAuto");
        assert_eq!(RuntimeMode::Halted.to_string(), "Halted");
    }

    #[test]
    fn market_regime_display() {
        assert_eq!(MarketRegime::Trending.to_string(), "Trending");
        assert_eq!(MarketRegime::NoTrade.to_string(), "NoTrade");
        assert_eq!(MarketRegime::BreakoutExpansion.to_string(), "BreakoutExpansion");
    }
}
