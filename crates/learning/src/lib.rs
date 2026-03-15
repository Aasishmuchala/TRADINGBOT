use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sthyra_confluence::ConfluenceInputs;
use sthyra_domain::MarketRegime;
use sthyra_replay::{IndicatorGeneInputs, ReplayFrame};
use sthyra_strategy_engine::StrategyFamily;

#[derive(Debug, Clone, PartialEq)]
pub struct TradeOutcomeRecord {
    pub symbol: String,
    pub regime: MarketRegime,
    pub strategy: StrategyFamily,
    pub pnl: f64,
    pub slippage_bps: f64,
    pub ideal_setup_match: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LearningProposal {
    pub strategy: StrategyFamily,
    pub regime: MarketRegime,
    pub weight_delta: f64,
    pub confidence_threshold_delta: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SignalModel {
    pub id: String,
    pub generation: u32,
    pub target_symbol: Option<String>,
    pub target_regime: Option<String>,
    pub target_family: Option<String>,
    pub indicator_weight: f64,
    pub structure_weight: f64,
    pub volatility_weight: f64,
    pub order_flow_weight: f64,
    pub sentiment_weight: f64,
    pub confirmation_weight: f64,
    pub approval_threshold: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EvaluatedSignalModel {
    pub model: SignalModel,
    pub profitability_score: f64,
    pub robustness_score: f64,
    pub risk_adjusted_return: f64,
    pub fitness_score: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IndicatorGenome {
    pub id: String,
    pub generation: u32,
    pub target_symbol: Option<String>,
    pub target_regime: Option<String>,
    pub target_family: Option<String>,
    pub rsi_weight: f64,
    pub macd_weight: f64,
    pub breakout_weight: f64,
    pub mean_reversion_weight: f64,
    pub momentum_weight: f64,
    pub volume_weight: f64,
    pub volatility_weight: f64,
    pub vwap_weight: f64,
    pub stochastic_weight: f64,
    pub cci_weight: f64,
    pub money_flow_weight: f64,
    pub ema_trend_weight: f64,
    pub approval_threshold: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EvaluatedIndicatorGenome {
    pub genome: IndicatorGenome,
    pub profitability_score: f64,
    pub robustness_score: f64,
    pub latency_score: f64,
    pub fitness_score: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResearchCycleReport {
    pub day_key: String,
    pub promoted_model: Option<EvaluatedSignalModel>,
    pub leaderboard: Vec<EvaluatedSignalModel>,
    #[serde(default)]
    pub promoted_indicator: Option<EvaluatedIndicatorGenome>,
    #[serde(default)]
    pub indicator_leaderboard: Vec<EvaluatedIndicatorGenome>,
}

pub fn propose_weight_updates(records: &[TradeOutcomeRecord]) -> Vec<LearningProposal> {
    let mut grouped: HashMap<(StrategyFamily, MarketRegime), Vec<&TradeOutcomeRecord>> = HashMap::new();
    for record in records {
        grouped
            .entry((record.strategy, record.regime))
            .or_default()
            .push(record);
    }

    grouped
        .into_iter()
        .map(|((strategy, regime), values)| {
            let mean_pnl = values.iter().map(|record| record.pnl).sum::<f64>() / values.len() as f64;
            let ideal_match_rate = values
                .iter()
                .filter(|record| record.ideal_setup_match)
                .count() as f64
                / values.len() as f64;
            LearningProposal {
                strategy,
                regime,
                weight_delta: mean_pnl.clamp(-0.2, 0.2),
                confidence_threshold_delta: (ideal_match_rate - 0.5).clamp(-0.1, 0.1),
            }
        })
        .collect()
}

pub fn base_signal_models() -> Vec<SignalModel> {
    vec![
        SignalModel {
            id: "balanced-core".to_string(),
            generation: 0,
            target_symbol: None,
            target_regime: None,
            target_family: None,
            indicator_weight: 0.24,
            structure_weight: 0.22,
            volatility_weight: 0.12,
            order_flow_weight: 0.14,
            sentiment_weight: 0.1,
            confirmation_weight: 0.18,
            approval_threshold: 0.61,
        },
        SignalModel {
            id: "trend-pressure".to_string(),
            generation: 0,
            target_symbol: None,
            target_regime: None,
            target_family: Some(format!("{:?}", StrategyFamily::TrendPullbackContinuation)),
            indicator_weight: 0.28,
            structure_weight: 0.24,
            volatility_weight: 0.1,
            order_flow_weight: 0.18,
            sentiment_weight: 0.06,
            confirmation_weight: 0.14,
            approval_threshold: 0.64,
        },
        SignalModel {
            id: "mean-revert-defense".to_string(),
            generation: 0,
            target_symbol: None,
            target_regime: Some(format!("{:?}", MarketRegime::Ranging)),
            target_family: Some(format!("{:?}", StrategyFamily::MeanReversion)),
            indicator_weight: 0.19,
            structure_weight: 0.2,
            volatility_weight: 0.16,
            order_flow_weight: 0.1,
            sentiment_weight: 0.1,
            confirmation_weight: 0.25,
            approval_threshold: 0.58,
        },
    ]
}

pub fn base_indicator_genomes() -> Vec<IndicatorGenome> {
    vec![
        IndicatorGenome {
            id: "genetic-trend-stack".to_string(),
            generation: 0,
            target_symbol: None,
            target_regime: Some(format!("{:?}", MarketRegime::Trending)),
            target_family: Some(format!("{:?}", StrategyFamily::TrendPullbackContinuation)),
            rsi_weight: 0.08,
            macd_weight: 0.18,
            breakout_weight: 0.12,
            mean_reversion_weight: -0.08,
            momentum_weight: 0.17,
            volume_weight: 0.1,
            volatility_weight: 0.06,
            vwap_weight: -0.04,
            stochastic_weight: 0.08,
            cci_weight: 0.07,
            money_flow_weight: 0.06,
            ema_trend_weight: 0.18,
            approval_threshold: 0.56,
        },
        IndicatorGenome {
            id: "genetic-reversal-stack".to_string(),
            generation: 0,
            target_symbol: None,
            target_regime: Some(format!("{:?}", MarketRegime::Ranging)),
            target_family: Some(format!("{:?}", StrategyFamily::MeanReversion)),
            rsi_weight: -0.15,
            macd_weight: -0.04,
            breakout_weight: -0.12,
            mean_reversion_weight: 0.19,
            momentum_weight: -0.08,
            volume_weight: 0.05,
            volatility_weight: 0.1,
            vwap_weight: 0.13,
            stochastic_weight: 0.14,
            cci_weight: 0.12,
            money_flow_weight: 0.11,
            ema_trend_weight: -0.03,
            approval_threshold: 0.53,
        },
        IndicatorGenome {
            id: "genetic-breakout-stack".to_string(),
            generation: 0,
            target_symbol: None,
            target_regime: Some(format!("{:?}", MarketRegime::BreakoutExpansion)),
            target_family: Some(format!("{:?}", StrategyFamily::BreakoutConfirmation)),
            rsi_weight: 0.06,
            macd_weight: 0.12,
            breakout_weight: 0.2,
            mean_reversion_weight: -0.11,
            momentum_weight: 0.14,
            volume_weight: 0.12,
            volatility_weight: -0.04,
            vwap_weight: -0.03,
            stochastic_weight: 0.07,
            cci_weight: 0.07,
            money_flow_weight: 0.08,
            ema_trend_weight: 0.12,
            approval_threshold: 0.58,
        },
    ]
}

pub fn mutate_signal_models(seed_models: &[SignalModel], generation: u32) -> Vec<SignalModel> {
    let mut mutated = Vec::new();

    for (index, model) in seed_models.iter().enumerate() {
        for variant in 0..4 {
            let offset = ((index + variant + 1) as f64 * 0.013).clamp(0.0, 0.08);
            mutated.push(SignalModel {
                id: format!("{}-g{}-m{}", model.id, generation, variant),
                generation,
                target_symbol: model.target_symbol.clone(),
                target_regime: model.target_regime.clone(),
                target_family: model.target_family.clone(),
                indicator_weight: (model.indicator_weight + offset).clamp(0.05, 0.4),
                structure_weight: (model.structure_weight + offset / 2.0).clamp(0.05, 0.35),
                volatility_weight: (model.volatility_weight + if variant % 2 == 0 { offset / 3.0 } else { -offset / 3.0 }).clamp(0.03, 0.22),
                order_flow_weight: (model.order_flow_weight + if variant % 3 == 0 { offset / 2.0 } else { -offset / 4.0 }).clamp(0.04, 0.25),
                sentiment_weight: (model.sentiment_weight + if variant % 2 == 0 { offset / 4.0 } else { -offset / 5.0 }).clamp(0.02, 0.18),
                confirmation_weight: (model.confirmation_weight + if variant % 2 == 1 { offset / 2.0 } else { -offset / 4.0 }).clamp(0.08, 0.3),
                approval_threshold: (model.approval_threshold + if variant % 2 == 0 { offset / 2.0 } else { -offset / 3.0 }).clamp(0.45, 0.82),
            });
        }
    }

    mutated
}

pub fn mutate_indicator_genomes(seed_genomes: &[IndicatorGenome], generation: u32) -> Vec<IndicatorGenome> {
    let mut mutated = Vec::new();

    for (index, genome) in seed_genomes.iter().enumerate() {
        for variant in 0..4 {
            let offset = ((index + variant + 1) as f64 * 0.017).clamp(0.0, 0.11);
            let signed = if variant % 2 == 0 { offset } else { -offset };
            mutated.push(IndicatorGenome {
                id: format!("{}-g{}-m{}", genome.id, generation, variant),
                generation,
                target_symbol: genome.target_symbol.clone(),
                target_regime: genome.target_regime.clone(),
                target_family: genome.target_family.clone(),
                rsi_weight: (genome.rsi_weight + signed * 0.7).clamp(-0.25, 0.25),
                macd_weight: (genome.macd_weight + signed).clamp(-0.25, 0.25),
                breakout_weight: (genome.breakout_weight + signed * 0.8).clamp(-0.25, 0.25),
                mean_reversion_weight: (genome.mean_reversion_weight - signed * 0.7).clamp(-0.25, 0.25),
                momentum_weight: (genome.momentum_weight + signed * 0.75).clamp(-0.25, 0.25),
                volume_weight: (genome.volume_weight + signed * 0.45).clamp(-0.18, 0.18),
                volatility_weight: (genome.volatility_weight - signed * 0.4).clamp(-0.18, 0.18),
                vwap_weight: (genome.vwap_weight + signed * 0.5).clamp(-0.18, 0.18),
                stochastic_weight: (genome.stochastic_weight + signed * 0.55).clamp(-0.18, 0.18),
                cci_weight: (genome.cci_weight + signed * 0.5).clamp(-0.18, 0.18),
                money_flow_weight: (genome.money_flow_weight + signed * 0.45).clamp(-0.18, 0.18),
                ema_trend_weight: (genome.ema_trend_weight + signed * 0.7).clamp(-0.25, 0.25),
                approval_threshold: (genome.approval_threshold + signed * 0.25).clamp(0.38, 0.74),
            });
        }
    }

    mutated
}

pub fn scoped_seed_models(symbols: &[String], regimes: &[MarketRegime]) -> Vec<SignalModel> {
    let mut scoped = Vec::new();

    for symbol in symbols {
        for regime in regimes {
            for family in [
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
            ] {
                scoped.push(SignalModel {
                    id: format!("{}-{:?}-{:?}", symbol.to_lowercase(), regime, family),
                    generation: 0,
                    target_symbol: Some(symbol.clone()),
                    target_regime: Some(format!("{:?}", regime)),
                    target_family: Some(format!("{:?}", family)),
                    indicator_weight: 0.22,
                    structure_weight: 0.2,
                    volatility_weight: 0.12,
                    order_flow_weight: 0.14,
                    sentiment_weight: 0.08,
                    confirmation_weight: 0.18,
                    approval_threshold: 0.6,
                });
            }
        }
    }

    scoped
}

pub fn evaluate_signal_models(models: &[SignalModel], frames: &[ReplayFrame]) -> Vec<EvaluatedSignalModel> {
    let mut evaluated = models
        .iter()
        .map(|model| evaluate_signal_model(model, frames))
        .collect::<Vec<_>>();

    evaluated.sort_by(|left, right| right.fitness_score.total_cmp(&left.fitness_score));
    evaluated
}

pub fn evaluate_indicator_genomes(genomes: &[IndicatorGenome], frames: &[ReplayFrame]) -> Vec<EvaluatedIndicatorGenome> {
    let mut evaluated = genomes
        .iter()
        .map(|genome| evaluate_indicator_genome(genome, frames))
        .filter(|entry| entry.fitness_score > -0.25)
        .collect::<Vec<_>>();

    evaluated.sort_by(|left, right| right.fitness_score.total_cmp(&left.fitness_score));
    evaluated
}

pub fn run_daily_research_cycle(
    day_key: &str,
    frames: &[ReplayFrame],
    prior_report: Option<&ResearchCycleReport>,
) -> ResearchCycleReport {
    let scoped_symbols = frames
        .iter()
        .map(|frame| frame.features.symbol.0.clone())
        .collect::<Vec<_>>();
    let scoped_regimes = frames.iter().map(|frame| frame.regime.regime).collect::<Vec<_>>();
    let mut seed_models = prior_report
        .map(|report| report.leaderboard.iter().take(3).map(|entry| entry.model.clone()).collect::<Vec<_>>())
        .filter(|models| !models.is_empty())
        .unwrap_or_else(|| {
            let mut models = base_signal_models();
            models.extend(scoped_seed_models(&scoped_symbols, &scoped_regimes));
            models
        });
    let next_generation = prior_report
        .and_then(|report| report.promoted_model.as_ref().map(|model| model.model.generation + 1))
        .unwrap_or(1);
    seed_models.extend(mutate_signal_models(&seed_models, next_generation));
    let leaderboard = evaluate_signal_models(&seed_models, frames);
    let promoted_model = leaderboard.first().cloned();

    let mut seed_genomes = prior_report
        .map(|report| {
            report
                .indicator_leaderboard
                .iter()
                .take(3)
                .map(|entry| entry.genome.clone())
                .collect::<Vec<_>>()
        })
        .filter(|genomes| !genomes.is_empty())
        .unwrap_or_else(base_indicator_genomes);
    let next_indicator_generation = prior_report
        .and_then(|report| report.promoted_indicator.as_ref().map(|genome| genome.genome.generation + 1))
        .unwrap_or(1);
    seed_genomes.extend(mutate_indicator_genomes(&seed_genomes, next_indicator_generation));
    let indicator_leaderboard = evaluate_indicator_genomes(&seed_genomes, frames);
    let promoted_indicator = indicator_leaderboard.first().cloned();

    ResearchCycleReport {
        day_key: day_key.to_string(),
        promoted_model,
        leaderboard: leaderboard.into_iter().take(8).collect(),
        promoted_indicator,
        indicator_leaderboard: indicator_leaderboard.into_iter().take(8).collect(),
    }
}

pub fn apply_promoted_model(inputs: &ConfluenceInputs, model: Option<&EvaluatedSignalModel>) -> ConfluenceInputs {
    let Some(model) = model else {
        return inputs.clone();
    };

    let weights = &model.model;
    let weighted_signal = (inputs.indicator_consensus * weights.indicator_weight)
        + (inputs.market_structure_score * weights.structure_weight)
        + (inputs.volatility_fit * weights.volatility_weight)
        + (inputs.order_flow_score * weights.order_flow_weight)
        + (((inputs.news.sentiment_score + 1.0) / 2.0) * weights.sentiment_weight)
        + (inputs.confirmation_score * weights.confirmation_weight);
    let blended = weighted_signal.clamp(0.0, 1.0);

    let mut next = inputs.clone();
    next.indicator_consensus = ((inputs.indicator_consensus * 0.55) + blended * 0.45).clamp(0.0, 1.0);
    next.market_structure_score = ((inputs.market_structure_score * 0.6) + blended * 0.4).clamp(0.0, 1.0);
    next.confirmation_score = ((inputs.confirmation_score * 0.5) + blended * 0.5).clamp(0.0, 1.0);
    next.recent_strategy_performance = ((inputs.recent_strategy_performance * 0.5) + model.fitness_score.clamp(0.0, 1.0) * 0.5).clamp(0.0, 1.0);
    next
}

pub fn apply_promoted_indicator_genome(
    inputs: &ConfluenceInputs,
    indicator_inputs: &IndicatorGeneInputs,
    genome: Option<&EvaluatedIndicatorGenome>,
) -> ConfluenceInputs {
    let Some(genome) = genome else {
        return inputs.clone();
    };

    let composite_signal = score_indicator_genome(indicator_inputs, &genome.genome).clamp(-1.0, 1.0);
    let normalized = ((composite_signal + 1.0) / 2.0).clamp(0.0, 1.0);
    let threshold_headroom = (normalized - genome.genome.approval_threshold).clamp(-0.4, 0.4);
    let fitness_boost = genome.fitness_score.clamp(-1.0, 1.0) * 0.08;

    let mut next = inputs.clone();
    next.indicator_consensus = (inputs.indicator_consensus + threshold_headroom * 0.55 + fitness_boost).clamp(0.0, 1.0);
    next.market_structure_score = (inputs.market_structure_score + threshold_headroom * 0.2).clamp(0.0, 1.0);
    next.confirmation_score = (inputs.confirmation_score + threshold_headroom * 0.35 + fitness_boost * 0.5).clamp(0.0, 1.0);
    next.recent_strategy_performance = (inputs.recent_strategy_performance + genome.fitness_score.clamp(-0.2, 0.25)).clamp(0.0, 1.0);
    next
}

pub fn select_promoted_model<'a>(
    report: &'a ResearchCycleReport,
    symbol: &str,
    regime: MarketRegime,
    family: StrategyFamily,
) -> Option<&'a EvaluatedSignalModel> {
    report
        .leaderboard
        .iter()
        .filter(|entry| signal_model_matches_scope(&entry.model, symbol, regime, family))
        .max_by(|left, right| left.fitness_score.total_cmp(&right.fitness_score))
        .or_else(|| {
            report
                .promoted_model
                .as_ref()
                .filter(|entry| signal_model_matches_scope(&entry.model, symbol, regime, family))
        })
}

pub fn select_promoted_indicator<'a>(
    report: &'a ResearchCycleReport,
    symbol: &str,
    regime: MarketRegime,
    family: StrategyFamily,
) -> Option<&'a EvaluatedIndicatorGenome> {
    report
        .indicator_leaderboard
        .iter()
        .filter(|entry| indicator_genome_matches_scope(&entry.genome, symbol, regime, family))
        .max_by(|left, right| left.fitness_score.total_cmp(&right.fitness_score))
        .or_else(|| {
            report
                .promoted_indicator
                .as_ref()
                .filter(|entry| indicator_genome_matches_scope(&entry.genome, symbol, regime, family))
        })
}

fn signal_model_matches_scope(
    model: &SignalModel,
    symbol: &str,
    regime: MarketRegime,
    family: StrategyFamily,
) -> bool {
    let regime_key = format!("{:?}", regime);
    let family_key = format!("{:?}", family);

    model.target_symbol.as_ref().is_none_or(|value| value == symbol)
        && model.target_regime.as_ref().is_none_or(|value| value == &regime_key)
        && model.target_family.as_ref().is_none_or(|value| value == &family_key)
}

fn indicator_genome_matches_scope(
    genome: &IndicatorGenome,
    symbol: &str,
    regime: MarketRegime,
    family: StrategyFamily,
) -> bool {
    let regime_key = format!("{:?}", regime);
    let family_key = format!("{:?}", family);

    genome.target_symbol.as_ref().is_none_or(|value| value == symbol)
        && genome.target_regime.as_ref().is_none_or(|value| value == &regime_key)
        && genome.target_family.as_ref().is_none_or(|value| value == &family_key)
}

pub fn save_research_cycle_report(path: impl AsRef<Path>, report: &ResearchCycleReport) -> std::io::Result<()> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(report)
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    fs::write(path, json)
}

pub fn load_research_cycle_report(path: impl AsRef<Path>) -> std::io::Result<ResearchCycleReport> {
    let raw = fs::read_to_string(path)?;
    serde_json::from_str(&raw)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string()))
}

