use chrono::Utc;
use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sthyra_account_state::{reconcile, AccountSnapshot, PositionState};
use sthyra_backtest::run_backtest;
use sthyra_binance_adapter::{
    build_request, build_signed_request_preview, build_stream_url, validate_order_against_rules,
    BinanceCredentials, BinanceEndpoint, BinanceEnvironment, BinanceHttpClient,
    CancelOrderRequest, ExchangeSymbolRules, ExchangeValidationInput, NewOrderRequest, OrderSide,
    OrderType, StreamKind, ExchangeValidationError, UserTrade,
    FundingRateSnapshot, OpenInterestSnapshot, OrderBookDepth,
};
use sthyra_confluence::{score_candidate, ConfluenceInputs};
use sthyra_config::default_local_config;
use sthyra_event_bus::{EngineTopic, EventPublisher, InMemoryEventBus};
use sthyra_execution::{ExecutionEvent, ExecutionTicket};
use sthyra_learning::{
    apply_promoted_indicator_genome, apply_promoted_model, load_research_cycle_report,
    propose_weight_updates, run_daily_research_cycle, save_research_cycle_report,
    select_promoted_indicator, select_promoted_model,
    EvaluatedIndicatorGenome, EvaluatedSignalModel, ResearchCycleReport,
    TradeOutcomeRecord as LearningTradeOutcomeRecord,
};
use sthyra_market_data::{
    assess_market_health, assess_market_structure, compute_indicator_snapshot,
    compute_htf_trend_bias, compute_return_correlation, compute_oi_delta,
    derive_feature_vector, infer_regime, Candle, IndicatorSnapshot, MarketExtras,
    MarketStructureSnapshot, OrderBookSnapshot, RegimeFeatureVector,
};
use sthyra_mode_authority::{ModeAuthority, TransitionReason};
use sthyra_news_sentiment::{collect_headlines, score_headlines, NewsSentimentSnapshot};
use sthyra_patch_sandbox::{evaluate_proposal, ModuleClass, SandboxProposal};
use sthyra_portfolio::{summarize_exposure, PositionExposure};
use sthyra_replay::{approved_count, run_frame, IndicatorGeneInputs, ReplayFrame};
use sthyra_risk_engine::{RiskGate, RiskSnapshot};
use sthyra_safeguards::SafeguardPolicy;
use sthyra_secrets::KeychainSecretRef;
use sthyra_domain::{RegimeAssessment, Symbol, TradeDecision, OrderIntent};
use sthyra_self_heal::{plan_recovery, RecoveryAction};
use sthyra_storage::{
    write_runtime_snapshot, AuditStore, AuditTrail, ClosedTradeRecord, ExecutionEventRecord,
    IncidentRecord, RuntimeSnapshot, SnapshotBalance, SnapshotCandlePoint, SnapshotIndicatorPoint, SnapshotKpi,
    SnapshotNewsSentiment, SnapshotOpportunity, SnapshotPosition, SnapshotPromotedIndicator,
    SnapshotResearchModel,
    OrderIntentRecord, PositionModelAttribution,
};
use sthyra_strategy_engine::StrategySelector;
use sthyra_watchdog::{evaluate as evaluate_watchdog, HealthStatus, WatchdogSnapshot};

const OPERATOR_MODE_REQUEST_PATH: &str = ".sthyra/operator-mode-request.txt";
const OPERATOR_EVENT_LOG_PATH: &str = ".sthyra/operator-events.ndjson";
const AUDIT_DATABASE_PATH: &str = ".sthyra/audit.sqlite3";
const NEWS_HEADLINES_PATH: &str = ".sthyra/news-headlines.txt";
const RESEARCH_REPORT_PATH: &str = ".sthyra/model-registry.json";
const INDICATOR_BLACKLIST_PATH: &str = ".sthyra/indicator-blacklist.json";
const RESEARCH_DATASET_DIR_ENV: &str = "STHYRA_RESEARCH_DATASET_DIR";
const DISABLE_PROMOTED_INDICATORS_ENV: &str = "STHYRA_DISABLE_PROMOTED_INDICATORS";
const SUPERVISOR_LOCK_PATH: &str = ".sthyra/supervisor.lock";
const POSITION_ENTRY_BACKFILL_WINDOW_MS: u64 = 14 * 24 * 60 * 60 * 1_000;
const POSITION_ENTRY_BACKFILL_MAX_BATCHES: usize = 26;

#[derive(Debug, Clone)]
struct PositionLot {
    sign: f64,
    quantity: f64,
    time_ms: u64,
}

#[derive(Debug, Clone)]
struct MarketIntelligence {
    regime: RegimeAssessment,
    features: RegimeFeatureVector,
    confluence_inputs: ConfluenceInputs,
    indicator_inputs: IndicatorGeneInputs,
    candles: Vec<Candle>,
    news: NewsSentimentSnapshot,
    research_report: Option<ResearchCycleReport>,
}

#[derive(Debug, Clone)]
struct SymbolMarketContext {
    symbol: Symbol,
    book: OrderBookSnapshot,
    market_health: sthyra_market_data::MarketHealthAssessment,
    candles: Vec<Candle>,
}

struct SupervisorInstanceGuard {
    path: &'static str,
    _file: File,
}

impl Drop for SupervisorInstanceGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(self.path);
    }
}

