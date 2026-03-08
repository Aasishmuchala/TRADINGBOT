use sthyra_domain::{RegimeAssessment, TradeDecision};
use sthyra_market_data::MarketHealthAssessment;
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
}

pub fn score_candidate(
    candidate: &StrategyCandidate,
    regime: RegimeAssessment,
    market_health: &MarketHealthAssessment,
    inputs: &ConfluenceInputs,
) -> ConfluenceOutcome {
    let mut confidence = candidate.base_confidence;
    confidence += inputs.higher_timeframe_alignment * 0.12;
    confidence += inputs.recent_strategy_performance * 0.08;
    confidence += inputs.system_health_modifier * 0.08;
    confidence += inputs.indicator_consensus * 0.16;
    confidence += inputs.market_structure_score * 0.12;
    confidence += inputs.volatility_fit * 0.08;
    confidence += inputs.order_flow_score * 0.08;
    confidence += inputs.confirmation_score * 0.08;
    confidence += inputs.news.sentiment_score.max(0.0) * inputs.news.confidence * 0.08;
    confidence -= market_health.spread_penalty * 0.2;
    confidence -= market_health.liquidity_penalty * 0.15;
    confidence -= inputs.correlation_penalty * 0.15;
    confidence -= inputs.news.catalyst_score * f64::from(inputs.news.risk_off) * 0.15;
    confidence += regime.confidence as f64 * 0.15;
    confidence = confidence.clamp(0.0, 1.0);

    let expected_value = (confidence * 0.45
        + inputs.recent_strategy_performance * 0.2
        + inputs.indicator_consensus * 0.15
        + inputs.market_structure_score * 0.1
        + inputs.confirmation_score * 0.1)
        - market_health.spread_penalty
        - inputs.correlation_penalty
        - if inputs.news.risk_off { 0.25 } else { 0.0 };

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
    if inputs.correlation_penalty > 0.4 {
        reasons.push("correlation exposure penalty is elevated");
    }
    if inputs.news.risk_off {
        reasons.push("news sentiment module flagged a risk-off catalyst");
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
            },
        );

        assert_eq!(outcome.decision, TradeDecision::Reject);
    }
}