fn evaluate_signal_model(model: &SignalModel, frames: &[ReplayFrame]) -> EvaluatedSignalModel {
    let frame_scores = frames
        .iter()
        .map(|frame| {
            let scope_penalty = scope_penalty(model, frame);
            let signal = (frame.confluence_inputs.indicator_consensus * model.indicator_weight)
                + (frame.confluence_inputs.market_structure_score * model.structure_weight)
                + (frame.confluence_inputs.volatility_fit * model.volatility_weight)
                + (frame.confluence_inputs.order_flow_score * model.order_flow_weight)
                + (((frame.confluence_inputs.news.sentiment_score + 1.0) / 2.0) * model.sentiment_weight)
                + (frame.confluence_inputs.confirmation_score * model.confirmation_weight);
            let penalty = frame.confluence_inputs.correlation_penalty
                + if frame.confluence_inputs.news.risk_off { 0.2 } else { 0.0 };
            signal - penalty - scope_penalty - model.approval_threshold
        })
        .collect::<Vec<_>>();
    let approvals = frame_scores.iter().filter(|score| **score > 0.0).count() as f64;
    let profitability_score = if frame_scores.is_empty() {
        0.0
    } else {
        frame_scores.iter().sum::<f64>() / frame_scores.len() as f64 + approvals / frame_scores.len() as f64 * 0.15
    };
    let mean = if frame_scores.is_empty() {
        0.0
    } else {
        frame_scores.iter().sum::<f64>() / frame_scores.len() as f64
    };
    let variance = if frame_scores.is_empty() {
        0.0
    } else {
        frame_scores.iter().map(|score| (score - mean).powi(2)).sum::<f64>() / frame_scores.len() as f64
    };
    let robustness_score = (1.0 - variance.sqrt()).clamp(0.0, 1.0);
    let downside = frame_scores
        .iter()
        .filter(|score| **score < 0.0)
        .map(|score| score.abs())
        .sum::<f64>();
    let risk_adjusted_return = profitability_score / (1.0 + downside.max(0.0));
    let fitness_score = (profitability_score * 0.45 + robustness_score * 0.25 + risk_adjusted_return * 0.3).clamp(-1.0, 1.0);

    EvaluatedSignalModel {
        model: model.clone(),
        profitability_score,
        robustness_score,
        risk_adjusted_return,
        fitness_score,
    }
}