fn main() {
    let _instance_guard = match acquire_supervisor_instance_guard() {
        Ok(guard) => guard,
        Err(error) => {
            eprintln!("sthyra supervisor not started: {error}");
            return;
        }
    };

    let config = default_local_config();
    config.validate().expect("default config should be valid");
    let use_testnet = env::var("STHYRA_BINANCE_USE_TESTNET")
        .map(|value| value == "1")
        .unwrap_or(config.exchange.use_testnet);
    let binance_environment = if use_testnet {
        BinanceEnvironment::Testnet
    } else {
        BinanceEnvironment::Mainnet
    };

    let mut mode_authority = ModeAuthority::new(config.mode);

    let mut event_bus = InMemoryEventBus::default();
    event_bus
        .publish(EngineTopic::Supervisor, "sthyra supervisor booted".to_string())
        .expect("event publishing should not fail");

    let audit_store = AuditStore::open(AUDIT_DATABASE_PATH).expect("audit store should initialize");
    let mut audit_trail = AuditTrail::with_store(audit_store.clone());
    append_operator_event("supervisor-boot", "info", "Supervisor boot sequence complete.", None);

    let mut transport_enabled = env::var("STHYRA_ENABLE_BINANCE_HTTP")
        .map(|value| value == "1")
        .unwrap_or(false);
    let runtime_cycle_limit = match env::var("STHYRA_SUPERVISOR_CYCLES") {
        Ok(value) => match value.parse::<u64>().ok() {
            Some(0) => None,
            Some(parsed) => Some(parsed.max(1)),
            None => Some(1),
        },
        Err(_) => Some(1),
    };
    let cycle_interval_ms = env::var("STHYRA_SUPERVISOR_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(500)
        .max(100);
    let research_refresh_interval_ms = env::var("STHYRA_RESEARCH_REFRESH_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(30 * 60_000)
        .max(60_000);
    let indicator_prune_min_fitness = env::var("STHYRA_INDICATOR_PRUNE_MIN_FITNESS")
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.05)
        .clamp(-0.5, 1.0);
    let indicator_retention_limit = env::var("STHYRA_INDICATOR_RETENTION_LIMIT")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(6)
        .clamp(1, 32);
    let stream_enabled = env::var("STHYRA_ENABLE_BINANCE_STREAM")
        .map(|value| value == "1")
        .unwrap_or(false);
    let trading_enabled = env::var("STHYRA_ENABLE_BINANCE_TRADING")
        .map(|value| value == "1")
        .unwrap_or(false);
    let cancel_after_submit = env::var("STHYRA_CANCEL_AFTER_SUBMIT")
        .map(|value| value == "1")
        .unwrap_or(false);
    let credentials = match (
        env::var("STHYRA_BINANCE_API_KEY").ok(),
        env::var("STHYRA_BINANCE_API_SECRET").ok(),
    ) {
        (Some(api_key), Some(api_secret)) => Some(BinanceCredentials { api_key, api_secret }),
        _ => None,
    };
    let mut transport_status = if transport_enabled {
        "http-enabled".to_string()
    } else {
        "offline-simulated".to_string()
    };
    if transport_enabled && credentials.is_none() {
        audit_trail.record_incident(IncidentRecord {
            mode: mode_authority.current(),
            message: "binance transport requested without API credentials; disabling authenticated transport".to_string(),
        });
        transport_enabled = false;
        transport_status = "http-disabled-missing-credentials".to_string();
    }
    let live_client = if transport_enabled {
        match BinanceHttpClient::new(binance_environment, credentials.clone()) {
            Ok(client) => {
                if credentials.is_some() {
                    transport_status = "http-enabled-private".to_string();
                }
                Some(client)
            }
            Err(error) => {
                audit_trail.record_incident(IncidentRecord {
                    mode: mode_authority.current(),
                    message: format!("binance client init failed: {error}"),
                });
                transport_status = "http-init-failed".to_string();
                None
            }
        }
    } else {
        None
    };

    let symbol = Symbol::new(config.exchange.primary_symbols[0].clone()).expect("valid primary symbol");
    let mut book = OrderBookSnapshot {
        symbol: symbol.clone(),
        best_bid: 100_000.0,
        best_ask: 100_002.0,
        bid_depth: 250_000.0,
        ask_depth: 190_000.0,
        last_update_ms: current_timestamp_ms(),
    };
    if let Some(client) = live_client.as_ref() {
        let live_book_result = if stream_enabled {
            client.fetch_book_ticker_from_stream(&symbol.0)
        } else {
            client.fetch_book_ticker(&symbol.0)
        };

        match live_book_result {
            Ok(remote_book) => match remote_book.to_order_book_snapshot() {
                Ok(snapshot) => {
                    book = snapshot;
                    transport_status = if stream_enabled {
                        format!("{transport_status}+stream-book")
                    } else {
                        format!("{transport_status}+book")
                    };
                }
                Err(error) => audit_trail.record_incident(IncidentRecord {
                    mode: mode_authority.current(),
                    message: format!("book ticker conversion failed: {error}"),
                }),
            },
            Err(error) => audit_trail.record_incident(IncidentRecord {
                mode: mode_authority.current(),
                message: if stream_enabled {
                    format!("book ticker stream failed: {error}")
                } else {
                    format!("book ticker fetch failed: {error}")
                },
            }),
        }
    }
    let market_health = assess_market_health(
        &book,
        current_timestamp_ms(),
        config.watchdog.stale_feed_timeout_secs * 1_000,
    );

    if matches!(market_health.feed_health, sthyra_market_data::FeedHealth::Stale) {
        let _ = mode_authority.request_transition(sthyra_domain::RuntimeMode::Protected, TransitionReason::FeedStale);
    }

    let watchdog = evaluate_watchdog(WatchdogSnapshot {
        feed_health: market_health.feed_health,
        exchange_desynced: false,
        repeated_order_failures: 0,
        engine_heartbeat_missed: false,
        cpu_pressure_high: false,
        disk_pressure_high: false,
    });

    if let Some(reason) = watchdog.suggested_reason {
        match watchdog.status {
            HealthStatus::ProtectedOnly => {
                let _ = mode_authority.request_transition(sthyra_domain::RuntimeMode::Protected, reason);
            }
            HealthStatus::Halted => {
                let _ = mode_authority.request_transition(sthyra_domain::RuntimeMode::Halted, reason);
            }
            _ => {}
        }
    }

    let recovery_actions = plan_recovery(watchdog);

    let previous_research_report = load_research_cycle_report(RESEARCH_REPORT_PATH).ok();
    let research_report = build_or_load_research_report(
        &config.exchange.primary_symbols,
        config.watchdog.stale_feed_timeout_secs * 1_000,
        live_client.as_ref(),
        research_refresh_interval_ms,
        indicator_prune_min_fitness,
        indicator_retention_limit,
    )
    .ok();
    record_research_promotion_changes(
        &mut audit_trail,
        mode_authority.current(),
        previous_research_report.as_ref(),
        research_report.as_ref(),
    );
    let market_intelligence = build_market_intelligence(
        &symbol,
        &book,
        &market_health,
        live_client.as_ref(),
        research_report.as_ref(),
    );
    let regime = market_intelligence.regime;
    let features = market_intelligence.features.clone();
    let confluence_inputs = market_intelligence.confluence_inputs.clone();

    let replay_frame = ReplayFrame {
        regime,
        features: features.clone(),
        market_health: market_health.clone(),
        indicator_inputs: market_intelligence.indicator_inputs.clone(),
        confluence_inputs: confluence_inputs.clone(),
    };
    let replay_result = run_frame(&replay_frame);
    let _backtest_summary = run_backtest(&[replay_frame]);
    let safeguard_policy = SafeguardPolicy::strict_local_default();
    let keychain_ref = KeychainSecretRef {
        service: "sthyra.binance".to_string(),
        account: "api-key".to_string(),
    };
    let keychain_command_preview = format!("{:?}", keychain_ref.build_find_command());
    let _learning_updates = propose_weight_updates(&[LearningTradeOutcomeRecord {
        symbol: symbol.0.clone(),
        regime: regime.regime,
        strategy: sthyra_strategy_engine::StrategyFamily::TrendPullbackContinuation,
        pnl: 0.12,
        slippage_bps: 1.1,
        ideal_setup_match: true,
    }]);
    let exposure_summary = summarize_exposure(&[
        PositionExposure {
            symbol: "BTCUSDT".to_string(),
            notional_usd: 1_000.0,
            correlation_bucket: "majors".to_string(),
        },
        PositionExposure {
            symbol: "ETHUSDT".to_string(),
            notional_usd: 500.0,
            correlation_bucket: "majors".to_string(),
        },
    ]);
    let _sandbox_decision = evaluate_proposal(&SandboxProposal {
        module_name: "strategy-engine".to_string(),
        module_class: ModuleClass::NonCritical,
        tests_passed: true,
        replay_passed: true,
        invariant_checks_passed: true,
    });
    let exchange_info_request = build_request(binance_environment, BinanceEndpoint::ExchangeInfo);
    let signed_preview = build_signed_request_preview(
        &[("symbol", "BTCUSDT"), ("timestamp", "1234567890")],
        "local-secret-preview",
    )
    .expect("HMAC signing with local preview secret should succeed");
    let _book_ticker_stream = build_stream_url(binance_environment, "BTCUSDT", StreamKind::BookTicker);
    let local_snapshot = AccountSnapshot {
        balances: vec![],
        positions: vec![],
        open_orders: vec![],
    };
    let mut exchange_snapshot = AccountSnapshot {
        balances: vec![],
        positions: vec![],
        open_orders: vec![],
    };
    if let Some(client) = live_client.as_ref() {
        match client.fetch_account_snapshot() {
            Ok(snapshot) => {
                exchange_snapshot = snapshot;
                transport_status = format!("{transport_status}+account");
                audit_trail.record_account_balances(&exchange_snapshot.balances);
            }
            Err(error) => audit_trail.record_incident(IncidentRecord {
                mode: mode_authority.current(),
                message: format!("account snapshot fetch skipped: {error}"),
            }),
        }
    }
    let reconciliation_issues = reconcile(&local_snapshot, &exchange_snapshot);
    let configured_symbols = config
        .exchange
        .primary_symbols
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let live_exchange_rules = if let Some(client) = live_client.as_ref() {
        match client.fetch_exchange_rules(&configured_symbols) {
            Ok(rules) if !rules.is_empty() => {
                transport_status = format!("{transport_status}+rules");
                Some(rules)
            }
            Ok(_) => {
                audit_trail.record_incident(IncidentRecord {
                    mode: mode_authority.current(),
                    message: "exchange info fetch returned no matching symbols".to_string(),
                });
                None
            }
            Err(error) => {
                audit_trail.record_incident(IncidentRecord {
                    mode: mode_authority.current(),
                    message: format!("exchange rules fetch failed: {error}"),
                });
                None
            }
        }
    } else {
        None
    };

    let risk_gate = RiskGate::new(config.risk_limits).expect("valid risk limits");

    let (candidates, _) = StrategySelector::select(regime, &features);
    if let Some(candidate) = candidates.first() {
        let _ = execute_candidate(
            candidate,
            regime,
            &features,
            &market_health,
            &confluence_inputs,
            &market_intelligence.indicator_inputs,
            market_intelligence.research_report.as_ref(),
            mode_authority.current(),
            trading_enabled,
            cancel_after_submit,
            live_client.as_ref(),
            live_exchange_rules.as_deref(),
            &audit_store,
            &mut audit_trail,
            watchdog.status,
            &recovery_actions,
            reconciliation_issues.len(),
            exchange_snapshot.positions.len().min(u8::MAX as usize) as u8,
            exchange_snapshot
                .positions
                .iter()
                .map(|position| position.leverage)
                .max()
                .unwrap_or(0),
            &risk_gate,
        );
    } else {
        log_no_candidate(
            &format!("{:?}", mode_authority.current()),
            regime.regime,
            regime.confidence,
        );
    }

    println!(
        "Sthyra supervisor online in {:?} mode with {} symbols",
        mode_authority.current(),
        config.exchange.primary_symbols.len()
    );

    process_pending_operator_mode_request(&mut mode_authority, &mut audit_trail);

    let cached_positions = audit_store
        .read_position_state_cache()
        .unwrap_or_default();
    let mut snapshot = RuntimeSnapshot {
        mode: format!("{:?}", mode_authority.current()),
        venue: "Binance USD-M".to_string(),
        host: {
            #[cfg(target_os = "windows")]
            { "Windows Local Runtime".to_string() }
            #[cfg(target_os = "macos")]
            { "Mac Local Runtime".to_string() }
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            { "Linux Local Runtime".to_string() }
        },
        headline: "Institutional Local Trading Machine".to_string(),
        cycle: 1,
        updated_at: current_timestamp_string(),
        kpis: vec![
            SnapshotKpi {
                label: "System Mode".to_string(),
                value: format!("{:?}", mode_authority.current()),
                tone: if mode_authority.current() == sthyra_domain::RuntimeMode::Protected {
                    "warn".to_string()
                } else {
                    "good".to_string()
                },
            },
            SnapshotKpi {
                label: "Market Confidence".to_string(),
                value: format!("{:.2}", regime.confidence),
                tone: "good".to_string(),
            },
            SnapshotKpi {
                label: "Daily Risk Budget".to_string(),
                value: "61%".to_string(),
                tone: "good".to_string(),
            },
            SnapshotKpi {
                label: "Exchange Sync".to_string(),
                value: if reconciliation_issues.is_empty() {
                    "Aligned".to_string()
                } else {
                    "Diverged".to_string()
                },
                tone: if reconciliation_issues.is_empty() {
                    "good".to_string()
                } else {
                    "risk".to_string()
                },
            },
            SnapshotKpi {
                label: "Feed Health".to_string(),
                value: format!("{:?}", market_health.feed_health),
                tone: if matches!(market_health.feed_health, sthyra_market_data::FeedHealth::Healthy) {
                    "good".to_string()
                } else {
                    "warn".to_string()
                },
            },
            SnapshotKpi {
                label: "Watchdog State".to_string(),
                value: format!("{:?}", watchdog.status),
                tone: if matches!(watchdog.status, HealthStatus::Healthy) {
                    "good".to_string()
                } else {
                    "warn".to_string()
                },
            },
        ],
        opportunities: build_snapshot_opportunities(
            &candidates,
            regime,
            &market_health,
            &confluence_inputs,
            &market_intelligence.indicator_inputs,
            market_intelligence.research_report.as_ref(),
            mode_authority.current(),
        ),
        risk_notes: vec![
            "Per-trade cap 50 bps".to_string(),
            "Daily drawdown 200 bps".to_string(),
            "Concurrent positions 3 max".to_string(),
            "Max leverage 5x runtime cap".to_string(),
            format!("Correlation concentration {:.2} monitored", exposure_summary.max_bucket_concentration),
            safeguard_policy.summary_lines().join(" | "),
        ],
        heal_logs: vec![
            format!("Watchdog {:?}.", watchdog.status),
            format!("Replay validation approved {} candidate(s).", approved_count(&replay_result)),
            format!("Recovery plan {:?}.", recovery_actions),
            format!("Keychain lookup prepared: {}.", keychain_command_preview),
            format!(
                "Promoted indicator {} (overlay {}).",
                market_intelligence
                    .research_report
                    .as_ref()
                    .and_then(|report| report.promoted_indicator.as_ref().map(|entry| entry.genome.id.as_str()))
                    .unwrap_or("none"),
                if promoted_indicators_disabled() { "disabled" } else { "active" }
            ),
        ],
        execution_summary: format!(
            "{} / stream={} / trading={} / cancel_after_submit={} / cycle={}",
            execution_surface_label(mode_authority.current(), trading_enabled),
            stream_enabled,
            trading_enabled,
            cancel_after_submit,
            cycle_status(1, runtime_cycle_limit),
        ),
        exchange_gate: format!(
            "Transport {} via {} with signed path {}",
            transport_status, exchange_info_request.url, signed_preview.signature
        ),
        balances: build_snapshot_balances(&exchange_snapshot),
        positions: build_snapshot_positions(&exchange_snapshot),
        candle_points: {
            let mut pts = Vec::new();
            for sym_str in &config.exchange.primary_symbols {
                if let Ok(sym) = Symbol::new(sym_str.clone()) {
                    let intel = build_market_intelligence(&sym, &book, &market_health, live_client.as_ref(), research_report.as_ref());
                    pts.extend(build_candle_points(&sym.0, &intel.candles));
                }
            }
            pts
        },
        indicator_points: {
            let mut pts = Vec::new();
            for sym_str in &config.exchange.primary_symbols {
                if let Ok(sym) = Symbol::new(sym_str.clone()) {
                    let intel = build_market_intelligence(&sym, &book, &market_health, live_client.as_ref(), research_report.as_ref());
                    pts.extend(build_indicator_points(&sym.0, &intel.candles));
                }
            }
            pts
        },
        research_models: build_snapshot_research_models(market_intelligence.research_report.as_ref()),
        promoted_indicator: build_snapshot_promoted_indicator(market_intelligence.research_report.as_ref()),
        news_sentiment: build_snapshot_news_sentiment(&market_intelligence.news),
    };
    write_runtime_snapshot("apps/desktop/runtime/runtime_snapshot.json", &snapshot)
        .expect("runtime snapshot write should succeed");

    let mut previous_exchange_snapshot = exchange_snapshot.clone();
    let mut last_trade_fetch_ms = audit_store
        .read_trade_fill_watermark_ms()
        .ok()
        .flatten()
        .unwrap_or_else(current_timestamp_ms);
    let startup_trade_fetch_end_ms = current_timestamp_ms();
    backfill_open_position_entry_timestamps(
        live_client.as_ref(),
        &exchange_snapshot.positions,
        &audit_store,
        mode_authority.current(),
        startup_trade_fetch_end_ms,
        &mut audit_trail,
    );
    if !cached_positions.is_empty() {
        let cached_snapshot = AccountSnapshot {
            balances: Vec::new(),
            positions: cached_positions.clone(),
            open_orders: Vec::new(),
        };

        for outcome in detect_closed_trades(
            &cached_snapshot,
            &exchange_snapshot,
            mode_authority.current(),
            &book,
            live_client.as_ref(),
            &audit_store,
            last_trade_fetch_ms.saturating_add(1),
            startup_trade_fetch_end_ms,
        ) {
            audit_trail.record_trade_outcome(outcome);
        }
        reconcile_position_model_attribution(&audit_store, &cached_snapshot, &exchange_snapshot);
        last_trade_fetch_ms = startup_trade_fetch_end_ms;
        if let Err(error) = audit_store.persist_trade_fill_watermark_ms(last_trade_fetch_ms) {
            audit_trail.record_incident(IncidentRecord {
                mode: mode_authority.current(),
                message: format!("startup trade fill watermark persist failed: {error}"),
            });
        }
    }
    if let Err(error) = audit_store.sync_position_entry_timestamps(&cached_positions, &exchange_snapshot.positions) {
        audit_trail.record_incident(IncidentRecord {
            mode: mode_authority.current(),
            message: format!("startup position entry timestamp sync failed: {error}"),
        });
    }
    if let Err(error) = audit_store.persist_position_state_cache(&exchange_snapshot.positions) {
        audit_trail.record_incident(IncidentRecord {
            mode: mode_authority.current(),
            message: format!("startup position cache persist failed: {error}"),
        });
    }
    let mut cycle = 2_u64;
    while runtime_cycle_limit.map(|limit| cycle <= limit).unwrap_or(true) {
            thread::sleep(Duration::from_millis(cycle_interval_ms));

            process_pending_operator_mode_request(&mut mode_authority, &mut audit_trail);

            let mut cycle_transport_status = transport_status.clone();
            let mut cycle_account_snapshot = exchange_snapshot.clone();
            if let Some(client) = live_client.as_ref() {
                let live_book_result = if stream_enabled {
                    client.fetch_book_ticker_from_stream(&symbol.0)
                } else {
                    client.fetch_book_ticker(&symbol.0)
                };

                match live_book_result {
                    Ok(remote_book) => match remote_book.to_order_book_snapshot() {
                        Ok(next_book) => {
                            book = next_book;
                            cycle_transport_status = if stream_enabled {
                                format!("{cycle_transport_status}+stream-book")
                            } else {
                                format!("{cycle_transport_status}+book")
                            };
                        }
                        Err(error) => audit_trail.record_incident(IncidentRecord {
                            mode: mode_authority.current(),
                            message: format!("runtime book conversion failed on cycle {cycle}: {error}"),
                        }),
                    },
                    Err(error) => audit_trail.record_incident(IncidentRecord {
                        mode: mode_authority.current(),
                        message: format!("runtime book refresh failed on cycle {cycle}: {error}"),
                    }),
                }

                match client.fetch_account_snapshot() {
                    Ok(snapshot) => {
                        cycle_account_snapshot = snapshot;
                        cycle_transport_status = format!("{cycle_transport_status}+account");
                        audit_trail.record_account_balances(&cycle_account_snapshot.balances);
                    }
                    Err(error) => audit_trail.record_incident(IncidentRecord {
                        mode: mode_authority.current(),
                        message: format!("runtime account refresh failed on cycle {cycle}: {error}"),
                    }),
                }
            }

            let cycle_trade_fetch_end_ms = current_timestamp_ms();
            exchange_snapshot = cycle_account_snapshot.clone();
            for outcome in detect_closed_trades(
                &previous_exchange_snapshot,
                &cycle_account_snapshot,
                mode_authority.current(),
                &book,
                live_client.as_ref(),
                &audit_store,
                last_trade_fetch_ms.saturating_add(1),
                cycle_trade_fetch_end_ms,
            ) {
                audit_trail.record_trade_outcome(outcome);
            }
            reconcile_position_model_attribution(&audit_store, &previous_exchange_snapshot, &cycle_account_snapshot);
            if let Err(error) = audit_store.sync_position_entry_timestamps(
                &previous_exchange_snapshot.positions,
                &cycle_account_snapshot.positions,
            ) {
                audit_trail.record_incident(IncidentRecord {
                    mode: mode_authority.current(),
                    message: format!("position entry timestamp sync failed on cycle {cycle}: {error}"),
                });
            }
            previous_exchange_snapshot = cycle_account_snapshot.clone();
            last_trade_fetch_ms = cycle_trade_fetch_end_ms;
            if let Err(error) = audit_store.persist_trade_fill_watermark_ms(last_trade_fetch_ms) {
                audit_trail.record_incident(IncidentRecord {
                    mode: mode_authority.current(),
                    message: format!("trade fill watermark persist failed on cycle {cycle}: {error}"),
                });
            }
            if let Err(error) = audit_store.persist_position_state_cache(&cycle_account_snapshot.positions) {
                audit_trail.record_incident(IncidentRecord {
                    mode: mode_authority.current(),
                    message: format!("position cache persist failed on cycle {cycle}: {error}"),
                });
            }
            let cycle_reconciliation_issues = reconcile(&local_snapshot, &cycle_account_snapshot);

            let cycle_market_health = assess_market_health(
                &book,
                current_timestamp_ms(),
                config.watchdog.stale_feed_timeout_secs * 1_000,
            );
            let cycle_watchdog = evaluate_watchdog(WatchdogSnapshot {
                feed_health: cycle_market_health.feed_health,
                exchange_desynced: !cycle_reconciliation_issues.is_empty(),
                repeated_order_failures: 0,
                engine_heartbeat_missed: false,
                cpu_pressure_high: false,
                disk_pressure_high: false,
            });

            let previous_cycle_research_report = load_research_cycle_report(RESEARCH_REPORT_PATH).ok();
            let cycle_research_report = build_or_load_research_report(
                &config.exchange.primary_symbols,
                config.watchdog.stale_feed_timeout_secs * 1_000,
                live_client.as_ref(),
                research_refresh_interval_ms,
                indicator_prune_min_fitness,
                indicator_retention_limit,
            )
            .ok();
            record_research_promotion_changes(
                &mut audit_trail,
                mode_authority.current(),
                previous_cycle_research_report.as_ref(),
                cycle_research_report.as_ref(),
            );
            let cycle_market_intelligence = build_market_intelligence(
                &symbol,
                &book,
                &cycle_market_health,
                live_client.as_ref(),
                cycle_research_report.as_ref(),
            );
            let cycle_regime = cycle_market_intelligence.regime;
            let cycle_features = cycle_market_intelligence.features.clone();
            let cycle_confluence_inputs = cycle_market_intelligence.confluence_inputs.clone();
            let cycle_indicator_inputs = cycle_market_intelligence.indicator_inputs.clone();
            let (cycle_candidates, _) = StrategySelector::select(cycle_regime, &cycle_features);
            let cycle_execution_mode = mode_authority.current();
            let cycle_execution_posture = cycle_candidates
                .first()
                .map(|candidate| {
                    execute_candidate(
                        candidate,
                        cycle_regime,
                        &cycle_features,
                        &cycle_market_health,
                        &cycle_confluence_inputs,
                        &cycle_indicator_inputs,
                        cycle_market_intelligence.research_report.as_ref(),
                        cycle_execution_mode,
                        trading_enabled,
                        cancel_after_submit,
                        live_client.as_ref(),
                        live_exchange_rules.as_deref(),
                        &audit_store,
                        &mut audit_trail,
                        cycle_watchdog.status,
                        &recovery_actions,
                        cycle_reconciliation_issues.len(),
                        cycle_account_snapshot.positions.len().min(u8::MAX as usize) as u8,
                        cycle_account_snapshot
                            .positions
                            .iter()
                            .map(|position| position.leverage)
                            .max()
                            .unwrap_or(0),
                        &risk_gate,
                    )
                })
                .unwrap_or_else(|| {
                    log_no_candidate(
                        execution_surface_label(cycle_execution_mode, trading_enabled),
                        cycle_regime.regime,
                        cycle_regime.confidence,
                    );
                    format!(
                        "{} / mode={:?} / decision=NoCandidate / risk=Unavailable",
                        execution_surface_label(cycle_execution_mode, trading_enabled),
                        cycle_execution_mode,
                    )
                });
            snapshot.cycle = cycle;
            snapshot.mode = format!("{:?}", mode_authority.current());
            snapshot.updated_at = current_timestamp_string();
            snapshot.execution_summary = format!(
                "{} / stream={} / trading={} / cancel_after_submit={} / cycle={}",
                cycle_execution_posture,
                stream_enabled,
                trading_enabled,
                cancel_after_submit,
                cycle_status(cycle, runtime_cycle_limit),
            );
            snapshot.exchange_gate = format!(
                "Transport {} via {} with signed path {}",
                cycle_transport_status, exchange_info_request.url, signed_preview.signature
            );
            snapshot.balances = build_snapshot_balances(&cycle_account_snapshot);
            snapshot.positions = build_snapshot_positions(&cycle_account_snapshot);

            // ── Multi-symbol scan ─────────────────────────────────────────────
            // Run market intelligence + strategy selection for every configured
            // symbol and aggregate candle points, indicator points, and
            // opportunities across all symbols, sorted by confluence confidence.
            let multi_symbol_contexts = collect_symbol_market_contexts(
                &config.exchange.primary_symbols,
                config.watchdog.stale_feed_timeout_secs * 1_000,
                live_client.as_ref(),
            );
            let mut all_candle_points: Vec<SnapshotCandlePoint> = Vec::new();
            let mut all_indicator_points: Vec<SnapshotIndicatorPoint> = Vec::new();
            let mut all_opportunities: Vec<SnapshotOpportunity> = Vec::new();
            for ctx in &multi_symbol_contexts {
                let ctx_intelligence = build_market_intelligence(
                    &ctx.symbol,
                    &ctx.book,
                    &ctx.market_health,
                    live_client.as_ref(),
                    cycle_research_report.as_ref(),
                );
                let ctx_regime = ctx_intelligence.regime;
                let ctx_features = ctx_intelligence.features.clone();
                let (ctx_candidates, _) = StrategySelector::select(ctx_regime, &ctx_features);
                let ctx_ops = build_snapshot_opportunities(
                    &ctx_candidates,
                    ctx_regime,
                    &ctx.market_health,
                    &ctx_intelligence.confluence_inputs,
                    &ctx_intelligence.indicator_inputs,
                    cycle_research_report.as_ref(),
                    mode_authority.current(),
                );
                // Only include real candidates (not placeholder NoCandidate entries)
                for op in ctx_ops {
                    if op.family != "NoCandidate" {
                        all_opportunities.push(op);
                    }
                }
                all_candle_points.extend(build_candle_points(&ctx.symbol.0, &ctx_intelligence.candles));
                all_indicator_points.extend(build_indicator_points(&ctx.symbol.0, &ctx_intelligence.candles));
            }
            // Sort opportunities: highest confidence first
            all_opportunities.sort_by(|a, b| {
                let ca = a.confidence.parse::<f64>().unwrap_or(0.0);
                let cb = b.confidence.parse::<f64>().unwrap_or(0.0);
                cb.partial_cmp(&ca).unwrap_or(std::cmp::Ordering::Equal)
            });
            // Deduplicate by (symbol, model_id) — keep first (highest confidence) occurrence.
            // The same promoted model can be selected for multiple candidates of the same symbol,
            // producing identical keys that break React rendering.
            {
                let mut seen = std::collections::HashSet::new();
                all_opportunities.retain(|op| seen.insert((op.symbol.clone(), op.model_id.clone())));
            }
            // Fallback if truly no opportunities across all symbols
            if all_opportunities.is_empty() {
                all_opportunities.push(SnapshotOpportunity {
                    symbol: symbol.0.clone(),
                    family: "NoCandidate".to_string(),
                    regime: format!("{:?}", cycle_regime.regime),
                    model_id: "base-runtime".to_string(),
                    model_scope: "All / All / All".to_string(),
                    confidence: "0.00".to_string(),
                    action: "StandDown".to_string(),
                    funding_rate: 0.0,
                    htf_trend_bias: 0.0,
                    depth_imbalance: 0.0,
                    oi_delta: 0.0,
                    btc_correlation: 0.0,
                });
            }
            snapshot.candle_points = all_candle_points;
            snapshot.indicator_points = all_indicator_points;
            snapshot.opportunities = all_opportunities;
            // ── End multi-symbol scan ─────────────────────────────────────────

            snapshot.research_models = build_snapshot_research_models(cycle_market_intelligence.research_report.as_ref());
            snapshot.promoted_indicator = build_snapshot_promoted_indicator(cycle_market_intelligence.research_report.as_ref());
            snapshot.news_sentiment = build_snapshot_news_sentiment(&cycle_market_intelligence.news);
            snapshot.heal_logs = vec![
                format!("Watchdog {:?}.", cycle_watchdog.status),
                format!("Replay validation approved {} candidate(s).", approved_count(&replay_result)),
                format!("Recovery plan {:?}.", recovery_actions),
                format!(
                    "Research model {} active.",
                    cycle_market_intelligence
                        .research_report
                        .as_ref()
                        .and_then(|report| report.promoted_model.as_ref().map(|model| model.model.id.as_str()))
                        .unwrap_or("none")
                ),
                format!(
                    "Promoted indicator {} (overlay {}).",
                    cycle_market_intelligence
                        .research_report
                        .as_ref()
                        .and_then(|report| report.promoted_indicator.as_ref().map(|entry| entry.genome.id.as_str()))
                        .unwrap_or("none"),
                    if promoted_indicators_disabled() { "disabled" } else { "active" }
                ),
                format!("Multi-symbol scan: {} symbols, {} opportunities.", multi_symbol_contexts.len(), snapshot.opportunities.len()),
                format!("Runtime refresh cycle {} at {}.", cycle, snapshot.updated_at),
            ];
            update_kpi(
                &mut snapshot.kpis,
                "Market Confidence",
                format!("{:.2}", cycle_regime.confidence),
                if cycle_regime.confidence >= 0.7 { "good" } else { "warn" },
            );
            update_kpi(
                &mut snapshot.kpis,
                "System Mode",
                format!("{:?}", mode_authority.current()),
                if matches!(mode_authority.current(), sthyra_domain::RuntimeMode::Protected | sthyra_domain::RuntimeMode::Halted) {
                    "warn"
                } else {
                    "good"
                },
            );
            update_kpi(
                &mut snapshot.kpis,
                "Feed Health",
                format!("{:?}", cycle_market_health.feed_health),
                if matches!(cycle_market_health.feed_health, sthyra_market_data::FeedHealth::Healthy) {
                    "good"
                } else {
                    "warn"
                },
            );
            update_kpi(
                &mut snapshot.kpis,
                "Watchdog State",
                format!("{:?}", cycle_watchdog.status),
                if matches!(cycle_watchdog.status, HealthStatus::Healthy) {
                    "good"
                } else {
                    "warn"
                },
            );
            update_kpi(
                &mut snapshot.kpis,
                "Exchange Sync",
                if cycle_reconciliation_issues.is_empty() {
                    "Aligned".to_string()
                } else {
                    "Diverged".to_string()
                },
                if cycle_reconciliation_issues.is_empty() {
                    "good"
                } else {
                    "risk"
                },
            );

            write_runtime_snapshot("apps/desktop/runtime/runtime_snapshot.json", &snapshot)
                .expect("runtime snapshot refresh should succeed");
            cycle += 1;
    }
}

fn cycle_status(current_cycle: u64, limit: Option<u64>) -> String {
    match limit {
        Some(limit) => format!("{current_cycle}/{limit}"),
        None => format!("{current_cycle}/live"),
    }
}

fn update_kpi(kpis: &mut [SnapshotKpi], label: &str, value: String, tone: &str) {
    if let Some(kpi) = kpis.iter_mut().find(|kpi| kpi.label == label) {
        kpi.value = value;
        kpi.tone = tone.to_string();
    }
}

fn build_snapshot_opportunities(
    candidates: &[sthyra_strategy_engine::StrategyCandidate],
    regime: RegimeAssessment,
    market_health: &sthyra_market_data::MarketHealthAssessment,
    confluence_inputs: &ConfluenceInputs,
    indicator_inputs: &IndicatorGeneInputs,
    research_report: Option<&ResearchCycleReport>,
    mode: sthyra_domain::RuntimeMode,
) -> Vec<SnapshotOpportunity> {
    let mut opportunities = candidates
        .iter()
        .take(3)
        .map(|candidate| {
            let selected_inputs = candidate_confluence_inputs(candidate, confluence_inputs, indicator_inputs, research_report);
            let confluence = score_candidate(candidate, regime, market_health, &selected_inputs);
            let selected_model = research_report.and_then(|report| {
                select_promoted_model(report, &candidate.symbol.0, candidate.regime, candidate.family)
            });
            let (model_id, model_scope) = match selected_model {
                Some(model) => (
                    model.model.id.clone(),
                    format!(
                        "{} / {} / {}",
                        model.model.target_symbol.as_deref().unwrap_or("All"),
                        model.model.target_family.as_deref().unwrap_or("All"),
                        model.model.target_regime.as_deref().unwrap_or("All"),
                    ),
                ),
                None => ("base-runtime".to_string(), "All / All / All".to_string()),
            };
            SnapshotOpportunity {
                symbol: candidate.symbol.0.clone(),
                family: format!("{:?}", candidate.family),
                regime: format!("{:?}", candidate.regime),
                model_id,
                model_scope,
                confidence: format!("{:.2}", confluence.confidence_score),
                action: opportunity_action_for_mode(mode, confluence.decision),
                funding_rate: selected_inputs.extras.funding_rate,
                htf_trend_bias: selected_inputs.extras.htf_trend_bias,
                depth_imbalance: selected_inputs.extras.depth_imbalance,
                oi_delta: selected_inputs.extras.open_interest_delta,
                btc_correlation: selected_inputs.extras.btc_correlation,
            }
        })
        .collect::<Vec<_>>();

    if opportunities.is_empty() {
        opportunities.push(SnapshotOpportunity {
            symbol: "BTCUSDT".to_string(),
            family: "NoCandidate".to_string(),
            regime: format!("{:?}", regime.regime),
            model_id: "base-runtime".to_string(),
            model_scope: "All / All / All".to_string(),
            confidence: "0.00".to_string(),
            action: "StandDown".to_string(),
            funding_rate: 0.0,
            htf_trend_bias: 0.0,
            depth_imbalance: 0.0,
            oi_delta: 0.0,
            btc_correlation: 0.0,
        });
    }

    opportunities
}

fn build_snapshot_balances(snapshot: &AccountSnapshot) -> Vec<SnapshotBalance> {
    snapshot
        .balances
        .iter()
        .map(|balance| SnapshotBalance {
            asset: balance.asset.clone(),
            wallet_balance: balance.wallet_balance,
        })
        .collect()
}

fn build_snapshot_positions(snapshot: &AccountSnapshot) -> Vec<SnapshotPosition> {
    snapshot
        .positions
        .iter()
        .filter(|position| position.quantity.abs() > f64::EPSILON)
        .map(|position| SnapshotPosition {
            symbol: position.symbol.clone(),
            quantity: position.quantity,
            entry_price: position.entry_price,
            leverage: position.leverage,
            unrealized_pnl: position.unrealized_pnl,
            notional_usd: position.quantity.abs() * position.entry_price,
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn detect_closed_trades(
    previous: &AccountSnapshot,
    current: &AccountSnapshot,
    mode: sthyra_domain::RuntimeMode,
    book: &OrderBookSnapshot,
    live_client: Option<&BinanceHttpClient>,
    audit_store: &AuditStore,
    trade_fetch_start_ms: u64,
    trade_fetch_end_ms: u64,
) -> Vec<ClosedTradeRecord> {
    let current_positions = current
        .positions
        .iter()
        .filter(|position| position.quantity.abs() > f64::EPSILON)
        .map(|position| (position.symbol.clone(), position))
        .collect::<HashMap<_, _>>();
    let mut recent_trades_by_symbol = HashMap::<String, Vec<UserTrade>>::new();

    previous
        .positions
        .iter()
        .filter(|position| position.quantity.abs() > f64::EPSILON)
        .filter_map(|previous_position| {
            let current_position = current_positions.get(&previous_position.symbol).copied();
            let previous_abs_qty = previous_position.quantity.abs();
            let (closed_quantity, close_reason) = match current_position {
                None => (previous_abs_qty, "position-flat"),
                Some(next_position) if previous_position.quantity.signum() != next_position.quantity.signum() => {
                    (previous_abs_qty, "position-flipped")
                }
                Some(next_position) => {
                    let next_abs_qty = next_position.quantity.abs();
                    if next_abs_qty + f64::EPSILON < previous_abs_qty {
                        (previous_abs_qty - next_abs_qty, "position-reduced")
                    } else {
                        (0.0, "")
                    }
                }
            };

            if closed_quantity <= f64::EPSILON {
                return None;
            }

            if let Some(exact_outcome) = build_exact_closed_trade_record(
                previous_position,
                closed_quantity,
                close_reason,
                mode,
                live_client,
                audit_store,
                &mut recent_trades_by_symbol,
                trade_fetch_start_ms,
                trade_fetch_end_ms,
            ) {
                return Some(exact_outcome);
            }

            let exit_price = estimated_exit_price(previous_position, book);
            let realized_pnl = if previous_position.quantity > 0.0 {
                (exit_price - previous_position.entry_price) * closed_quantity
            } else {
                (previous_position.entry_price - exit_price) * closed_quantity
            };
            let entry_notional = previous_position.entry_price * closed_quantity;
            let attribution = lookup_model_attribution(audit_store, &previous_position.symbol);

            Some(ClosedTradeRecord {
                timestamp_ms: current_timestamp_ms(),
                entry_timestamp_ms: audit_store.read_position_entry_timestamp_ms(&previous_position.symbol).ok().flatten(),
                symbol: previous_position.symbol.clone(),
                mode,
                side: if previous_position.quantity > 0.0 {
                    "Long".to_string()
                } else {
                    "Short".to_string()
                },
                quantity: closed_quantity,
                entry_price: previous_position.entry_price,
                exit_price,
                realized_pnl,
                pnl_ratio: if entry_notional.abs() > f64::EPSILON {
                    realized_pnl / entry_notional
                } else {
                    0.0
                },
                close_reason: close_reason.to_string(),
                source: "snapshot-diff-estimated-exit".to_string(),
                model_id: attribution.model_id,
                model_scope: attribution.model_scope,
                indicator_id: attribution.indicator_id,
                indicator_scope: attribution.indicator_scope,
            })
        })
        .collect()
}

fn backfill_open_position_entry_timestamps(
    live_client: Option<&BinanceHttpClient>,
    positions: &[PositionState],
    audit_store: &AuditStore,
    mode: sthyra_domain::RuntimeMode,
    trade_fetch_end_ms: u64,
    audit_trail: &mut AuditTrail,
) {
    let Some(client) = live_client else {
        return;
    };

    for position in positions.iter().filter(|position| position.quantity.abs() > f64::EPSILON) {
        match infer_position_entry_timestamp_from_exchange(client, position, trade_fetch_end_ms) {
            Ok(Some(entry_timestamp_ms)) => {
                if let Err(error) = audit_store.persist_position_entry_timestamp(&position.symbol, entry_timestamp_ms) {
                    audit_trail.record_incident(IncidentRecord {
                        mode,
                        message: format!(
                            "position entry timestamp backfill persist failed for {}: {}",
                            position.symbol, error
                        ),
                    });
                }
            }
            Ok(None) => {}
            Err(error) => audit_trail.record_incident(IncidentRecord {
                mode,
                message: format!(
                    "position entry timestamp backfill failed for {}: {}",
                    position.symbol, error
                ),
            }),
        }
    }
}

fn infer_position_entry_timestamp_from_exchange(
    client: &BinanceHttpClient,
    position: &PositionState,
    trade_fetch_end_ms: u64,
) -> Result<Option<u64>, String> {
    if position.quantity.abs() <= f64::EPSILON {
        return Ok(None);
    }

    let mut fetched_trades = Vec::<UserTrade>::new();
    let mut cursor_end_ms = trade_fetch_end_ms;
    let mut history_complete = false;

    for _ in 0..POSITION_ENTRY_BACKFILL_MAX_BATCHES {
        let window_start_ms = cursor_end_ms.saturating_sub(POSITION_ENTRY_BACKFILL_WINDOW_MS);
        let mut batch = client
            .fetch_user_trades(&position.symbol, Some(window_start_ms), Some(cursor_end_ms))
            .map_err(|error| error.to_string())?;

        if batch.is_empty() {
            history_complete = true;
            break;
        }

        batch.sort_by_key(|trade| trade.time_ms);
        let oldest_trade_time_ms = batch.first().map(|trade| trade.time_ms).unwrap_or(cursor_end_ms);
        fetched_trades.extend(batch);
        fetched_trades.sort_by_key(|trade| trade.time_ms);
        fetched_trades.dedup_by(|left, right| {
            left.order_id == right.order_id
                && left.time_ms == right.time_ms
                && (left.quantity - right.quantity).abs() < 1e-8
                && (left.price - right.price).abs() < 1e-8
                && left.is_buy == right.is_buy
        });

        if let Some(entry_timestamp_ms) = infer_position_entry_timestamp_from_trades(
            &fetched_trades,
            position.quantity,
            history_complete,
        ) {
            return Ok(Some(entry_timestamp_ms));
        }

        if oldest_trade_time_ms == 0 || oldest_trade_time_ms <= window_start_ms {
            cursor_end_ms = oldest_trade_time_ms.saturating_sub(1);
        } else {
            cursor_end_ms = window_start_ms.saturating_sub(1);
        }
    }

    if history_complete {
        Ok(infer_position_entry_timestamp_from_trades(
            &fetched_trades,
            position.quantity,
            true,
        ))
    } else {
        Ok(None)
    }
}

fn infer_position_entry_timestamp_from_trades(
    trades: &[UserTrade],
    current_quantity: f64,
    history_complete: bool,
) -> Option<u64> {
    if trades.is_empty() || current_quantity.abs() <= f64::EPSILON {
        return None;
    }

    let current_sign = current_quantity.signum();
    let current_abs_quantity = current_quantity.abs();
    let mut lots = VecDeque::<PositionLot>::new();
    let mut saw_flat_reset = false;

    for trade in trades {
        let trade_sign = if trade.is_buy { 1.0 } else { -1.0 };
        let mut remaining_quantity = trade.quantity;

        while remaining_quantity > f64::EPSILON {
            let front_sign = lots.front().map(|lot| lot.sign);
            if let Some(front_sign) = front_sign {
                if front_sign != trade_sign {
                    let offset_quantity = lots
                        .front()
                        .map(|lot| lot.quantity.min(remaining_quantity))
                        .unwrap_or(0.0);
                    if let Some(front_lot) = lots.front_mut() {
                        front_lot.quantity -= offset_quantity;
                    }
                    remaining_quantity -= offset_quantity;
                    if lots.front().map(|lot| lot.quantity <= f64::EPSILON).unwrap_or(false) {
                        lots.pop_front();
                    }
                    if lots.is_empty() {
                        saw_flat_reset = true;
                    }
                    continue;
                }
            }

            lots.push_back(PositionLot {
                sign: trade_sign,
                quantity: remaining_quantity,
                time_ms: trade.time_ms,
            });
            remaining_quantity = 0.0;
        }
    }

    if lots.is_empty() || lots.iter().any(|lot| lot.sign != current_sign) {
        return None;
    }

    let inferred_quantity = lots.iter().map(|lot| lot.quantity).sum::<f64>();
    if (inferred_quantity - current_abs_quantity).abs() > 1e-6 {
        return None;
    }

    if !saw_flat_reset && !history_complete {
        return None;
    }

    lots.front().map(|lot| lot.time_ms)
}

#[allow(clippy::too_many_arguments)]
fn build_exact_closed_trade_record(
    previous_position: &PositionState,
    closed_quantity: f64,
    close_reason: &str,
    mode: sthyra_domain::RuntimeMode,
    live_client: Option<&BinanceHttpClient>,
    audit_store: &AuditStore,
    recent_trades_by_symbol: &mut HashMap<String, Vec<UserTrade>>,
    trade_fetch_start_ms: u64,
    trade_fetch_end_ms: u64,
) -> Option<ClosedTradeRecord> {
    let client = live_client?;
    if trade_fetch_end_ms < trade_fetch_start_ms {
        return None;
    }

    if !recent_trades_by_symbol.contains_key(&previous_position.symbol) {
        let trades = client
            .fetch_user_trades(
                &previous_position.symbol,
                Some(trade_fetch_start_ms),
                Some(trade_fetch_end_ms),
            )
            .ok()?;
        recent_trades_by_symbol.insert(previous_position.symbol.clone(), trades);
    }

    let trades = recent_trades_by_symbol.get(&previous_position.symbol)?;
    let is_closing_buy = previous_position.quantity < 0.0;
    let mut remaining_quantity = closed_quantity;
    let mut matched_quantity = 0.0;
    let mut weighted_exit_notional = 0.0;
    let mut realized_pnl = 0.0;
    let mut latest_trade_time_ms = 0_u64;

    for trade in trades
        .iter()
        .filter(|trade| trade.time_ms >= trade_fetch_start_ms && trade.time_ms <= trade_fetch_end_ms)
        .filter(|trade| trade.is_buy == is_closing_buy)
    {
        if remaining_quantity <= f64::EPSILON {
            break;
        }
        if trade.quantity <= f64::EPSILON {
            continue;
        }

        let matched_trade_quantity = trade.quantity.min(remaining_quantity);
        let matched_ratio = matched_trade_quantity / trade.quantity;
        matched_quantity += matched_trade_quantity;
        weighted_exit_notional += trade.price * matched_trade_quantity;
        realized_pnl += trade.realized_pnl * matched_ratio;
        latest_trade_time_ms = latest_trade_time_ms.max(trade.time_ms);
        remaining_quantity -= matched_trade_quantity;
    }

    if matched_quantity + 1e-8 < closed_quantity {
        return None;
    }

    let exit_price = weighted_exit_notional / matched_quantity;
    let entry_notional = previous_position.entry_price * matched_quantity;
    let attribution = lookup_model_attribution(audit_store, &previous_position.symbol);

    Some(ClosedTradeRecord {
        timestamp_ms: if latest_trade_time_ms > 0 {
            latest_trade_time_ms
        } else {
            current_timestamp_ms()
        },
        entry_timestamp_ms: audit_store.read_position_entry_timestamp_ms(&previous_position.symbol).ok().flatten(),
        symbol: previous_position.symbol.clone(),
        mode,
        side: if previous_position.quantity > 0.0 {
            "Long".to_string()
        } else {
            "Short".to_string()
        },
        quantity: matched_quantity,
        entry_price: previous_position.entry_price,
        exit_price,
        realized_pnl,
        pnl_ratio: if entry_notional.abs() > f64::EPSILON {
            realized_pnl / entry_notional
        } else {
            0.0
        },
        close_reason: close_reason.to_string(),
        source: "binance-user-trades".to_string(),
        model_id: attribution.model_id,
        model_scope: attribution.model_scope,
        indicator_id: attribution.indicator_id,
        indicator_scope: attribution.indicator_scope,
    })
}

fn lookup_model_attribution(audit_store: &AuditStore, symbol: &str) -> PositionModelAttribution {
    audit_store
        .read_position_model_attribution(symbol)
        .ok()
        .flatten()
        .unwrap_or_else(|| PositionModelAttribution {
            symbol: symbol.to_string(),
            model_id: "unknown".to_string(),
            model_scope: "Unknown / Unknown / Unknown".to_string(),
            indicator_id: "none".to_string(),
            indicator_scope: "All / All / All".to_string(),
        })
}

fn persist_active_position_model_attribution(
    audit_store: &AuditStore,
    symbol: &str,
    model: Option<&EvaluatedSignalModel>,
    indicator: Option<&EvaluatedIndicatorGenome>,
) {
    let attribution = PositionModelAttribution {
        symbol: symbol.to_string(),
        model_id: model
            .map(|entry| entry.model.id.clone())
            .unwrap_or_else(|| "base-runtime".to_string()),
        model_scope: model
            .map(model_scope_label)
            .unwrap_or_else(|| "All / All / All".to_string()),
        indicator_id: indicator
            .map(|entry| entry.genome.id.clone())
            .unwrap_or_else(|| "none".to_string()),
        indicator_scope: indicator
            .map(indicator_scope_label)
            .unwrap_or_else(|| "All / All / All".to_string()),
    };

    if let Err(error) = audit_store.persist_position_model_attribution(&attribution) {
        eprintln!("failed to persist position model attribution for {}: {}", symbol, error);
    }
}

fn reconcile_position_model_attribution(
    audit_store: &AuditStore,
    previous: &AccountSnapshot,
    current: &AccountSnapshot,
) {
    let current_positions = current
        .positions
        .iter()
        .filter(|position| position.quantity.abs() > f64::EPSILON)
        .map(|position| (position.symbol.as_str(), position.quantity.signum()))
        .collect::<HashMap<_, _>>();

    for previous_position in previous
        .positions
        .iter()
        .filter(|position| position.quantity.abs() > f64::EPSILON)
    {
        let should_delete = match current_positions.get(previous_position.symbol.as_str()) {
            None => true,
            Some(current_sign) => *current_sign != previous_position.quantity.signum(),
        };

        if should_delete {
            let _ = audit_store.delete_position_model_attribution(&previous_position.symbol);
        }
    }
}

fn estimated_exit_price(position: &PositionState, book: &OrderBookSnapshot) -> f64 {
    if position.quantity.abs() > f64::EPSILON && position.unrealized_pnl.is_finite() {
        let implied_mark = position.entry_price + (position.unrealized_pnl / position.quantity);
        if implied_mark.is_finite() && implied_mark > 0.0 {
            return implied_mark;
        }
    }

    if book.symbol.0 == position.symbol {
        return (book.best_bid + book.best_ask) / 2.0;
    }

    position.entry_price
}

fn execution_surface_label(mode: sthyra_domain::RuntimeMode, trading_enabled: bool) -> &'static str {
    match mode {
        sthyra_domain::RuntimeMode::SemiAuto | sthyra_domain::RuntimeMode::FullAuto if trading_enabled => "LivePathArmed",
        sthyra_domain::RuntimeMode::SemiAuto | sthyra_domain::RuntimeMode::FullAuto => "SimulationOnly",
        sthyra_domain::RuntimeMode::Paper => "PaperMode",
        sthyra_domain::RuntimeMode::Protected => "ProtectedMode",
        sthyra_domain::RuntimeMode::Halted => "Halted",
        sthyra_domain::RuntimeMode::Backtest => "BacktestMode",
        sthyra_domain::RuntimeMode::Replay => "ReplayMode",
        sthyra_domain::RuntimeMode::Research => "ResearchOnly",
    }
}

fn log_no_candidate(surface_label: &str, regime: sthyra_domain::MarketRegime, confidence: f32) {
    let msg = format!(
        "[NO-CANDIDATE] {} | regime={:?} | confidence={:.3} | no strategy eligible this cycle",
        surface_label, regime, confidence,
    );
    println!("{msg}");
    append_operator_event("no-candidate", "info", &msg, None);
}

fn opportunity_action_for_mode(mode: sthyra_domain::RuntimeMode, decision: TradeDecision) -> String {
    match mode {
        sthyra_domain::RuntimeMode::Paper if matches!(decision, TradeDecision::Approve) => "Paper".to_string(),
        sthyra_domain::RuntimeMode::Protected if matches!(decision, TradeDecision::Approve) => "Guarded".to_string(),
        sthyra_domain::RuntimeMode::Halted => "Blocked".to_string(),
        sthyra_domain::RuntimeMode::Research | sthyra_domain::RuntimeMode::Backtest | sthyra_domain::RuntimeMode::Replay
            if matches!(decision, TradeDecision::Approve) =>
        {
            "Review".to_string()
        }
        _ => decision_label(decision).to_string(),
    }
}

fn decision_label(decision: TradeDecision) -> &'static str {
    match decision {
        TradeDecision::Approve => "Approve",
        TradeDecision::Reject => "Reject",
        TradeDecision::Watch => "Watch",
        TradeDecision::PaperTest => "PaperTest",
    }
}

fn build_market_intelligence(
    symbol: &Symbol,
    book: &OrderBookSnapshot,
    market_health: &sthyra_market_data::MarketHealthAssessment,
    live_client: Option<&BinanceHttpClient>,
    research_report: Option<&ResearchCycleReport>,
) -> MarketIntelligence {
    // 1m candles (primary signal source)
    let candles = live_client
        .and_then(|client| client.fetch_recent_klines(&symbol.0, 96).ok())
        .map(|klines| klines.into_iter().map(|kline| kline.to_candle()).collect::<Vec<_>>())
        .filter(|candles| !candles.is_empty())
        .unwrap_or_else(|| synthetic_recent_candles(book));

    // 4h candles for real higher-timeframe alignment
    let candles_4h = live_client
        .and_then(|client| client.fetch_klines_interval(&symbol.0, "4h", 50).ok())
        .map(|klines| klines.into_iter().map(|k| k.to_candle()).collect::<Vec<_>>())
        .unwrap_or_default();

    // 1d candles for macro trend context
    let candles_1d = live_client
        .and_then(|client| client.fetch_klines_interval(&symbol.0, "1d", 14).ok())
        .map(|klines| klines.into_iter().map(|k| k.to_candle()).collect::<Vec<_>>())
        .unwrap_or_default();

    // Funding rate
    let funding = live_client
        .and_then(|client| client.fetch_funding_rate(&symbol.0).ok())
        .unwrap_or(FundingRateSnapshot { symbol: symbol.0.clone(), rate: 0.0, next_funding_ms: 0 });

    // Open interest (current — compare to prior cycle via candle proxy)
    let open_interest = live_client
        .and_then(|client| client.fetch_open_interest(&symbol.0).ok())
        .unwrap_or(OpenInterestSnapshot { symbol: symbol.0.clone(), open_interest: 0.0 });

    // L2 order book depth (top 10 levels)
    let depth = live_client
        .and_then(|client| client.fetch_order_book_depth(&symbol.0, 10).ok())
        .unwrap_or(OrderBookDepth { symbol: symbol.0.clone(), bids: vec![], asks: vec![] });

    // BTC benchmark correlation (if not already BTC)
    let btc_prices: Vec<f64> = if symbol.0 == "BTCUSDT" {
        candles.iter().map(|c| c.close).collect()
    } else {
        live_client
            .and_then(|client| client.fetch_recent_klines("BTCUSDT", 32).ok())
            .map(|klines| klines.into_iter().map(|k| k.to_candle().close).collect())
            .unwrap_or_default()
    };
    let symbol_prices: Vec<f64> = candles.iter().map(|c| c.close).collect();
    let btc_correlation = if btc_prices.len() >= 31 && symbol_prices.len() >= 31 {
        compute_return_correlation(&symbol_prices, &btc_prices)
    } else {
        0.5
    };

    // HTF trend bias from 4h candles
    let htf_trend_bias = compute_htf_trend_bias(&candles_4h);

    // 1d macro bias (secondary confirmation)
    let daily_trend_bias = compute_htf_trend_bias(&candles_1d);

    // OI delta: use volume as proxy when OI history not tracked
    // (supervisor will track prior OI in a future pass; for now use volume delta)
    let oi_delta = if !candles.is_empty() {
        let vol_recent: f64 = candles.iter().rev().take(5).map(|c| c.volume).sum::<f64>() / 5.0;
        let vol_prior: f64 = candles.iter().rev().skip(5).take(10).map(|c| c.volume).sum::<f64>() / 10.0;
        compute_oi_delta(open_interest.open_interest.max(vol_recent), open_interest.open_interest.max(vol_prior))
    } else {
        0.0
    };

    // L2 depth imbalance within 0.3% of mid
    let depth_imbalance = depth.depth_imbalance(0.003);

    // Portfolio correlation penalty: higher when BTC correlation is extreme and trending same direction
    let portfolio_correlation_penalty = if btc_correlation.abs() > 0.85 {
        0.25 // very high correlation = less diversification benefit
    } else if btc_correlation.abs() > 0.65 {
        0.15
    } else {
        0.08
    };

    let extras = MarketExtras {
        funding_rate: funding.rate,
        open_interest_delta: oi_delta,
        depth_imbalance,
        htf_trend_bias: (htf_trend_bias * 0.7 + daily_trend_bias * 0.3).clamp(-1.0, 1.0),
        btc_correlation,
        portfolio_correlation_penalty,
    };

    let indicators = compute_indicator_snapshot(&candles);
    let structure = assess_market_structure(&candles, book);
    let regime = infer_regime(&indicators, &structure, market_health);
    let features = derive_feature_vector(symbol.clone(), book, &indicators, &structure);
    let headlines = collect_headlines(NEWS_HEADLINES_PATH);
    let news = score_headlines(&headlines);
    let confluence_inputs = build_confluence_inputs(&indicators, &structure, &news, market_health, extras);
    let indicator_inputs = build_indicator_gene_inputs(&indicators);

    MarketIntelligence {
        regime,
        features,
        confluence_inputs,
        indicator_inputs,
        candles,
        news,
        research_report: research_report.cloned(),
    }
}

fn build_confluence_inputs(
    indicators: &IndicatorSnapshot,
    structure: &MarketStructureSnapshot,
    news: &NewsSentimentSnapshot,
    market_health: &sthyra_market_data::MarketHealthAssessment,
    extras: sthyra_market_data::MarketExtras,
) -> ConfluenceInputs {
    let system_health_modifier = if market_health.manipulation_suspected {
        0.2
    } else if matches!(market_health.feed_health, sthyra_market_data::FeedHealth::Healthy) {
        0.85
    } else {
        0.45
    };

    // Real HTF alignment replaces the fake EMA-on-1m calculation
    let higher_timeframe_alignment = if extras.htf_trend_bias.abs() > 0.05 {
        extras.real_htf_alignment()
    } else {
        // Fallback when HTF data unavailable
        ((indicators.ema_fast > indicators.ema_slow) as u8 as f64 * 0.5
            + structure.trend_bias.abs() * 0.5)
            .clamp(0.0, 1.0)
    };

    ConfluenceInputs {
        higher_timeframe_alignment,
        recent_strategy_performance: (0.45 + indicators.signal_consensus * 0.35).clamp(0.0, 1.0),
        correlation_penalty: extras.portfolio_correlation_penalty,
        system_health_modifier,
        indicator_consensus: indicators.signal_consensus,
        market_structure_score: structure.structure_score,
        volatility_fit: match structure.volatility_regime {
            sthyra_market_data::VolatilityRegime::Compressed => 0.65,
            sthyra_market_data::VolatilityRegime::Normal => 0.85,
            sthyra_market_data::VolatilityRegime::Expanding => 0.7,
            sthyra_market_data::VolatilityRegime::Chaotic => 0.2,
        },
        order_flow_score: ((structure.breakout_pressure * 0.6) + (structure.trend_bias.abs() * 0.4)).clamp(0.0, 1.0),
        confirmation_score: ((indicators.volume_confirmation.max(0.0) * 0.4)
            + (structure.support_resistance_clarity * 0.3)
            + ((1.0 - market_health.spread_penalty) * 0.3))
            .clamp(0.0, 1.0),
        news: news.clone(),
        extras,
    }
}

fn build_indicator_gene_inputs(indicators: &IndicatorSnapshot) -> IndicatorGeneInputs {
    let ema_trend_bias = if indicators.ema_slow.abs() <= f64::EPSILON {
        0.0
    } else {
        ((indicators.ema_fast - indicators.ema_slow) / indicators.ema_slow).clamp(-1.0, 1.0)
    };

    IndicatorGeneInputs {
        rsi_bias: ((indicators.rsi - 50.0) / 50.0).clamp(-1.0, 1.0),
        macd_bias: indicators.macd_histogram.clamp(-1.0, 1.0),
        breakout_bias: (indicators.breakout_score * 2.0 - 1.0).clamp(-1.0, 1.0),
        mean_reversion_bias: (indicators.mean_reversion_score * 2.0 - 1.0).clamp(-1.0, 1.0),
        momentum_bias: indicators.momentum_score.clamp(-1.0, 1.0),
        volume_bias: indicators.volume_confirmation.clamp(-1.0, 1.0),
        volatility_efficiency: (1.0 - indicators.atr_ratio - indicators.realized_volatility).clamp(-1.0, 1.0),
        vwap_reversion_bias: (-indicators.vwap_distance).clamp(-1.0, 1.0),
        stochastic_bias: ((indicators.stochastic_k - 50.0) / 50.0).clamp(-1.0, 1.0),
        cci_bias: (indicators.cci / 200.0).clamp(-1.0, 1.0),
        money_flow_bias: ((indicators.money_flow_index - 50.0) / 50.0).clamp(-1.0, 1.0),
        ema_trend_bias,
    }
}

fn synthetic_recent_candles(book: &OrderBookSnapshot) -> Vec<Candle> {
    let mid = (book.best_bid + book.best_ask) / 2.0;
    let spread = (book.best_ask - book.best_bid).max(0.01);

    (0..96)
        .map(|index| {
            let drift = (index as f64 / 96.0) * spread * 4.0;
            let close = mid - spread * 2.0 + drift;
            Candle {
                open: close - spread * 0.4,
                high: close + spread * 0.8,
                low: close - spread * 0.8,
                close,
                volume: 100_000.0 + index as f64 * 500.0,
                close_time_ms: current_timestamp_ms().saturating_sub((96 - index) as u64 * 60_000),
            }
        })
        .collect()
}

fn build_or_load_research_report(
    symbols: &[String],
    stale_after_ms: u64,
    live_client: Option<&BinanceHttpClient>,
    refresh_interval_ms: u64,
    indicator_prune_min_fitness: f64,
    indicator_retention_limit: usize,
) -> std::io::Result<ResearchCycleReport> {
    let day_key = Utc::now().format("%Y-%m-%d").to_string();
    let indicator_blacklist = load_indicator_blacklist(INDICATOR_BLACKLIST_PATH);
    let prior_report = load_research_cycle_report(RESEARCH_REPORT_PATH)
        .ok()
        .map(|report| prune_indicator_research_report(report, indicator_prune_min_fitness, indicator_retention_limit, &indicator_blacklist).0);
    if let Some(report) = prior_report.as_ref() {
        if report.day_key == day_key
            && report_has_indicator_research(report)
            && research_report_is_fresh(RESEARCH_REPORT_PATH, refresh_interval_ms)
        {
            return Ok(report.clone());
        }
    }

    let frames = build_research_frames(symbols, stale_after_ms, live_client);
    let report = run_daily_research_cycle(&day_key, &frames, prior_report.as_ref());
    let (report, _) = prune_indicator_research_report(report, indicator_prune_min_fitness, indicator_retention_limit, &indicator_blacklist);
    save_research_cycle_report(RESEARCH_REPORT_PATH, &report)?;
    Ok(report)
}

fn load_indicator_blacklist(path: &str) -> HashSet<String> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .map(|values| values.into_iter().collect())
        .unwrap_or_default()
}

fn research_report_is_fresh(path: &str, refresh_interval_ms: u64) -> bool {
    fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.elapsed().ok())
        .map(|elapsed| elapsed.as_millis() <= refresh_interval_ms as u128)
        .unwrap_or(false)
}

