use sthyra_domain::{RegimeAssessment, TradeDecision};
use sthyra_market_data::{MarketHealthAssessment, MarketExtras};
use sthyra_news_sentiment::NewsSentimentSnapshot;
use sthyra_strategy_engine::StrategyCandidate;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TradeQualityTier {
    Prime,
    Strong,
    Marginal,
    Reject,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConfluenceOutcome {
    pub confidence_score: f64,
    pub expected_value_score: f64,
    pub trade_quality_tier: TradeQualityTier,
    pub recommended_size_multiplier: f64,
    pub decision: TradeDecision,
    pub reasons: Vec<&'static str>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConfluenceInputs {
    pub higher_timeframe_alignment: f64,
    pub recent_strategy_performance: f64,
    pub correlation_penalty: f64,
    pub system_health_modifier: f64,
    pub indicator_consensus: f64,
    pub market_structure_score: f64,
    pub volatility_fit: f64,
    pub order_flow_score: f64,
    pub confirmation_score: f64,
    pub news: NewsSentimentSnapshot,
    /// Enhanced market signals (funding rate, OI, L2 depth, HTF, correlation).
    /// Defaults to neutral values if not populated.
    pub extras: MarketExtras,
}

pub fn score_candidate(
    candidate: &StrategyCandidate,
    regime: RegimeAssessment,
    market_health: &MarketHealthAssessment,
    inputs: &ConfluenceInputs,
) -> ConfluenceOutcome {
    let extras = &inputs.extras;

    // Real higher-timeframe alignment (replaces fake EMA-on-1m computation)
    let htf_alignment = extras.real_htf_alignment()
        .max(inputs.higher_timeframe_alignment * 0.4); // blend with legacy if extras absent

    // Enhanced order flow: L2 depth + HTF + base
    let order_flow = extras.enhanced_order_flow_score(inputs.order_flow_score);

    // Funding rate signal: crowded positioning creates counter-trade opportunity
    // Positive funding = longs over-leveraged = mean-reversion / short bias
    // Negative funding = shorts over-leveraged = long squeeze opportunity
    let funding_signal = extras.funding_signal();
    let funding_boost = match candidate.family {
        sthyra_strategy_engine::StrategyFamily::MeanReversion
        | sthyra_strategy_engine::StrategyFamily::LiquiditySweepReversal
        | sthyra_strategy_engine::StrategyFamily::VwapReversion => {
            // Mean reversion strategies benefit from extreme funding
            funding_signal.abs() * 0.06
        }
        sthyra_strategy_engine::StrategyFamily::TrendPullbackContinuation
        | sthyra_strategy_engine::StrategyFamily::MomentumContinuation => {
            // Trend strategies hurt by extreme funding (crowded = reversal risk)
            -funding_signal.abs() * 0.04
        }
        _ => 0.0,
    };

    // OI delta: rising OI confirms the move, falling OI warns of exhaustion
    let oi_confirmation = if extras.open_interest_delta > 0.05 {
        0.04  // new money entering = conviction
    } else if extras.open_interest_delta < -0.05 {
        -0.03 // positions unwinding = caution
    } else {
        0.0
    };

    // Live correlation penalty (replaces hardcoded 0.1)
    let correlation_penalty = inputs.extras.portfolio_correlation_penalty
        .max(inputs.correlation_penalty);

    let mut confidence = candidate.base_confidence;
    confidence += htf_alignment * 0.12;
    confidence += inputs.recent_strategy_performance * 0.08;
    confidence += inputs.system_health_modifier * 0.08;
    confidence += inputs.indicator_consensus * 0.16;
    confidence += inputs.market_structure_score * 0.12;
    confidence += inputs.volatility_fit * 0.08;
    confidence += order_flow * 0.08;
    confidence += inputs.confirmation_score * 0.08;
    confidence += inputs.news.sentiment_score.max(0.0) * inputs.news.confidence * 0.08;
    confidence += funding_boost;
    confidence += oi_confirmation;
    confidence -= market_health.spread_penalty * 0.2;
    confidence -= market_health.liquidity_penalty * 0.15;
    confidence -= correlation_penalty * 0.15;
    confidence -= inputs.news.catalyst_score * f64::from(inputs.news.risk_off) * 0.15;
    confidence += regime.confidence as f64 * 0.15;
    confidence = confidence.clamp(0.0, 1.0);

    let expected_value = (confidence * 0.45
        + inputs.recent_strategy_performance * 0.2
        + inputs.indicator_consensus * 0.15
        + inputs.market_structure_score * 0.1
        + inputs.confirmation_score * 0.1)
        - market_health.spread_penalty
        - correlation_penalty
        - if inputs.news.risk_off { 0.25 } else { 0.0 }
        + oi_confirmation * 0.5;

    let (tier, decision) = if market_health.manipulation_suspected || inputs.news.risk_off || confidence < 0.48 {
        (TradeQualityTier::Reject, TradeDecision::Reject)
    } else if confidence >= 0.8 {
        (TradeQualityTier::Prime, TradeDecision::Approve)
    } else if confidence >= 0.65 {
        (TradeQualityTier::Strong, TradeDecision::Approve)
    } else if confidence >= 0.55 {
        (TradeQualityTier::Marginal, TradeDecision::Watch)
    } else {
        (TradeQualityTier::Reject, TradeDecision::Reject)
    };

    let mut reasons = Vec::new();
    if market_health.manipulation_suspected {
        reasons.push("order book behavior suggests manipulation risk");
    }
    if market_health.spread_penalty > 0.4 {
        reasons.push("spread penalty is too high");
    }
    if correlation_penalty > 0.4 {
        reasons.push("correlation exposure penalty is elevated");
    }
    if inputs.news.risk_off {
        reasons.push("news sentiment module flagged a risk-off catalyst");
    }
    if extras.funding_signal().abs() > 0.5 {
        reasons.push("extreme funding rate detected — positioning is crowded");
    }
    if extras.open_interest_delta < -0.1 {
        reasons.push("open interest declining — positions unwinding");
    }
    if reasons.is_empty() {
        reasons.push("candidate passed confluence thresholds");
    }

    ConfluenceOutcome {
        confidence_score: confidence,
        expected_value_score: expected_value,
        trade_quality_tier: tier,
        recommended_size_multiplier: confidence.clamp(0.25, 1.0),
        decision,
        reasons,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sthyra_domain::{MarketRegime, Symbol};
    use sthyra_strategy_engine::{StrategyCandidate, StrategyFamily};

    fn candidate() -> StrategyCandidate {
        StrategyCandidate {
            symbol: Symbol::new("BTCUSDT").expect("valid symbol"),
            family: StrategyFamily::TrendPullbackContinuation,
            regime: MarketRegime::Trending,
            base_confidence: 0.7,
            diagnostics: vec!["trend aligned"],
        }
    }

    #[test]
    fn approves_high_quality_candidate() {
        let outcome = score_candidate(
            &candidate(),
            RegimeAssessment::new(MarketRegime::Trending, 0.8).expect("valid assessment"),
            &MarketHealthAssessment {
                feed_health: sthyra_market_data::FeedHealth::Healthy,
                spread_penalty: 0.05,
                liquidity_penalty: 0.0,
                manipulation_suspected: false,
            },
            &ConfluenceInputs {
                higher_timeframe_alignment: 0.8,
                recent_strategy_performance: 0.7,
                correlation_penalty: 0.1,
                system_health_modifier: 0.8,
                indicator_consensus: 0.8,
                market_structure_score: 0.75,
                volatility_fit: 0.7,
                order_flow_score: 0.7,
                confirmation_score: 0.75,
                news: NewsSentimentSnapshot::default(),
                extras: sthyra_market_data::MarketExtras::default(),
            },
        );

        assert_eq!(outcome.decision, TradeDecision::Approve);
    }

    #[test]
    fn rejects_manipulation_risk() {
        let outcome = score_candidate(
            &candidate(),
            RegimeAssessment::new(MarketRegime::Trending, 0.8).expect("valid assessment"),
            &MarketHealthAssessment {
                feed_health: sthyra_market_data::FeedHealth::Degraded,
                spread_penalty: 0.7,
                liquidity_penalty: 0.4,
                manipulation_suspected: true,
            },
            &ConfluenceInputs {
                higher_timeframe_alignment: 0.5,
                recent_strategy_performance: 0.6,
                correlation_penalty: 0.2,
                system_health_modifier: 0.4,
                indicator_consensus: 0.4,
                market_structure_score: 0.4,
                volatility_fit: 0.3,
                order_flow_score: 0.4,
                confirmation_score: 0.35,
                news: NewsSentimentSnapshot::default(),
                extras: sthyra_market_data::MarketExtras::default(),
            },
        );

        assert_eq!(outcome.decision, TradeDecision::Reject);
    }
}
