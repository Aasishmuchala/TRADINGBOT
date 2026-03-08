use std::path::PathBuf;

use serde::Serialize;
use sthyra_confluence::{score_candidate, ConfluenceInputs, ConfluenceOutcome};
use sthyra_domain::{MarketRegime, RegimeAssessment, Symbol, TradeDecision};
use sthyra_learning::{
    apply_promoted_indicator_genome, apply_promoted_model, load_research_cycle_report,
    select_promoted_indicator, select_promoted_model, ResearchCycleReport,
};
use sthyra_market_data::{FeedHealth, MarketHealthAssessment, RegimeFeatureVector};
use sthyra_news_sentiment::NewsSentimentSnapshot;
use sthyra_replay::IndicatorGeneInputs;
use sthyra_strategy_engine::{StrategyFamily, StrategySelector};

const DEFAULT_REPORT_PATH: &str = ".sthyra/model-registry.json";

#[derive(Debug, Clone)]
struct Scenario {
    name: &'static str,
    regime: RegimeAssessment,
    features: RegimeFeatureVector,
    market_health: MarketHealthAssessment,
    base_inputs: ConfluenceInputs,
    indicator_inputs: IndicatorGeneInputs,
}

#[derive(Debug)]
struct CandidateDelta {
    scenario: &'static str,
    family: StrategyFamily,
    symbol: String,
    selected_model_id: Option<String>,
    selected_indicator_id: Option<String>,
    without_overlay: ConfluenceOutcome,
    with_overlay: ConfluenceOutcome,
}

#[derive(Debug, Serialize)]
struct OverlayCompareReport {
    report_path: String,
    day_key: String,
    promoted_indicator: Option<String>,
    scenarios_evaluated: usize,
    approvals_without_overlay: usize,
    approvals_with_overlay: usize,
    changed_candidates: usize,
    changes: Vec<OverlayCompareChange>,
}

#[derive(Debug, Serialize)]
struct OverlayCompareChange {
    scenario: String,
    symbol: String,
    family: String,
    selected_model_id: Option<String>,
    selected_indicator_id: Option<String>,
    without_overlay: OverlayDecisionSnapshot,
    with_overlay: OverlayDecisionSnapshot,
    delta: OverlayDecisionDelta,
}

#[derive(Debug, Serialize)]
struct OverlayDecisionSnapshot {
    decision: String,
    confidence_score: f64,
    expected_value_score: f64,
}

#[derive(Debug, Serialize)]
struct OverlayDecisionDelta {
    confidence_score: f64,
    expected_value_score: f64,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut json_output = false;
    let mut report_path = None;

    for arg in std::env::args().skip(1) {
        if arg == "--json" {
            json_output = true;
            continue;
        }

        if report_path.is_none() {
            report_path = Some(PathBuf::from(arg));
        }
    }

    let report_path = report_path.unwrap_or_else(|| PathBuf::from(DEFAULT_REPORT_PATH));
    let report = load_research_cycle_report(&report_path)?;

    let scenarios = build_scenarios()?;
    let deltas = evaluate_overlay_deltas(&report, &scenarios);

    let approvals_without = deltas
        .iter()
        .filter(|delta| delta.without_overlay.decision == TradeDecision::Approve)
        .count();
    let approvals_with = deltas
        .iter()
        .filter(|delta| delta.with_overlay.decision == TradeDecision::Approve)
        .count();
    let changed = deltas
        .iter()
        .filter(|delta| decision_or_confidence_changed(delta))
        .collect::<Vec<_>>();

    let report_payload = OverlayCompareReport {
        report_path: report_path.display().to_string(),
        day_key: report.day_key.clone(),
        promoted_indicator: report
            .promoted_indicator
            .as_ref()
            .map(|entry| entry.genome.id.clone()),
        scenarios_evaluated: scenarios.len(),
        approvals_without_overlay: approvals_without,
        approvals_with_overlay: approvals_with,
        changed_candidates: changed.len(),
        changes: changed.into_iter().map(OverlayCompareChange::from).collect(),
    };

    if json_output {
        println!("{}", serde_json::to_string_pretty(&report_payload)?);
        return Ok(());
    }

    println!("Overlay comparator report: {}", report_payload.report_path);
    println!("Day key: {}", report_payload.day_key);
    println!(
        "Promoted indicator: {}",
        report_payload.promoted_indicator.as_deref().unwrap_or("none")
    );
    println!("Scenarios evaluated: {}", report_payload.scenarios_evaluated);
    println!("Approvals without overlay: {}", report_payload.approvals_without_overlay);
    println!("Approvals with overlay: {}", report_payload.approvals_with_overlay);
    println!("Changed candidates: {}", report_payload.changed_candidates);

    if report_payload.changes.is_empty() {
        println!("No overlay-sensitive candidates were found in the synthetic threshold scenarios.");
        return Ok(());
    }