fn prune_indicator_research_report(
    mut report: ResearchCycleReport,
    min_fitness: f64,
    retention_limit: usize,
    blacklist: &HashSet<String>,
) -> (ResearchCycleReport, bool) {
    let previous_len = report.indicator_leaderboard.len();
    let previous_promoted_id = report
        .promoted_indicator
        .as_ref()
        .map(|entry| entry.genome.id.clone());

    report
        .indicator_leaderboard
        .retain(|entry| entry.fitness_score >= min_fitness && !blacklist.contains(&entry.genome.id));
    if report.indicator_leaderboard.len() > retention_limit {
        report.indicator_leaderboard.truncate(retention_limit);
    }

    let promoted_allowed = report.promoted_indicator.as_ref().is_some_and(|entry| {
        entry.fitness_score >= min_fitness
            && !blacklist.contains(&entry.genome.id)
            && report
                .indicator_leaderboard
                .iter()
                .any(|leaderboard_entry| leaderboard_entry.genome.id == entry.genome.id)
    });

    if !promoted_allowed {
        report.promoted_indicator = report.indicator_leaderboard.first().cloned();
    }

    let current_promoted_id = report
        .promoted_indicator
        .as_ref()
        .map(|entry| entry.genome.id.clone());
    let changed = previous_len != report.indicator_leaderboard.len() || previous_promoted_id != current_promoted_id;

    (report, changed)
}

