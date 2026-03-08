use sthyra_replay::{approved_count, run_frame, ReplayFrame};

#[derive(Debug, Clone, PartialEq)]
pub struct BacktestSummary {
    pub frames_processed: usize,
    pub approved_trades: usize,
    pub approval_rate: f64,
}

pub fn run_backtest(frames: &[ReplayFrame]) -> BacktestSummary {
    let approved_trades: usize = frames
        .iter()
        .map(run_frame)
        .map(|result| approved_count(&result))
        .sum();

    let frames_processed = frames.len();
    let approval_rate = if frames_processed == 0 {
        0.0
    } else {
        approved_trades as f64 / frames_processed as f64
    };

    BacktestSummary {
        frames_processed,
        approved_trades,
        approval_rate,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sthyra_domain::{MarketRegime, RegimeAssessment, Symbol};
    use sthyra_confluence::ConfluenceInputs;
    use sthyra_market_data::{FeedHealth, MarketHealthAssessment, RegimeFeatureVector};
    use sthyra_news_sentiment::NewsSentimentSnapshot;
    use sthyra_replay::{IndicatorGeneInputs, ReplayFrame};

    #[test]
    fn summarizes_backtest() {
        let frames = vec![ReplayFrame {
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
            indicator_inputs: IndicatorGeneInputs {
                rsi_bias: 0.2,
                macd_bias: 0.24,
                breakout_bias: 0.18,
                mean_reversion_bias: -0.12,
                momentum_bias: 0.29,
                volume_bias: 0.11,
                volatility_efficiency: 0.14,
                vwap_reversion_bias: -0.06,
                stochastic_bias: 0.16,
                cci_bias: 0.15,
                money_flow_bias: 0.12,
                ema_trend_bias: 0.27,
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
            },
        }];

        let summary = run_backtest(&frames);
        assert_eq!(summary.frames_processed, 1);
        assert!(summary.approved_trades >= 1);
    }
}