fn evaluate_indicator_genome(genome: &IndicatorGenome, frames: &[ReplayFrame]) -> EvaluatedIndicatorGenome {
    let frame_scores = frames
        .iter()
        .map(|frame| {
            let raw_signal = score_indicator_genome(&frame.indicator_inputs, genome);
            let normalized_signal = normalize_indicator_signal(raw_signal);
            let threshold_headroom = (normalized_signal - genome.approval_threshold).clamp(-0.5, 0.5);
            let scope_penalty = indicator_scope_penalty(genome, frame);
            let risk_penalty = frame.confluence_inputs.correlation_penalty
                + if frame.confluence_inputs.news.risk_off { 0.12 } else { 0.0 };
            threshold_headroom - scope_penalty * 0.35 - risk_penalty * 0.25
        })
        .collect::<Vec<_>>();

    let approvals = frame_scores.iter().filter(|score| **score > 0.0).count() as f64;
    let profitability_score = if frame_scores.is_empty() {
        0.0
    } else {
        frame_scores.iter().sum::<f64>() / frame_scores.len() as f64 + approvals / frame_scores.len() as f64 * 0.25
    };
    let mean = if frame_scores.is_empty() {
        0.0
    } else {
        frame_scores.iter().sum::<f64>() / frame_scores.len() as f64
    };
    let variance = if frame_scores.is_empty() {
        0.0
    } else {
        frame_scores.iter().map(|score| (score - mean).powi(2)).sum::<f64>() / frame_scores.len() as f64
    };
    let robustness_score = (1.0 - variance.sqrt()).clamp(0.0, 1.0);
    let latency_score = estimate_indicator_latency_score(genome);
    let fitness_score = (profitability_score * 0.5 + robustness_score * 0.25 + latency_score * 0.25).clamp(-1.0, 1.0);

    EvaluatedIndicatorGenome {
        genome: genome.clone(),
        profitability_score,
        robustness_score,
        latency_score,
        fitness_score,
    }
}