fn report_has_indicator_research(report: &ResearchCycleReport) -> bool {
    report.promoted_indicator.is_some() || !report.indicator_leaderboard.is_empty()
}

fn build_research_frames(
    symbols: &[String],
    stale_after_ms: u64,
    live_client: Option<&BinanceHttpClient>,
) -> Vec<ReplayFrame> {
    let mut contexts = collect_symbol_market_contexts(symbols, stale_after_ms, live_client);
    if let Ok(dataset_dir) = env::var(RESEARCH_DATASET_DIR_ENV) {
        contexts.extend(load_historical_symbol_contexts(symbols, Path::new(&dataset_dir), stale_after_ms));
    }
    let headlines = collect_headlines(NEWS_HEADLINES_PATH);
    let news = score_headlines(&headlines);
    let mut frames = Vec::new();

    for context in &contexts {
        for end_index in (30..=context.candles.len()).step_by(6) {
            let window = &context.candles[..end_index];
            let indicators = compute_indicator_snapshot(window);
            let structure = assess_market_structure(window, &context.book);
            let regime = infer_regime(&indicators, &structure, &context.market_health);
            let features = derive_feature_vector(context.symbol.clone(), &context.book, &indicators, &structure);
            let confluence_inputs = build_confluence_inputs(&indicators, &structure, &news, &context.market_health);
            frames.push(ReplayFrame {
                regime,
                features,
                market_health: context.market_health.clone(),
                indicator_inputs: build_indicator_gene_inputs(&indicators),
                confluence_inputs,
            });
        }
    }

    if frames.is_empty() {
        for context in &contexts {
            let indicators = compute_indicator_snapshot(&context.candles);
            let structure = assess_market_structure(&context.candles, &context.book);
            let regime = infer_regime(&indicators, &structure, &context.market_health);
            let features = derive_feature_vector(context.symbol.clone(), &context.book, &indicators, &structure);
            frames.push(ReplayFrame {
                regime,
                features,
                market_health: context.market_health.clone(),
                indicator_inputs: build_indicator_gene_inputs(&indicators),
                confluence_inputs: build_confluence_inputs(&indicators, &structure, &news, &context.market_health),
            });
        }
    }

    frames
}

