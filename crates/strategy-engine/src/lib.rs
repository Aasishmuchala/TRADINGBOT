use sthyra_domain::{MarketRegime, RegimeAssessment, Symbol};
use sthyra_market_data::RegimeFeatureVector;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StrategyFamily {
    TrendPullbackContinuation,
    BreakoutConfirmation,
    MeanReversion,
    VolatilityCompressionBreakout,
    LiquiditySweepReversal,
    MomentumContinuation,
    VwapReversion,
    SessionSetup,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StrategyCandidate {
    pub symbol: Symbol,
    pub family: StrategyFamily,
    pub regime: MarketRegime,
    pub base_confidence: f64,
    pub diagnostics: Vec<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuppressionReason {
    pub family: StrategyFamily,
    pub reason: &'static str,
}

pub struct StrategySelector;

impl StrategySelector {
    pub fn select(
        assessment: RegimeAssessment,
        features: &RegimeFeatureVector,
    ) -> (Vec<StrategyCandidate>, Vec<SuppressionReason>) {
        let mut candidates = Vec::new();
        let mut suppressed = Vec::new();

        for family in all_families() {
            if !is_family_allowed(family, assessment.regime, assessment.confidence) {
                suppressed.push(SuppressionReason {
                    family,
                    reason: "regime or confidence does not support activation",
                });
                continue;
            }

            let confidence_boost = confidence_boost_for(family, features);
            candidates.push(StrategyCandidate {
                symbol: features.symbol.clone(),
                family,
                regime: assessment.regime,
                base_confidence: (assessment.confidence as f64 + confidence_boost).min(1.0),
                diagnostics: vec!["candidate generated from regime fit"],
            });
        }

        (candidates, suppressed)
    }
}

fn all_families() -> [StrategyFamily; 8] {
    [
        StrategyFamily::TrendPullbackContinuation,
        StrategyFamily::BreakoutConfirmation,
        StrategyFamily::MeanReversion,
        StrategyFamily::VolatilityCompressionBreakout,
        StrategyFamily::LiquiditySweepReversal,
        StrategyFamily::MomentumContinuation,
        StrategyFamily::VwapReversion,
        StrategyFamily::SessionSetup,
    ]
}

fn is_family_allowed(family: StrategyFamily, regime: MarketRegime, confidence: f32) -> bool {
    if confidence < 0.55 || matches!(regime, MarketRegime::NoTrade | MarketRegime::Disordered) {
        return false;
    }

    matches!(
        (family, regime),
        (StrategyFamily::TrendPullbackContinuation, MarketRegime::Trending)
            | (StrategyFamily::MomentumContinuation, MarketRegime::Trending)
            | (StrategyFamily::BreakoutConfirmation, MarketRegime::BreakoutExpansion)
            | (StrategyFamily::VolatilityCompressionBreakout, MarketRegime::VolatilityCompression)
            | (StrategyFamily::LiquiditySweepReversal, MarketRegime::ReversalAttempt)
            | (StrategyFamily::MeanReversion, MarketRegime::Ranging)
            | (StrategyFamily::VwapReversion, MarketRegime::Ranging)
            | (StrategyFamily::SessionSetup, _)
    )
}

fn confidence_boost_for(family: StrategyFamily, features: &RegimeFeatureVector) -> f64 {
    match family {
        StrategyFamily::TrendPullbackContinuation | StrategyFamily::MomentumContinuation => {
            (features.trend_strength + features.momentum_quality) / 4.0
        }
        StrategyFamily::BreakoutConfirmation | StrategyFamily::VolatilityCompressionBreakout => {
            (features.volatility_compression + features.order_book_pressure.abs()) / 4.0
        }
        StrategyFamily::MeanReversion | StrategyFamily::VwapReversion => {
            features.liquidity_quality / 4.0
        }
        StrategyFamily::LiquiditySweepReversal => (features.order_book_pressure.abs()) / 5.0,
        StrategyFamily::SessionSetup => 0.05,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn features(regime: MarketRegime) -> RegimeFeatureVector {
        RegimeFeatureVector {
            symbol: Symbol::new("BTCUSDT").expect("valid symbol"),
            trend_strength: 0.9,
            momentum_quality: 0.8,
            volatility_compression: 0.7,
            liquidity_quality: 0.9,
            order_book_pressure: 0.6,
            inferred_regime_hint: regime,
        }
    }

    #[test]
    fn emits_trend_candidate_for_trending_regime() {
        let assessment = RegimeAssessment::new(MarketRegime::Trending, 0.8).expect("valid assessment");
        let (candidates, suppressed) = StrategySelector::select(assessment, &features(MarketRegime::Trending));

        assert!(candidates.iter().any(|candidate| candidate.family == StrategyFamily::TrendPullbackContinuation));
        assert!(!suppressed.is_empty());
    }

    #[test]
    fn suppresses_all_in_no_trade_regime() {
        let assessment = RegimeAssessment::new(MarketRegime::NoTrade, 0.9).expect("valid assessment");
        let (candidates, suppressed) = StrategySelector::select(assessment, &features(MarketRegime::NoTrade));

        assert!(candidates.is_empty());
        assert_eq!(suppressed.len(), 8);
    }
}
