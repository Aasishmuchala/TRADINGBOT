use sthyra_domain::{MarketRegime, OrderIntent, RiskLimits, RuntimeMode, TradeDecision};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RiskSnapshot {
    pub regime: MarketRegime,
    pub daily_drawdown_bps: u16,
    pub weekly_drawdown_bps: u16,
    pub monthly_drawdown_bps: u16,
    pub active_positions: u8,
    pub current_leverage: u8,
    pub health_degraded: bool,
    pub model_confidence: f64,
    pub expected_value_score: f64,
    pub news_risk_off: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RiskRejection {
    DegradedHealth,
    DisallowedRegime(MarketRegime),
    DrawdownLimitReached,
    LiveTradingDisabled(RuntimeMode),
    MaxConcurrentPositions,
    MaxLeverageExceeded,
    NegativeExpectedValue,
    NonApprovedDecision,
    RiskOffNews,
    WeakModelConfidence,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RiskOutcome {
    Approved,
    Rejected(RiskRejection),
}

pub struct RiskGate {
    limits: RiskLimits,
}

impl RiskGate {
    pub fn new(limits: RiskLimits) -> Result<Self, sthyra_domain::DomainError> {
        limits.validate()?;
        Ok(Self { limits })
    }

    pub fn evaluate(&self, intent: &OrderIntent, snapshot: RiskSnapshot) -> RiskOutcome {
        if snapshot.health_degraded {
            return RiskOutcome::Rejected(RiskRejection::DegradedHealth);
        }

        if matches!(snapshot.regime, MarketRegime::NoTrade | MarketRegime::Disordered) {
            return RiskOutcome::Rejected(RiskRejection::DisallowedRegime(snapshot.regime));
        }

        if snapshot.news_risk_off {
            return RiskOutcome::Rejected(RiskRejection::RiskOffNews);
        }

        if !matches!(intent.mode, RuntimeMode::Paper | RuntimeMode::SemiAuto | RuntimeMode::FullAuto) {
            return RiskOutcome::Rejected(RiskRejection::LiveTradingDisabled(intent.mode));
        }

        if intent.decision != TradeDecision::Approve {
            return RiskOutcome::Rejected(RiskRejection::NonApprovedDecision);
        }

        if snapshot.model_confidence * 10_000.0 < self.limits.min_model_confidence_bps as f64 {
            return RiskOutcome::Rejected(RiskRejection::WeakModelConfidence);
        }

        if snapshot.expected_value_score <= 0.0 {
            return RiskOutcome::Rejected(RiskRejection::NegativeExpectedValue);
        }

        if snapshot.daily_drawdown_bps >= self.limits.max_daily_drawdown_bps
            || snapshot.weekly_drawdown_bps >= self.limits.max_weekly_drawdown_bps
            || snapshot.monthly_drawdown_bps >= self.limits.max_monthly_drawdown_bps
        {
            return RiskOutcome::Rejected(RiskRejection::DrawdownLimitReached);
        }

        if snapshot.active_positions >= self.limits.max_concurrent_positions {
            return RiskOutcome::Rejected(RiskRejection::MaxConcurrentPositions);
        }

        if snapshot.current_leverage > self.limits.max_leverage {
            return RiskOutcome::Rejected(RiskRejection::MaxLeverageExceeded);
        }

        RiskOutcome::Approved
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sthyra_domain::{Symbol, TradeDecision};

    fn risk_gate() -> RiskGate {
        RiskGate::new(RiskLimits {
            max_risk_per_trade_bps: 50,
            min_model_confidence_bps: 6200,
            max_daily_drawdown_bps: 200,
            max_weekly_drawdown_bps: 500,
            max_monthly_drawdown_bps: 1000,
            max_leverage: 5,
            max_concurrent_positions: 3,
        })
        .expect("risk limits should be valid")
    }

    fn approved_intent(mode: RuntimeMode) -> OrderIntent {
        OrderIntent {
            symbol: Symbol::new("BTCUSDT").expect("valid symbol"),
            mode,
            decision: TradeDecision::Approve,
            size_usd: 100.0,
        }
    }

    fn healthy_snapshot() -> RiskSnapshot {
        RiskSnapshot {
            regime: MarketRegime::Trending,
            daily_drawdown_bps: 50,
            weekly_drawdown_bps: 100,
            monthly_drawdown_bps: 150,
            active_positions: 1,
            current_leverage: 2,
            health_degraded: false,
            model_confidence: 0.78,
            expected_value_score: 0.22,
            news_risk_off: false,
        }
    }

    #[test]
    fn approves_healthy_paper_order() {
        let outcome = risk_gate().evaluate(&approved_intent(RuntimeMode::Paper), healthy_snapshot());
        assert_eq!(outcome, RiskOutcome::Approved);
    }

    #[test]
    fn rejects_research_mode() {
        let outcome = risk_gate().evaluate(&approved_intent(RuntimeMode::Research), healthy_snapshot());
        assert_eq!(outcome, RiskOutcome::Rejected(RiskRejection::LiveTradingDisabled(RuntimeMode::Research)));
    }

    #[test]
    fn rejects_degraded_health() {
        let mut snapshot = healthy_snapshot();
        snapshot.health_degraded = true;

        let outcome = risk_gate().evaluate(&approved_intent(RuntimeMode::SemiAuto), snapshot);
        assert_eq!(outcome, RiskOutcome::Rejected(RiskRejection::DegradedHealth));
    }

    #[test]
    fn rejects_drawdown_breach() {
        let mut snapshot = healthy_snapshot();
        snapshot.daily_drawdown_bps = 250;

        let outcome = risk_gate().evaluate(&approved_intent(RuntimeMode::FullAuto), snapshot);
        assert_eq!(outcome, RiskOutcome::Rejected(RiskRejection::DrawdownLimitReached));
    }

    #[test]
    fn approves_healthy_live_order() {
        let outcome = risk_gate().evaluate(&approved_intent(RuntimeMode::FullAuto), healthy_snapshot());
        assert_eq!(outcome, RiskOutcome::Approved);
    }

    #[test]
    fn rejects_risk_off_news() {
        let mut snapshot = healthy_snapshot();
        snapshot.news_risk_off = true;

        let outcome = risk_gate().evaluate(&approved_intent(RuntimeMode::FullAuto), snapshot);
        assert_eq!(outcome, RiskOutcome::Rejected(RiskRejection::RiskOffNews));
    }
}