fn build_indicator_points(symbol: &str, candles: &[Candle]) -> Vec<SnapshotIndicatorPoint> {
    let start = candles.len().saturating_sub(48);
    candles[start..]
        .iter()
        .enumerate()
        .map(|(index, candle)| {
            let indicators = compute_indicator_snapshot(&candles[..start + index + 1]);
            SnapshotIndicatorPoint {
                symbol: symbol.to_string(),
                timestamp_ms: candle.close_time_ms,
                price: candle.close,
                ema_fast: indicators.ema_fast,
                ema_slow: indicators.ema_slow,
                rsi: indicators.rsi,
                macd_histogram: indicators.macd_histogram,
                signal_consensus: indicators.signal_consensus,
            }
        })
        .collect()
}

fn build_candle_points(symbol: &str, candles: &[Candle]) -> Vec<SnapshotCandlePoint> {
    let start = candles.len().saturating_sub(48);
    candles[start..]
        .iter()
        .map(|candle| SnapshotCandlePoint {
            symbol: symbol.to_string(),
            timestamp_ms: candle.close_time_ms,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
        })
        .collect()
}

fn build_snapshot_research_models(report: Option<&ResearchCycleReport>) -> Vec<SnapshotResearchModel> {
    report
        .map(|report| {
            let mut models = report
                .leaderboard
                .iter()
                .take(3)
                .map(|entry| SnapshotResearchModel {
                    id: entry.model.id.clone(),
                    engine: "signal-model".to_string(),
                    symbol: entry.model.target_symbol.clone().unwrap_or_else(|| "All".to_string()),
                    regime: entry.model.target_regime.clone().unwrap_or_else(|| "All".to_string()),
                    family: entry.model.target_family.clone().unwrap_or_else(|| "All".to_string()),
                    score: entry.fitness_score,
                    profitability: entry.profitability_score,
                    robustness: entry.robustness_score,
                    risk_adjusted_return: entry.risk_adjusted_return,
                    latency_score: 1.0,
                    threshold: entry.model.approval_threshold,
                })
                .collect::<Vec<_>>();

            models.extend(report.indicator_leaderboard.iter().take(3).map(|entry| SnapshotResearchModel {
                id: entry.genome.id.clone(),
                engine: "indicator-genome".to_string(),
                symbol: entry.genome.target_symbol.clone().unwrap_or_else(|| "All".to_string()),
                regime: entry.genome.target_regime.clone().unwrap_or_else(|| "All".to_string()),
                family: entry.genome.target_family.clone().unwrap_or_else(|| "GeneticIndicator".to_string()),
                score: entry.fitness_score,
                profitability: entry.profitability_score,
                robustness: entry.robustness_score,
                risk_adjusted_return: entry.latency_score,
                latency_score: entry.latency_score,
                threshold: entry.genome.approval_threshold,
            }));

            models.sort_by(|left, right| right.score.total_cmp(&left.score));
            models.into_iter().take(6).collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn build_snapshot_promoted_indicator(report: Option<&ResearchCycleReport>) -> SnapshotPromotedIndicator {
    SnapshotPromotedIndicator {
        id: report.and_then(|entry| {
            entry
                .promoted_indicator
                .as_ref()
                .map(|promoted| promoted.genome.id.clone())
        }),
        overlay_enabled: !promoted_indicators_disabled(),
        leaderboard_count: report
            .map(|entry| entry.indicator_leaderboard.len())
            .unwrap_or(0),
    }
}

fn build_snapshot_news_sentiment(news: &NewsSentimentSnapshot) -> SnapshotNewsSentiment {
    SnapshotNewsSentiment {
        sentiment_score: news.sentiment_score,
        confidence: news.confidence,
        catalyst_score: news.catalyst_score,
        risk_off: news.risk_off,
        themes: news.themes.clone(),
    }
}

fn collect_symbol_market_contexts(
    symbols: &[String],
    stale_after_ms: u64,
    live_client: Option<&BinanceHttpClient>,
) -> Vec<SymbolMarketContext> {
    let mut contexts = Vec::new();

    for raw_symbol in symbols {
        let Ok(symbol) = Symbol::new(raw_symbol.clone()) else {
            continue;
        };
        let book = fetch_or_simulate_book(&symbol, live_client);
        let market_health = assess_market_health(&book, current_timestamp_ms(), stale_after_ms);
        let candles = live_client
            .and_then(|client| client.fetch_recent_klines(&symbol.0, 96).ok())
            .map(|klines| klines.into_iter().map(|kline| kline.to_candle()).collect::<Vec<_>>())
            .filter(|candles| !candles.is_empty())
            .unwrap_or_else(|| synthetic_recent_candles(&book));

        contexts.push(SymbolMarketContext {
            symbol,
            book,
            market_health,
            candles,
        });
    }

    contexts
}

fn load_historical_symbol_contexts(
    symbols: &[String],
    dataset_dir: &Path,
    stale_after_ms: u64,
) -> Vec<SymbolMarketContext> {
    symbols
        .iter()
        .filter_map(|raw_symbol| {
            let symbol = Symbol::new(raw_symbol.clone()).ok()?;
            let csv_path = dataset_dir.join(format!("{}.csv", symbol.0));
            let candles = load_candles_from_csv(&csv_path)?;
            if candles.len() < 30 {
                return None;
            }

            let book = historical_book_from_candles(&symbol, &candles);
            let market_health = assess_market_health(&book, current_timestamp_ms(), stale_after_ms);

            Some(SymbolMarketContext {
                symbol,
                book,
                market_health,
                candles,
            })
        })
        .collect()
}

fn load_candles_from_csv(path: &Path) -> Option<Vec<Candle>> {
    let raw = fs::read_to_string(path).ok()?;
    let candles = raw
        .lines()
        .filter_map(parse_candle_csv_line)
        .collect::<Vec<_>>();

    if candles.is_empty() {
        None
    } else {
        Some(candles)
    }
}

fn parse_candle_csv_line(line: &str) -> Option<Candle> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let columns = trimmed.split(',').map(str::trim).collect::<Vec<_>>();
    if columns.len() < 6 {
        return None;
    }

    if columns[1].parse::<f64>().is_err() {
        return None;
    }

    let close_time_ms = if columns.len() >= 7 {
        columns[6].parse::<u64>().ok().or_else(|| columns[0].parse::<u64>().ok())?
    } else {
        columns[0].parse::<u64>().ok()?
    };

    Some(Candle {
        open: columns[1].parse().ok()?,
        high: columns[2].parse().ok()?,
        low: columns[3].parse().ok()?,
        close: columns[4].parse().ok()?,
        volume: columns[5].parse().ok()?,
        close_time_ms,
    })
}

fn historical_book_from_candles(symbol: &Symbol, candles: &[Candle]) -> OrderBookSnapshot {
    let last_close = candles.last().map(|candle| candle.close).unwrap_or_else(|| simulated_base_price(symbol));
    let spread = (last_close * 0.0002).max(0.01);

    OrderBookSnapshot {
        symbol: symbol.clone(),
        best_bid: last_close - spread,
        best_ask: last_close + spread,
        bid_depth: 250_000.0,
        ask_depth: 225_000.0,
        last_update_ms: candles.last().map(|candle| candle.close_time_ms).unwrap_or_else(current_timestamp_ms),
    }
}

fn fetch_or_simulate_book(symbol: &Symbol, live_client: Option<&BinanceHttpClient>) -> OrderBookSnapshot {
    if let Some(client) = live_client {
        if let Ok(remote) = client.fetch_book_ticker(&symbol.0) {
            if let Ok(book) = remote.to_order_book_snapshot() {
                return book;
            }
        }
    }

    let base_price = simulated_base_price(symbol);
    OrderBookSnapshot {
        symbol: symbol.clone(),
        best_bid: base_price,
        best_ask: base_price + 2.0,
        bid_depth: 200_000.0,
        ask_depth: 180_000.0,
        last_update_ms: current_timestamp_ms(),
    }
}

fn simulated_base_price(symbol: &Symbol) -> f64 {
    match symbol.0.as_str() {
        "BTCUSDT" => 100_000.0,
        "ETHUSDT" => 4_000.0,
        "SOLUSDT" => 140.0,
        _ => 1_000.0,
    }
}

fn candidate_confluence_inputs(
    candidate: &sthyra_strategy_engine::StrategyCandidate,
    base_inputs: &ConfluenceInputs,
    indicator_inputs: &IndicatorGeneInputs,
    report: Option<&ResearchCycleReport>,
) -> ConfluenceInputs {
    let selected_model = report.and_then(|report| {
        select_promoted_model(report, &candidate.symbol.0, candidate.regime, candidate.family)
    });
    let selected_indicator = report.and_then(|report| {
        select_promoted_indicator(report, &candidate.symbol.0, candidate.regime, candidate.family)
    });

    let model_adjusted = apply_promoted_model(base_inputs, selected_model);
    if promoted_indicators_disabled() {
        return model_adjusted;
    }

    apply_promoted_indicator_genome(&model_adjusted, indicator_inputs, selected_indicator)
}

#[allow(clippy::too_many_arguments)]
fn execute_candidate(
    candidate: &sthyra_strategy_engine::StrategyCandidate,
    regime: RegimeAssessment,
    features: &RegimeFeatureVector,
    market_health: &sthyra_market_data::MarketHealthAssessment,
    confluence_inputs: &ConfluenceInputs,
    indicator_inputs: &IndicatorGeneInputs,
    research_report: Option<&ResearchCycleReport>,
    execution_mode: sthyra_domain::RuntimeMode,
    trading_enabled: bool,
    cancel_after_submit: bool,
    live_client: Option<&BinanceHttpClient>,
    exchange_rules: Option<&[ExchangeSymbolRules]>,
    audit_store: &AuditStore,
    audit_trail: &mut AuditTrail,
    watchdog_status: HealthStatus,
    recovery_actions: &[RecoveryAction],
    reconciliation_issue_count: usize,
    active_positions: u8,
    current_leverage: u8,
    risk_gate: &RiskGate,
) -> String {
    let selected_inputs = candidate_confluence_inputs(
        candidate,
        confluence_inputs,
        indicator_inputs,
        research_report,
    );
    let confluence = score_candidate(candidate, regime, market_health, &selected_inputs);
    let selected_model = research_report
        .and_then(|report| select_promoted_model(report, &candidate.symbol.0, candidate.regime, candidate.family));
    let selected_indicator = if promoted_indicators_disabled() {
        None
    } else {
        research_report
            .and_then(|report| select_promoted_indicator(report, &candidate.symbol.0, candidate.regime, candidate.family))
    };
    let resolved_exchange_rules = exchange_rules
        .map(|rules| rules.to_vec())
        .unwrap_or_else(|| {
            vec![ExchangeSymbolRules {
                symbol: candidate.symbol.0.clone(),
                tick_size: 0.1,
                step_size: 0.001,
                min_qty: 0.001,
                min_notional: 5.0,
                max_leverage: 20,
            }]
        });
    let validation_input = ExchangeValidationInput {
        order: OrderIntent {
            symbol: candidate.symbol.clone(),
            mode: execution_mode,
            decision: confluence.decision,
            size_usd: 100.0 * confluence.recommended_size_multiplier,
        },
        quantity: 0.001,
        price: 100000.0,
        leverage: 5,
    };
    let exchange_validation = validate_order_against_rules(&resolved_exchange_rules, &validation_input);
    let risk_outcome = risk_gate.evaluate(
        &OrderIntent {
            symbol: candidate.symbol.clone(),
            mode: execution_mode,
            decision: confluence.decision,
            size_usd: 100.0 * confluence.recommended_size_multiplier,
        },
        RiskSnapshot {
            regime: regime.regime,
            daily_drawdown_bps: 50,
            weekly_drawdown_bps: 100,
            monthly_drawdown_bps: 150,
            active_positions,
            current_leverage,
            health_degraded: matches!(execution_mode, sthyra_domain::RuntimeMode::Protected | sthyra_domain::RuntimeMode::Halted),
            model_confidence: confluence.confidence_score,
            expected_value_score: confluence.expected_value_score,
            news_risk_off: confluence_inputs.news.risk_off,
        },
    );
    let execution_posture = format!(
        "{} / mode={:?} / decision={} / risk={:?}",
        execution_surface_label(execution_mode, trading_enabled),
        execution_mode,
        decision_label(confluence.decision),
        risk_outcome
    );

    let mut execution_ticket = ExecutionTicket::new(OrderIntent {
        symbol: candidate.symbol.clone(),
        mode: execution_mode,
        decision: confluence.decision,
        size_usd: 100.0 * confluence.recommended_size_multiplier,
    });
    audit_trail.record_order_intent(order_intent_record(&execution_ticket.intent, selected_model, selected_indicator));
    audit_trail.record_execution_event(execution_event_record(
        &execution_ticket,
        "intent-created",
        "execution intent created",
        selected_model,
        selected_indicator,
    ));

    if matches!(risk_outcome, sthyra_risk_engine::RiskOutcome::Approved) {
        let _ = execution_ticket.transition(ExecutionEvent::Submit);
        audit_trail.record_execution_event(execution_event_record(
            &execution_ticket,
            "submit-requested",
            "risk gate approved submit path",
            selected_model,
            selected_indicator,
        ));

        if trading_enabled && execution_mode.allows_live_orders() {
            if let Some(client) = live_client {
                let side = if features.order_book_pressure >= 0.0 {
                    OrderSide::Buy
                } else {
                    OrderSide::Sell
                };
                let client_order_id = format!(
                    "sthyra-{}-{}",
                    candidate.symbol.0.to_lowercase(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs()
                );
                let live_order = NewOrderRequest {
                    symbol: candidate.symbol.0.clone(),
                    side,
                    order_type: OrderType::Limit,
                    quantity: validation_input.quantity,
                    price: Some(validation_input.price),
                    reduce_only: false,
                    client_order_id: client_order_id.clone(),
                };

                match client.submit_order(&live_order) {
                    Ok(submitted) => {
                        execution_ticket.exchange_order_id = Some(submitted.order_id.clone());
                        let _ = execution_ticket.transition(ExecutionEvent::Accept);
                        let mut live_order_status = format!("submitted:{}", submitted.status);
                        audit_trail.record_execution_event(execution_event_record(
                            &execution_ticket,
                            "submitted",
                            &live_order_status,
                            selected_model,
                            selected_indicator,
                        ));

                        if cancel_after_submit {
                            match client.cancel_order(&CancelOrderRequest {
                                symbol: submitted.symbol.clone(),
                                orig_client_order_id: Some(submitted.client_order_id.clone()),
                                order_id: Some(submitted.order_id.clone()),
                            }) {
                                Ok(canceled) => {
                                    let _ = execution_ticket.transition(ExecutionEvent::Cancel);
                                    let _ = execution_ticket.transition(ExecutionEvent::Reconcile);
                                    live_order_status = format!(
                                        "submitted:{} canceled:{}",
                                        submitted.status, canceled.status
                                    );
                                    audit_trail.record_execution_event(execution_event_record(
                                        &execution_ticket,
                                        "canceled",
                                        &live_order_status,
                                        selected_model,
                                        selected_indicator,
                                    ));
                                }
                                Err(error) => {
                                    let _ = execution_ticket.transition(ExecutionEvent::Desync);
                                    live_order_status = format!("submit-ok cancel-failed:{error}");
                                    audit_trail.record_execution_event(execution_event_record(
                                        &execution_ticket,
                                        "desync",
                                        &live_order_status,
                                        selected_model,
                                        selected_indicator,
                                    ));
                                }
                            }
                        } else {
                            let _ = execution_ticket.transition(ExecutionEvent::Fill);
                            let _ = execution_ticket.transition(ExecutionEvent::Reconcile);
                            persist_active_position_model_attribution(
                                audit_store,
                                &execution_ticket.intent.symbol.0,
                                selected_model,
                                selected_indicator,
                            );
                            audit_trail.record_execution_event(execution_event_record(
                                &execution_ticket,
                                "filled",
                                "submitted order filled and reconciled",
                                selected_model,
                                selected_indicator,
                            ));
                        }
                    }
                    Err(error) => {
                        let _ = execution_ticket.transition(ExecutionEvent::Reject);
                        let live_order_status = format!("submit-failed:{error}");
                        audit_trail.record_execution_event(execution_event_record(
                            &execution_ticket,
                            "submit-rejected",
                            &live_order_status,
                            selected_model,
                            selected_indicator,
                        ));
                    }
                }
            } else {
                let _ = execution_ticket.transition(ExecutionEvent::Reject);
                let live_order_status = "submit-skipped:no-client".to_string();
                audit_trail.record_execution_event(execution_event_record(
                    &execution_ticket,
                    "submit-skipped",
                    &live_order_status,
                    selected_model,
                    selected_indicator,
                ));
            }
        } else {
            let _ = execution_ticket.transition(ExecutionEvent::Accept);
            let _ = execution_ticket.transition(ExecutionEvent::Fill);
            let _ = execution_ticket.transition(ExecutionEvent::Reconcile);
            if trading_enabled {
                let live_order_status = "submit-skipped:mode-or-transport-gate".to_string();
                audit_trail.record_execution_event(execution_event_record(
                    &execution_ticket,
                    "submit-skipped",
                    &live_order_status,
                    selected_model,
                    selected_indicator,
                ));
            } else {
                persist_active_position_model_attribution(
                    audit_store,
                    &execution_ticket.intent.symbol.0,
                    selected_model,
                    selected_indicator,
                );
                let live_order_status = "simulated-fill".to_string();
                audit_trail.record_execution_event(execution_event_record(
                    &execution_ticket,
                    "simulated-fill",
                    &live_order_status,
                    selected_model,
                    selected_indicator,
                ));
                let paper_msg = format!(
                    "[PAPER] {} {} | size_usd={:.2} | decision={} | confidence={:.3} | ev={:.3}",
                    execution_mode,
                    execution_ticket.intent.symbol.0,
                    execution_ticket.intent.size_usd,
                    decision_label(execution_ticket.intent.decision),
                    confluence.confidence_score,
                    confluence.expected_value_score,
                );
                println!("{paper_msg}");
                append_operator_event("paper-fill", "info", &paper_msg, None);
            }
        }
    } else {
        let live_order_status = format!("blocked:{:?}", risk_outcome);
        audit_trail.record_execution_event(execution_event_record(
            &execution_ticket,
            "risk-rejected",
            &live_order_status,
            selected_model,
            selected_indicator,
        ));
        let reject_msg = format!(
            "[BLOCKED] {} {} | decision={} | confidence={:.3} | reason={:?}",
            execution_mode,
            execution_ticket.intent.symbol.0,
            decision_label(confluence.decision),
            confluence.confidence_score,
            risk_outcome,
        );
        println!("{reject_msg}");
        append_operator_event("risk-blocked", "warn", &reject_msg, None);
    }

    record_operational_incidents(
        audit_trail,
        execution_mode,
        watchdog_status,
        recovery_actions,
        reconciliation_issue_count,
        exchange_validation.as_ref().err(),
    );

    execution_posture
}

fn promoted_indicators_disabled() -> bool {
    env::var(DISABLE_PROMOTED_INDICATORS_ENV)
        .map(|value| value == "1")
        .unwrap_or(false)
}

fn record_research_promotion_changes(
    audit_trail: &mut AuditTrail,
    mode: sthyra_domain::RuntimeMode,
    previous_report: Option<&ResearchCycleReport>,
    current_report: Option<&ResearchCycleReport>,
) {
    let Some(current_report) = current_report else {
        return;
    };

    let previous_signal = previous_report
        .and_then(|report| report.promoted_model.as_ref())
        .map(|entry| entry.model.id.as_str());
    let current_signal = current_report
        .promoted_model
        .as_ref()
        .map(|entry| entry.model.id.as_str());

    if current_signal != previous_signal {
        let message = format!(
            "research signal promotion: {} -> {}",
            previous_signal.unwrap_or("none"),
            current_signal.unwrap_or("none")
        );
        audit_trail.record_incident(IncidentRecord {
            mode,
            message: message.clone(),
        });
        append_operator_event("research-signal-promotion", "info", &message, Some(&current_report.day_key));
    }

    let previous_indicator = previous_report
        .and_then(|report| report.promoted_indicator.as_ref())
        .map(|entry| entry.genome.id.as_str());
    let current_indicator = current_report
        .promoted_indicator
        .as_ref()
        .map(|entry| entry.genome.id.as_str());

    if current_indicator != previous_indicator {
        let message = format!(
            "genetic indicator promotion: {} -> {}",
            previous_indicator.unwrap_or("none"),
            current_indicator.unwrap_or("none")
        );
        audit_trail.record_incident(IncidentRecord {
            mode,
            message: message.clone(),
        });
        append_operator_event("genetic-indicator-promotion", "info", &message, Some(&current_report.day_key));
    }
}

fn record_operational_incidents(
    audit_trail: &mut AuditTrail,
    mode: sthyra_domain::RuntimeMode,
    watchdog_status: HealthStatus,
    recovery_actions: &[RecoveryAction],
    reconciliation_issue_count: usize,
    exchange_validation_error: Option<&ExchangeValidationError>,
) {
    if !matches!(watchdog_status, HealthStatus::Healthy) {
        audit_trail.record_incident(IncidentRecord {
            mode,
            message: format!(
                "watchdog drift detected: status {:?} recovery {:?}",
                watchdog_status, recovery_actions
            ),
        });
    }

    if reconciliation_issue_count > 0 {
        audit_trail.record_incident(IncidentRecord {
            mode,
            message: format!(
                "reconciliation drift detected: {reconciliation_issue_count} issue(s) pending"
            ),
        });
    }

    if let Some(error) = exchange_validation_error {
        audit_trail.record_incident(IncidentRecord {
            mode,
            message: format!("exchange validation failed: {:?}", error),
        });
    }
}

fn execution_event_record(
    execution_ticket: &ExecutionTicket,
    event_type: &str,
    detail: &str,
    model: Option<&EvaluatedSignalModel>,
    indicator: Option<&EvaluatedIndicatorGenome>,
) -> ExecutionEventRecord {
    ExecutionEventRecord {
        symbol: execution_ticket.intent.symbol.0.clone(),
        mode: execution_ticket.intent.mode,
        decision: decision_label(execution_ticket.intent.decision).to_string(),
        event_type: event_type.to_string(),
        state: format!("{:?}", execution_ticket.state),
        detail: detail.to_string(),
        model_id: model
            .map(|entry| entry.model.id.clone())
            .unwrap_or_else(|| "base-runtime".to_string()),
        model_scope: model
            .map(model_scope_label)
            .unwrap_or_else(|| "All / All / All".to_string()),
        indicator_id: indicator
            .map(|entry| entry.genome.id.clone())
            .unwrap_or_else(|| "none".to_string()),
        indicator_scope: indicator
            .map(indicator_scope_label)
            .unwrap_or_else(|| "All / All / All".to_string()),
    }
}

fn order_intent_record(
    intent: &OrderIntent,
    model: Option<&EvaluatedSignalModel>,
    indicator: Option<&EvaluatedIndicatorGenome>,
) -> OrderIntentRecord {
    OrderIntentRecord {
        symbol: intent.symbol.0.clone(),
        mode: intent.mode,
        decision: decision_label(intent.decision).to_string(),
        size_usd: intent.size_usd,
        model_id: model
            .map(|entry| entry.model.id.clone())
            .unwrap_or_else(|| "base-runtime".to_string()),
        model_scope: model
            .map(model_scope_label)
            .unwrap_or_else(|| "All / All / All".to_string()),
        indicator_id: indicator
            .map(|entry| entry.genome.id.clone())
            .unwrap_or_else(|| "none".to_string()),
        indicator_scope: indicator
            .map(indicator_scope_label)
            .unwrap_or_else(|| "All / All / All".to_string()),
    }
}

fn model_scope_label(model: &EvaluatedSignalModel) -> String {
    format!(
        "{} / {} / {}",
        model
            .model
            .target_symbol
            .as_deref()
            .unwrap_or("All"),
        model
            .model
            .target_family
            .as_deref()
            .unwrap_or("All"),
        model
            .model
            .target_regime
            .as_deref()
            .unwrap_or("All"),
    )
}

fn indicator_scope_label(indicator: &EvaluatedIndicatorGenome) -> String {
    format!(
        "{} / {} / {}",
        indicator
            .genome
            .target_symbol
            .as_deref()
            .unwrap_or("All"),
        indicator
            .genome
            .target_family
            .as_deref()
            .unwrap_or("All"),
        indicator
            .genome
            .target_regime
            .as_deref()
            .unwrap_or("All"),
    )
}

fn process_pending_operator_mode_request(mode_authority: &mut ModeAuthority, audit_trail: &mut AuditTrail) {
    let request = match fs::read_to_string(OPERATOR_MODE_REQUEST_PATH) {
        Ok(raw) => raw.trim().to_string(),
        Err(_) => return,
    };

    let _ = fs::remove_file(OPERATOR_MODE_REQUEST_PATH);

    let (level, message) = match parse_runtime_mode(&request) {
        Some(target_mode) => match apply_operator_mode_request(mode_authority, target_mode) {
            Ok(summary) => (
                if matches!(target_mode, sthyra_domain::RuntimeMode::SemiAuto) {
                    "warn"
                } else {
                    "info"
                },
                format!("Operator mode request applied: {summary}"),
            ),
            Err(error) => ("risk", error),
        },
        None => ("risk", format!("Operator mode request rejected: unsupported mode '{request}'")),
    };

    audit_trail.record_incident(IncidentRecord {
        mode: mode_authority.current(),
        message: message.clone(),
    });
    append_operator_event("set-mode", level, &message, Some(&request));
}

fn acquire_supervisor_instance_guard() -> Result<SupervisorInstanceGuard, String> {
    if let Some(parent) = Path::new(SUPERVISOR_LOCK_PATH).parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create supervisor state directory: {error}"))?;
    }

    match create_supervisor_instance_guard() {
        Ok(guard) => Ok(guard),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if !clear_stale_supervisor_lock()? {
                return Err(format!(
                    "another supervisor is already running; remove {} only if that process is confirmed dead",
                    SUPERVISOR_LOCK_PATH
                ));
            }

            create_supervisor_instance_guard()
                .map_err(|retry_error| format!("failed to acquire supervisor lock after stale cleanup: {retry_error}"))
        }
        Err(error) => Err(format!("failed to acquire supervisor lock: {error}")),
    }
}

fn create_supervisor_instance_guard() -> std::io::Result<SupervisorInstanceGuard> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(SUPERVISOR_LOCK_PATH)?;
    writeln!(file, "pid={}
started_at={}", std::process::id(), current_timestamp_string())?;

    Ok(SupervisorInstanceGuard {
        path: SUPERVISOR_LOCK_PATH,
        _file: file,
    })
}

fn clear_stale_supervisor_lock() -> Result<bool, String> {
    let lock_contents = fs::read_to_string(SUPERVISOR_LOCK_PATH).unwrap_or_default();
    let locked_pid = lock_contents.lines().find_map(parse_supervisor_lock_pid);

    if locked_pid.is_some_and(process_is_running) {
        return Ok(false);
    }

    match fs::remove_file(SUPERVISOR_LOCK_PATH) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(format!("failed to clear stale supervisor lock: {error}")),
    }
}