fn scope_penalty(model: &SignalModel, frame: &ReplayFrame) -> f64 {
    let mut penalty = 0.0;

    if let Some(symbol) = model.target_symbol.as_ref() {
        if symbol != &frame.features.symbol.0 {
            penalty += 0.5;
        }
    }

    if let Some(regime) = model.target_regime.as_ref() {
        if regime != &format!("{:?}", frame.regime.regime) {
            penalty += 0.25;
        }
    }

    if let Some(family) = model.target_family.as_ref() {
        let family_fit = family_fit_score(family, frame.regime.regime);
        penalty += 0.25 * (1.0 - family_fit);
    }

    penalty
}

fn indicator_scope_penalty(genome: &IndicatorGenome, frame: &ReplayFrame) -> f64 {
    let mut penalty = 0.0;

    if let Some(symbol) = genome.target_symbol.as_ref() {
        if symbol != &frame.features.symbol.0 {
            penalty += 0.45;
        }
    }

    if let Some(regime) = genome.target_regime.as_ref() {
        if regime != &format!("{:?}", frame.regime.regime) {
            penalty += 0.22;
        }
    }

    if let Some(family) = genome.target_family.as_ref() {
        let family_fit = family_fit_score(family, frame.regime.regime);
        penalty += 0.2 * (1.0 - family_fit);
    }

    penalty
}