    for delta in &report_payload.changes {
        println!();
        println!("Scenario: {}", delta.scenario);
        println!("Candidate: {} / {} / {}", delta.symbol, delta.family, delta.with_overlay.decision);
        println!(
            "Model: {}",
            delta.selected_model_id.as_deref().unwrap_or("none")
        );
        println!(
            "Indicator: {}",
            delta.selected_indicator_id.as_deref().unwrap_or("none")
        );
        println!(
            "Without overlay: {:?} confidence={:.3} ev={:.3}",
            delta.without_overlay.decision,
            delta.without_overlay.confidence_score,
            delta.without_overlay.expected_value_score
        );
        println!(
            "With overlay:    {:?} confidence={:.3} ev={:.3}",
            delta.with_overlay.decision,
            delta.with_overlay.confidence_score,
            delta.with_overlay.expected_value_score
        );
        println!(
            "Delta: confidence={:+.3} ev={:+.3}",
            delta.delta.confidence_score,
            delta.delta.expected_value_score
        );
    }

    Ok(())
}

impl From<&CandidateDelta> for OverlayCompareChange {
    fn from(delta: &CandidateDelta) -> Self {
        Self {
            scenario: delta.scenario.to_string(),
            symbol: delta.symbol.clone(),
            family: format!("{:?}", delta.family),
            selected_model_id: delta.selected_model_id.clone(),
            selected_indicator_id: delta.selected_indicator_id.clone(),
            without_overlay: OverlayDecisionSnapshot::from(&delta.without_overlay),
            with_overlay: OverlayDecisionSnapshot::from(&delta.with_overlay),
            delta: OverlayDecisionDelta {
                confidence_score: delta.with_overlay.confidence_score - delta.without_overlay.confidence_score,
                expected_value_score: delta.with_overlay.expected_value_score - delta.without_overlay.expected_value_score,
            },
        }
    }
}

impl From<&ConfluenceOutcome> for OverlayDecisionSnapshot {
    fn from(outcome: &ConfluenceOutcome) -> Self {
        Self {
            decision: format!("{:?}", outcome.decision),
            confidence_score: outcome.confidence_score,
            expected_value_score: outcome.expected_value_score,
        }
    }
}

fn evaluate_overlay_deltas(report: &ResearchCycleReport, scenarios: &[Scenario]) -> Vec<CandidateDelta> {
    let mut deltas = Vec::new();

    for scenario in scenarios {
        let (candidates, _) = StrategySelector::select(scenario.regime, &scenario.features);

        for candidate in candidates {
            let selected_model = select_promoted_model(
                report,
                &candidate.symbol.0,
                candidate.regime,
                candidate.family,
            );
            let selected_indicator = select_promoted_indicator(
                report,
                &candidate.symbol.0,
                candidate.regime,
                candidate.family,
            );

            let model_adjusted = apply_promoted_model(&scenario.base_inputs, selected_model);
            let overlay_adjusted = apply_promoted_indicator_genome(
                &model_adjusted,
                &scenario.indicator_inputs,
                selected_indicator,
            );

            deltas.push(CandidateDelta {
                scenario: scenario.name,
                family: candidate.family,
                symbol: candidate.symbol.0.clone(),
                selected_model_id: selected_model.map(|entry| entry.model.id.clone()),
                selected_indicator_id: selected_indicator.map(|entry| entry.genome.id.clone()),
                without_overlay: score_candidate(&candidate, scenario.regime, &scenario.market_health, &model_adjusted),
                with_overlay: score_candidate(&candidate, scenario.regime, &scenario.market_health, &overlay_adjusted),
            });
        }
    }

    deltas
}

fn decision_or_confidence_changed(delta: &CandidateDelta) -> bool {
    delta.without_overlay.decision != delta.with_overlay.decision
        || (delta.without_overlay.confidence_score - delta.with_overlay.confidence_score).abs() > 0.0001
}