fn parse_supervisor_lock_pid(line: &str) -> Option<u32> {
    line.strip_prefix("pid=")?.trim().parse::<u32>().ok()
}

fn process_is_running(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }

    let output = if cfg!(target_os = "windows") {
        Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
    } else {
        Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "pid="])
            .output()
    };

    match output {
        Ok(result) if result.status.success() => {
            let stdout = String::from_utf8_lossy(&result.stdout);
            stdout.lines().any(|line| !line.trim().is_empty())
        }
        _ => false,
    }
}

fn apply_operator_mode_request(
    mode_authority: &mut ModeAuthority,
    target_mode: sthyra_domain::RuntimeMode,
) -> Result<String, String> {
    let starting_mode = mode_authority.current();
    let mut transitions = Vec::new();

    match target_mode {
        sthyra_domain::RuntimeMode::Research => {
            request_transition(mode_authority, sthyra_domain::RuntimeMode::Research, &mut transitions)?;
        }
        sthyra_domain::RuntimeMode::Paper => {
            if mode_authority.current() == sthyra_domain::RuntimeMode::Halted {
                request_transition(mode_authority, sthyra_domain::RuntimeMode::Research, &mut transitions)?;
            }
            request_transition(mode_authority, sthyra_domain::RuntimeMode::Paper, &mut transitions)?;
        }
        sthyra_domain::RuntimeMode::Protected => {
            request_transition(mode_authority, sthyra_domain::RuntimeMode::Protected, &mut transitions)?;
        }
        sthyra_domain::RuntimeMode::SemiAuto => {
            if mode_authority.current() == sthyra_domain::RuntimeMode::Halted {
                request_transition(mode_authority, sthyra_domain::RuntimeMode::Research, &mut transitions)?;
            }

            if matches!(
                mode_authority.current(),
                sthyra_domain::RuntimeMode::Research
                    | sthyra_domain::RuntimeMode::Backtest
                    | sthyra_domain::RuntimeMode::Replay
                    | sthyra_domain::RuntimeMode::Protected
            ) {
                request_transition(mode_authority, sthyra_domain::RuntimeMode::Paper, &mut transitions)?;
            }

            request_transition(mode_authority, sthyra_domain::RuntimeMode::SemiAuto, &mut transitions)?;
        }
        _ => {
            return Err(format!(
                "Operator mode request rejected: unsupported target {:?}",
                target_mode
            ));
        }
    }

    if transitions.is_empty() {
        Ok(format!("{:?} unchanged", starting_mode))
    } else {
        Ok(transitions.join(", "))
    }
}

