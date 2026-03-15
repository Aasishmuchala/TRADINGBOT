use sthyra_confluence::{score_candidate, ConfluenceInputs, ConfluenceOutcome};
use sthyra_domain::{RegimeAssessment, TradeDecision};
use sthyra_market_data::{MarketHealthAssessment, RegimeFeatureVector};
use sthyra_strategy_engine::{StrategyCandidate, StrategySelector};

#[derive(Debug, Clone, PartialEq)]
pub struct IndicatorGeneInputs {
    pub rsi_bias: f64,
    pub macd_bias: f64,
    pub breakout_bias: f64,
    pub mean_reversion_bias: f64,
    pub momentum_bias: f64,
    pub volume_bias: f64,
    pub volatility_efficiency: f64,
    pub vwap_reversion_bias: f64,
    pub stochastic_bias: f64,
    pub cci_bias: f64,
    pub money_flow_bias: f64,
    pub ema_trend_bias: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReplayFrame {
    pub regime: RegimeAssessment,
    pub features: RegimeFeatureVector,
    pub market_health: MarketHealthAssessment,
    pub confluence_inputs: ConfluenceInputs,
    pub indicator_inputs: IndicatorGeneInputs,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReplayResult {
    pub candidates: Vec<StrategyCandidate>,
    pub outcomes: Vec<ConfluenceOutcome>,
}

pub fn run_frame(frame: &ReplayFrame) -> ReplayResult {
    let (candidates, _) = StrategySelector::select(frame.regime, &frame.features);
    let outcomes = candidates
        .iter()
        .map(|candidate| {
            score_candidate(
                candidate,
                frame.regime,
                &frame.market_health,
                &frame.confluence_inputs,
            )
        })
        .collect();

    ReplayResult { candidates, outcomes }
}

pub fn approved_count(result: &ReplayResult) -> usize {
    result
        .outcomes
        .iter()
        .filter(|outcome| outcome.decision == TradeDecision::Approve)
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sthyra_domain::{MarketRegime, Symbol};
    use sthyra_market_data::FeedHealth;
    use sthyra_news_sentiment::NewsSentimentSnapshot;

    #[test]
    fn replays_and_scores_candidates() {
        let frame = ReplayFrame {
            regime: RegimeAssessment::new(MarketRegime::Trending, 0.8).expect("valid regime"),
            features: RegimeFeatureVector {
                symbol: Symbol::new("BTCUSDT").expect("valid symbol"),
                trend_strength: 0.9,
                momentum_quality: 0.8,
                volatility_compression: 0.2,
                liquidity_quality: 0.9,
                order_book_pressure: 0.4,
                inferred_regime_hint: MarketRegime::Trending,
            },
            market_health: MarketHealthAssessment {
                feed_health: FeedHealth::Healthy,
                spread_penalty: 0.05,
                liquidity_penalty: 0.0,
                manipulation_suspected: false,
            },
            confluence_inputs: ConfluenceInputs {
                higher_timeframe_alignment: 0.8,
                recent_strategy_performance: 0.6,
                correlation_penalty: 0.1,
                system_health_modifier: 0.8,
                indicator_consensus: 0.8,
                market_structure_score: 0.7,
                volatility_fit: 0.7,
                order_flow_score: 0.75,
                confirmation_score: 0.8,
                news: NewsSentimentSnapshot::default(),
                extras: sthyra_market_data::MarketExtras::default(),
            },
            indicator_inputs: IndicatorGeneInputs {
                rsi_bias: 0.82,
                macd_bias: 0.76,
                breakout_bias: 0.79,
                mean_reversion_bias: 0.34,
                momentum_bias: 0.81,
                volume_bias: 0.68,
                volatility_efficiency: 0.71,
                vwap_reversion_bias: 0.45,
                stochastic_bias: 0.74,
                cci_bias: 0.72,
                money_flow_bias: 0.66,
                ema_trend_bias: 0.8,
            },
        };

        let result = run_frame(&frame);
        assert!(!result.candidates.is_empty());
        assert!(approved_count(&result) >= 1);
    }
}