fn build_scenarios() -> Result<Vec<Scenario>, Box<dyn std::error::Error>> {
    Ok(vec![
        Scenario {
            name: "trend-threshold-soft",
            regime: RegimeAssessment::new(MarketRegime::Trending, 0.56)?,
            features: RegimeFeatureVector {
                symbol: Symbol::new("BTCUSDT")?,
                trend_strength: 0.18,
                momentum_quality: 0.14,
                volatility_compression: 0.22,
                liquidity_quality: 0.58,
                order_book_pressure: 0.19,
                inferred_regime_hint: MarketRegime::Trending,
            },
            market_health: MarketHealthAssessment {
                feed_health: FeedHealth::Healthy,
                spread_penalty: 0.72,
                liquidity_penalty: 0.34,
                manipulation_suspected: false,
            },
            base_inputs: base_inputs(0.17, 0.19, 0.62, 0.22, 0.21, 0.16, 0.18, 0.18),
            indicator_inputs: trend_indicator_inputs(0.76),
        },
        Scenario {
            name: "trend-threshold-balanced",
            regime: RegimeAssessment::new(MarketRegime::Trending, 0.58)?,
            features: RegimeFeatureVector {
                symbol: Symbol::new("BTCUSDT")?,
                trend_strength: 0.21,
                momentum_quality: 0.17,
                volatility_compression: 0.26,
                liquidity_quality: 0.6,
                order_book_pressure: 0.24,
                inferred_regime_hint: MarketRegime::Trending,
            },
            market_health: MarketHealthAssessment {
                feed_health: FeedHealth::Healthy,
                spread_penalty: 0.64,
                liquidity_penalty: 0.28,
                manipulation_suspected: false,
            },
            base_inputs: base_inputs(0.2, 0.22, 0.56, 0.25, 0.25, 0.21, 0.22, 0.22),
            indicator_inputs: trend_indicator_inputs(0.84),
        },
        Scenario {
            name: "trend-threshold-stressed",
            regime: RegimeAssessment::new(MarketRegime::Trending, 0.55)?,
            features: RegimeFeatureVector {
                symbol: Symbol::new("BTCUSDT")?,
                trend_strength: 0.16,
                momentum_quality: 0.12,
                volatility_compression: 0.2,
                liquidity_quality: 0.54,
                order_book_pressure: 0.18,
                inferred_regime_hint: MarketRegime::Trending,
            },
            market_health: MarketHealthAssessment {
                feed_health: FeedHealth::Degraded,
                spread_penalty: 0.78,
                liquidity_penalty: 0.42,
                manipulation_suspected: false,
            },
            base_inputs: base_inputs(0.14, 0.16, 0.69, 0.18, 0.18, 0.13, 0.16, 0.15),
            indicator_inputs: trend_indicator_inputs(0.9),
        },
        Scenario {
            name: "range-control",
            regime: RegimeAssessment::new(MarketRegime::Ranging, 0.6)?,
            features: RegimeFeatureVector {
                symbol: Symbol::new("BTCUSDT")?,
                trend_strength: 0.08,
                momentum_quality: 0.1,
                volatility_compression: 0.3,
                liquidity_quality: 0.82,
                order_book_pressure: -0.05,
                inferred_regime_hint: MarketRegime::Ranging,
            },
            market_health: MarketHealthAssessment {
                feed_health: FeedHealth::Healthy,
                spread_penalty: 0.42,
                liquidity_penalty: 0.1,
                manipulation_suspected: false,
            },
            base_inputs: base_inputs(0.34, 0.37, 0.33, 0.32, 0.35, 0.31, 0.28, 0.3),
            indicator_inputs: trend_indicator_inputs(0.4),
        },
        Scenario {
            name: "breakout-control",
            regime: RegimeAssessment::new(MarketRegime::BreakoutExpansion, 0.62)?,
            features: RegimeFeatureVector {
                symbol: Symbol::new("BTCUSDT")?,
                trend_strength: 0.25,
                momentum_quality: 0.28,
                volatility_compression: 0.74,
                liquidity_quality: 0.56,
                order_book_pressure: 0.72,
                inferred_regime_hint: MarketRegime::BreakoutExpansion,
            },
            market_health: MarketHealthAssessment {
                feed_health: FeedHealth::Healthy,
                spread_penalty: 0.38,
                liquidity_penalty: 0.14,
                manipulation_suspected: false,
            },
            base_inputs: base_inputs(0.36, 0.33, 0.29, 0.34, 0.39, 0.41, 0.44, 0.37),
            indicator_inputs: trend_indicator_inputs(0.55),
        },
    ])
}

fn base_inputs(
    higher_timeframe_alignment: f64,
    recent_strategy_performance: f64,
    correlation_penalty: f64,
    indicator_consensus: f64,
    market_structure_score: f64,
    volatility_fit: f64,
    order_flow_score: f64,
    confirmation_score: f64,
) -> ConfluenceInputs {
    ConfluenceInputs {
        higher_timeframe_alignment,
        recent_strategy_performance,
        correlation_penalty,
        system_health_modifier: 0.28,
        indicator_consensus,
        market_structure_score,
        volatility_fit,
        order_flow_score,
        confirmation_score,
        news: NewsSentimentSnapshot::default(),
    }
}

fn trend_indicator_inputs(intensity: f64) -> IndicatorGeneInputs {
    IndicatorGeneInputs {
        rsi_bias: 0.28 * intensity,
        macd_bias: 0.34 * intensity,
        breakout_bias: 0.26 * intensity,
        mean_reversion_bias: -0.2 * intensity,
        momentum_bias: 0.38 * intensity,
        volume_bias: 0.19 * intensity,
        volatility_efficiency: 0.18 * intensity,
        vwap_reversion_bias: -0.12 * intensity,
        stochastic_bias: 0.24 * intensity,
        cci_bias: 0.21 * intensity,
        money_flow_bias: 0.18 * intensity,
        ema_trend_bias: 0.36 * intensity,
    }
}