fn request_transition(
    mode_authority: &mut ModeAuthority,
    target_mode: sthyra_domain::RuntimeMode,
    transitions: &mut Vec<String>,
) -> Result<(), String> {
    if mode_authority.current() == target_mode {
        return Ok(());
    }

    match mode_authority.request_transition(target_mode, TransitionReason::OperatorRequested) {
        Ok(decision) => {
            transitions.push(format!("{:?}->{:?}", decision.from, decision.to));
            Ok(())
        }
        Err(error) => Err(format!(
            "Operator mode request rejected: {:?} -> {:?} failed ({:?})",
            mode_authority.current(),
            target_mode,
            error
        )),
    }
}

fn parse_runtime_mode(value: &str) -> Option<sthyra_domain::RuntimeMode> {
    match value.trim() {
        "Research" => Some(sthyra_domain::RuntimeMode::Research),
        "Backtest" => Some(sthyra_domain::RuntimeMode::Backtest),
        "Replay" => Some(sthyra_domain::RuntimeMode::Replay),
        "Paper" => Some(sthyra_domain::RuntimeMode::Paper),
        "SemiAuto" => Some(sthyra_domain::RuntimeMode::SemiAuto),
        "FullAuto" => Some(sthyra_domain::RuntimeMode::FullAuto),
        "Protected" => Some(sthyra_domain::RuntimeMode::Protected),
        "Halted" => Some(sthyra_domain::RuntimeMode::Halted),
        _ => None,
    }
}

