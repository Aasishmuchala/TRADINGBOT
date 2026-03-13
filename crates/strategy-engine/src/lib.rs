use sthyra_domain::{MarketRegime, RegimeAssessment, Symbol};
use sthyra_market_data::RegimeFeatureVector;

/// All strategy families supported by Sthyra.
/// New entries added: GridTrading, DeltaNeutral, BollingerBandSqueeze.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StrategyFamily {
    // Original 8
    TrendPullbackContinuation,
    BreakoutConfirmation,
    MeanReversion,
    VolatilityCompressionBreakout,
    LiquiditySweepReversal,
    MomentumContinuation,
    VwapReversion,
    SessionSetup,
    // New strategies
    GridTrading,
    DeltaNeutral,
    BollingerBandSqueeze,
}

impl StrategyFamily {
    pub fn label(self) -> &'static str {
        match self {
            Self::TrendPullbackContinuation  => "TrendPullback",
            Self::BreakoutConfirmation       => "Breakout",
            Self::MeanReversion              => "MeanReversion",
            Self::VolatilityCompressionBreakout => "VolCompBreakout",
            Self::LiquiditySweepReversal     => "LiqSweepReversal",
            Self::MomentumContinuation       => "Momentum",
            Self::VwapReversion              => "VwapReversion",
            Self::SessionSetup               => "SessionSetup",
            Self::GridTrading                => "GridTrading",
            Self::DeltaNeutral               => "DeltaNeutral",
            Self::BollingerBandSqueeze       => "BBSqueeze",
        }
    }

    /// Minimum regime confidence required to activate this family.
    pub fn min_confidence(self) -> f32 {
        match self {
            Self::DeltaNeutral               => 0.45, // market-neutral, lower bar
            Self::GridTrading                => 0.50, // works in any ranging market
            Self::BollingerBandSqueeze       => 0.55,
            _                                => 0.55,
        }
    }
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

        // Sort: highest confidence first
        candidates.sort_by(|a, b| b.base_confidence.partial_cmp(&a.base_confidence).unwrap_or(std::cmp::Ordering::Equal));

        (candidates, suppressed)
    }
}

fn all_families() -> [StrategyFamily; 11] {
    [
        StrategyFamily::TrendPullbackContinuation,
        StrategyFamily::BreakoutConfirmation,
        StrategyFamily::MeanReversion,
        StrategyFamily::VolatilityCompressionBreakout,
        StrategyFamily::LiquiditySweepReversal,
        StrategyFamily::MomentumContinuation,
        StrategyFamily::VwapReversion,
        StrategyFamily::SessionSetup,
        StrategyFamily::GridTrading,
        StrategyFamily::DeltaNeutral,
        StrategyFamily::BollingerBandSqueeze,
    ]
}

fn is_family_allowed(family: StrategyFamily, regime: MarketRegime, confidence: f32) -> bool {
    let min_conf = family.min_confidence();
    if confidence < min_conf || matches!(regime, MarketRegime::NoTrade | MarketRegime::Disordered) {
        return false;
    }

    matches!(
        (family, regime),
        // Original families
        (StrategyFamily::TrendPullbackContinuation, MarketRegime::Trending)
            | (StrategyFamily::MomentumContinuation, MarketRegime::Trending)
            | (StrategyFamily::BreakoutConfirmation, MarketRegime::BreakoutExpansion)
            | (StrategyFamily::VolatilityCompressionBreakout, MarketRegime::VolatilityCompression)
            | (StrategyFamily::LiquiditySweepReversal, MarketRegime::ReversalAttempt)
            | (StrategyFamily::MeanReversion, MarketRegime::Ranging)
            | (StrategyFamily::VwapReversion, MarketRegime::Ranging)
            | (StrategyFamily::SessionSetup, _)
            // New: Grid — works best in Ranging + VolatilityCompression
            | (StrategyFamily::GridTrading, MarketRegime::Ranging)
            | (StrategyFamily::GridTrading, MarketRegime::VolatilityCompression)
            // New: Delta-neutral — works in Ranging and ReversalAttempt (stat arb / pairs)
            | (StrategyFamily::DeltaNeutral, MarketRegime::Ranging)
            | (StrategyFamily::DeltaNeutral, MarketRegime::ReversalAttempt)
            // New: BB Squeeze — fires on Compression breakout, Trending expansion
            | (StrategyFamily::BollingerBandSqueeze, MarketRegime::VolatilityCompression)
            | (StrategyFamily::BollingerBandSqueeze, MarketRegime::BreakoutExpansion)
            | (StrategyFamily::BollingerBandSqueeze, MarketRegime::Trending)
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
        StrategyFamily::LiquiditySweepReversal => features.order_book_pressure.abs() / 5.0,
        StrategyFamily::SessionSetup => 0.05,
        // Grid: higher boost when vol is compressed and liquidity is good
        StrategyFamily::GridTrading => {
            (features.volatility_compression * 0.5 + features.liquidity_quality * 0.5) / 3.5
        }
        // Delta-neutral: benefits from order book imbalance (hedging edge)
        StrategyFamily::DeltaNeutral => {
            features.order_book_pressure.abs() / 6.0 + features.liquidity_quality / 8.0
        }
        // BB Squeeze: fires strongest when vol just compressed then momentum kicks in
        StrategyFamily::BollingerBandSqueeze => {
            (features.volatility_compression * 0.6 + features.momentum_quality * 0.4) / 3.5
        }
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
        assert!(candidates.iter().any(|c| c.family == StrategyFamily::TrendPullbackContinuation));
        assert!(!suppressed.is_empty());
    }

    #[test]
    fn emits_grid_in_ranging_regime() {
        let assessment = RegimeAssessment::new(MarketRegime::Ranging, 0.75).expect("valid");
        let (candidates, _) = StrategySelector::select(assessment, &features(MarketRegime::Ranging));
        assert!(candidates.iter().any(|c| c.family == StrategyFamily::GridTrading));
    }

    #[test]
    fn emits_bbsqueeze_in_volatility_compression() {
        let assessment = RegimeAssessment::new(MarketRegime::VolatilityCompression, 0.75).expect("valid");
        let (candidates, _) = StrategySelector::select(assessment, &features(MarketRegime::VolatilityCompression));
        assert!(candidates.iter().any(|c| c.family == StrategyFamily::BollingerBandSqueeze));
    }

    #[test]
    fn suppresses_all_in_no_trade_regime() {
        let assessment = RegimeAssessment::new(MarketRegime::NoTrade, 0.9).expect("valid assessment");
        let (candidates, suppressed) = StrategySelector::select(assessment, &features(MarketRegime::NoTrade));
        assert!(candidates.is_empty());
        assert_eq!(suppressed.len(), 11);
    }

    #[test]
    fn candidates_sorted_by_confidence_desc() {
        let assessment = RegimeAssessment::new(MarketRegime::Trending, 0.8).expect("valid");
        let (candidates, _) = StrategySelector::select(assessment, &features(MarketRegime::Trending));
        for window in candidates.windows(2) {
            assert!(window[0].base_confidence >= window[1].base_confidence);
        }
    }
}