fn score_indicator_genome(inputs: &IndicatorGeneInputs, genome: &IndicatorGenome) -> f64 {
    (inputs.rsi_bias * genome.rsi_weight)
        + (inputs.macd_bias * genome.macd_weight)
        + (inputs.breakout_bias * genome.breakout_weight)
        + (inputs.mean_reversion_bias * genome.mean_reversion_weight)
        + (inputs.momentum_bias * genome.momentum_weight)
        + (inputs.volume_bias * genome.volume_weight)
        + (inputs.volatility_efficiency * genome.volatility_weight)
        + (inputs.vwap_reversion_bias * genome.vwap_weight)
        + (inputs.stochastic_bias * genome.stochastic_weight)
        + (inputs.cci_bias * genome.cci_weight)
        + (inputs.money_flow_bias * genome.money_flow_weight)
        + (inputs.ema_trend_bias * genome.ema_trend_weight)
}

fn normalize_indicator_signal(raw_signal: f64) -> f64 {
    ((raw_signal.clamp(-1.0, 1.0) + 1.0) / 2.0).clamp(0.0, 1.0)
}

fn estimate_indicator_latency_score(genome: &IndicatorGenome) -> f64 {
    let complexity = genome.rsi_weight.abs()
        + genome.macd_weight.abs()
        + genome.breakout_weight.abs()
        + genome.mean_reversion_weight.abs()
        + genome.momentum_weight.abs()
        + genome.volume_weight.abs()
        + genome.volatility_weight.abs()
        + genome.vwap_weight.abs()
        + genome.stochastic_weight.abs()
        + genome.cci_weight.abs()
        + genome.money_flow_weight.abs()
        + genome.ema_trend_weight.abs();

    (1.0 - (complexity / 2.4)).clamp(0.0, 1.0)
}