fn append_operator_event(action: &str, level: &str, message: &str, detail: Option<&str>) {
    if let Some(parent) = std::path::Path::new(OPERATOR_EVENT_LOG_PATH).parent() {
        let _ = fs::create_dir_all(parent);
    }

    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(OPERATOR_EVENT_LOG_PATH)
    {
        let timestamp = current_timestamp_string();
        let detail_field = detail
            .map(|value| format!(",\"detail\":{}", json_string(value)))
            .unwrap_or_default();
        let line = format!(
            "{{\"id\":{},\"timestamp\":{},\"level\":{},\"action\":{},\"message\":{}{} }}\n",
            json_string(&format!("{}-{}", timestamp, action)),
            json_string(&timestamp),
            json_string(level),
            json_string(action),
            json_string(message),
            detail_field,
        );
        let _ = file.write_all(line.as_bytes());
    }
}

fn json_string(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    format!("\"{}\"", escaped)
}

fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn current_timestamp_string() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::{infer_position_entry_timestamp_from_trades, UserTrade};

    #[test]
    fn infers_open_position_entry_after_flat_reset() {
        let trades = vec![
            UserTrade {
                symbol: "BTCUSDT".to_string(),
                order_id: 1,
                is_buy: true,
                price: 100_000.0,
                quantity: 0.05,
                realized_pnl: 0.0,
                time_ms: 1_000,
            },
            UserTrade {
                symbol: "BTCUSDT".to_string(),
                order_id: 2,
                is_buy: false,
                price: 101_000.0,
                quantity: 0.05,
                realized_pnl: 50.0,
                time_ms: 2_000,
            },
            UserTrade {
                symbol: "BTCUSDT".to_string(),
                order_id: 3,
                is_buy: true,
                price: 102_000.0,
                quantity: 0.02,
                realized_pnl: 0.0,
                time_ms: 3_000,
            },
            UserTrade {
                symbol: "BTCUSDT".to_string(),
                order_id: 4,
                is_buy: true,
                price: 103_000.0,
                quantity: 0.01,
                realized_pnl: 0.0,
                time_ms: 4_000,
            },
        ];

        let entry_timestamp_ms = infer_position_entry_timestamp_from_trades(&trades, 0.03, false);

        assert_eq!(entry_timestamp_ms, Some(3_000));
    }

    #[test]
    fn does_not_infer_entry_without_sufficient_history() {
        let trades = vec![
            UserTrade {
                symbol: "BTCUSDT".to_string(),
                order_id: 5,
                is_buy: true,
                price: 102_000.0,
                quantity: 0.01,
                realized_pnl: 0.0,
                time_ms: 5_000,
            },
            UserTrade {
                symbol: "BTCUSDT".to_string(),
                order_id: 6,
                is_buy: true,
                price: 103_000.0,
                quantity: 0.02,
                realized_pnl: 0.0,
                time_ms: 6_000,
            },
        ];

        let entry_timestamp_ms = infer_position_entry_timestamp_from_trades(&trades, 0.03, false);

        assert_eq!(entry_timestamp_ms, None);
    }
}