fn family_fit_score(target_family: &str, regime: MarketRegime) -> f64 {
    match (target_family, regime) {
        ("TrendPullbackContinuation", MarketRegime::Trending)
        | ("MomentumContinuation", MarketRegime::Trending)
        | ("BreakoutConfirmation", MarketRegime::BreakoutExpansion)
        | ("VolatilityCompressionBreakout", MarketRegime::VolatilityCompression)
        | ("LiquiditySweepReversal", MarketRegime::ReversalAttempt)
        | ("MeanReversion", MarketRegime::Ranging)
        | ("VwapReversion", MarketRegime::Ranging)
        | ("SessionSetup", _) => 1.0,
        _ => 0.25,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sthyra_confluence::ConfluenceInputs;
    use sthyra_news_sentiment::NewsSentimentSnapshot;
    use sthyra_replay::ReplayFrame;
    use sthyra_market_data::{FeedHealth, MarketHealthAssessment, RegimeFeatureVector};
    use sthyra_domain::{RegimeAssessment, Symbol};

    #[test]
    fn proposes_bounded_updates() {
        let proposals = propose_weight_updates(&[
            TradeOutcomeRecord {
                symbol: "BTCUSDT".to_string(),
                regime: MarketRegime::Trending,
                strategy: StrategyFamily::TrendPullbackContinuation,
                pnl: 0.35,
                slippage_bps: 1.2,
                ideal_setup_match: true,
            },
            TradeOutcomeRecord {
                symbol: "BTCUSDT".to_string(),
                regime: MarketRegime::Trending,
                strategy: StrategyFamily::TrendPullbackContinuation,
                pnl: 0.15,
                slippage_bps: 1.0,
                ideal_setup_match: true,
            },
        ]);

        assert_eq!(proposals.len(), 1);
        assert!(proposals[0].weight_delta <= 0.2);
        assert!(proposals[0].confidence_threshold_delta <= 0.1);
    }

    #[test]
    fn runs_daily_research_cycle() {
        let frames = vec![ReplayFrame {
            regime: RegimeAssessment::new(MarketRegime::Trending, 0.8).expect("valid regime"),
            features: RegimeFeatureVector {
                symbol: Symbol::new("BTCUSDT").expect("valid symbol"),
                trend_strength: 0.8,
                momentum_quality: 0.75,
                volatility_compression: 0.2,
                liquidity_quality: 0.8,
                order_book_pressure: 0.2,
                inferred_regime_hint: MarketRegime::Trending,
            },
            market_health: MarketHealthAssessment {
                feed_health: FeedHealth::Healthy,
                spread_penalty: 0.05,
                liquidity_penalty: 0.0,
                manipulation_suspected: false,
            },
            indicator_inputs: IndicatorGeneInputs {
                rsi_bias: 0.22,
                macd_bias: 0.27,
                breakout_bias: 0.2,
                mean_reversion_bias: -0.18,
                momentum_bias: 0.31,
                volume_bias: 0.12,
                volatility_efficiency: 0.08,
                vwap_reversion_bias: -0.09,
                stochastic_bias: 0.18,
                cci_bias: 0.16,
                money_flow_bias: 0.11,
                ema_trend_bias: 0.28,
            },
            confluence_inputs: ConfluenceInputs {
                higher_timeframe_alignment: 0.8,
                recent_strategy_performance: 0.7,
                correlation_penalty: 0.1,
                system_health_modifier: 0.8,
                indicator_consensus: 0.8,
                market_structure_score: 0.75,
                volatility_fit: 0.7,
                order_flow_score: 0.7,
                confirmation_score: 0.8,
                news: NewsSentimentSnapshot::default(),
                extras: sthyra_market_data::MarketExtras::default(),
            },
        }];

        let report = run_daily_research_cycle("2026-03-07", &frames, None);
        assert!(!report.leaderboard.is_empty());
        assert!(report.promoted_model.is_some());
        assert!(!report.indicator_leaderboard.is_empty());
        assert!(report.promoted_indicator.is_some());
    }

    #[test]
    fn does_not_fallback_to_mismatched_promoted_indicator() {
        let report = ResearchCycleReport {
            day_key: "2026-03-07".to_string(),
            promoted_model: None,
            leaderboard: Vec::new(),
            promoted_indicator: Some(EvaluatedIndicatorGenome {
                genome: IndicatorGenome {
                    id: "trend-only".to_string(),
                    generation: 1,
                    target_symbol: None,
                    target_regime: Some("Trending".to_string()),
                    target_family: Some("TrendPullbackContinuation".to_string()),
                    rsi_weight: 0.2,
                    macd_weight: 0.2,
                    breakout_weight: 0.2,
                    mean_reversion_weight: -0.1,
                    momentum_weight: 0.2,
                    volume_weight: 0.1,
                    volatility_weight: 0.1,
                    vwap_weight: -0.05,
                    stochastic_weight: 0.1,
                    cci_weight: 0.1,
                    money_flow_weight: 0.1,
                    ema_trend_weight: 0.2,
                    approval_threshold: 0.6,
                },
                profitability_score: 0.1,
                robustness_score: 0.9,
                latency_score: 0.7,
                fitness_score: 0.2,
            }),
            indicator_leaderboard: Vec::new(),
        };

        let selected = select_promoted_indicator(
            &report,
            "BTCUSDT",
            MarketRegime::Ranging,
            StrategyFamily::SessionSetup,
        );

        assert!(selected.is_none());
    }

    #[test]
    fn does_not_fallback_to_mismatched_promoted_model() {
        let report = ResearchCycleReport {
            day_key: "2026-03-07".to_string(),
            promoted_model: Some(EvaluatedSignalModel {
                model: SignalModel {
                    id: "trend-only-model".to_string(),
                    generation: 1,
                    target_symbol: None,
                    target_regime: Some("Trending".to_string()),
                    target_family: Some("TrendPullbackContinuation".to_string()),
                    indicator_weight: 0.2,
                    structure_weight: 0.2,
                    volatility_weight: 0.1,
                    order_flow_weight: 0.1,
                    sentiment_weight: 0.1,
                    confirmation_weight: 0.2,
                    approval_threshold: 0.6,
                },
                profitability_score: 0.1,
                robustness_score: 0.9,
                risk_adjusted_return: 0.2,
                fitness_score: 0.2,
            }),
            leaderboard: Vec::new(),
            promoted_indicator: None,
            indicator_leaderboard: Vec::new(),
        };

        let selected = select_promoted_model(
            &report,
            "BTCUSDT",
            MarketRegime::Ranging,
            StrategyFamily::SessionSetup,
        );

        assert!(selected.is_none());
    }

    #[test]
    fn indicator_research_survives_live_like_inputs() {
        let frames = vec![ReplayFrame {
            regime: RegimeAssessment::new(MarketRegime::Trending, 0.74).expect("valid regime"),
            features: RegimeFeatureVector {
                symbol: Symbol::new("BTCUSDT").expect("valid symbol"),
                trend_strength: 0.61,
                momentum_quality: 0.54,
                volatility_compression: 0.18,
                liquidity_quality: 0.83,
                order_book_pressure: 0.22,
                inferred_regime_hint: MarketRegime::Trending,
            },
            market_health: MarketHealthAssessment {
                feed_health: FeedHealth::Healthy,
                spread_penalty: 0.02,
                liquidity_penalty: 0.0,
                manipulation_suspected: false,
            },
            indicator_inputs: IndicatorGeneInputs {
                rsi_bias: -0.18466076696168476,
                macd_bias: -1.0,
                breakout_bias: -0.05,
                mean_reversion_bias: 0.12,
                momentum_bias: -0.08,
                volume_bias: 0.18,
                volatility_efficiency: 0.09,
                vwap_reversion_bias: 0.03,
                stochastic_bias: -0.14,
                cci_bias: -0.11,
                money_flow_bias: 0.04,
                ema_trend_bias: -0.0002,
            },
            confluence_inputs: ConfluenceInputs {
                higher_timeframe_alignment: 0.7,
                recent_strategy_performance: 0.58,
                correlation_penalty: 0.08,
                system_health_modifier: 0.87,
                indicator_consensus: 0.36,
                market_structure_score: 0.55,
                volatility_fit: 0.52,
                order_flow_score: 0.47,
                confirmation_score: 0.49,
                news: NewsSentimentSnapshot::default(),
                extras: sthyra_market_data::MarketExtras::default(),
            },
        }];

        let evaluated = evaluate_indicator_genomes(&base_indicator_genomes(), &frames);

        assert!(!evaluated.is_empty());
        assert!(evaluated.iter().any(|entry| entry.fitness_score >= 0.0));
    }
}
