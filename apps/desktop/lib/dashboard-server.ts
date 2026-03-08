import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { readAuditSummary } from "@/lib/audit-store";
import {
  EMPTY_OPERATOR_DATA,
  type BotHealthLevel,
  type BotHealthReport,
  type DashboardInitialData,
  type DashboardOperatorData,
  type OverlayEffectCandidate,
  type OverlayEffectReport,
  type OverlayCompareReport,
} from "@/lib/dashboard-state";
import { readOperatorEventsPage, readPendingModeRequest, type OperatorMode } from "@/lib/operator-control";
import { getRuntimeSnapshot, type RuntimeSnapshot } from "@/lib/runtime-snapshot";
import { readTradingAutomationSettings, readTradingSettings, type TradingSettings } from "@/lib/trading-settings";

const RECENT_PAPER_ENTRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_PAPER_EXIT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const PAPER_MONITOR_FRESH_MS = 2 * 60 * 60 * 1000;
const RECENT_RESTART_WARMUP_MS = 20 * 60 * 1000;

function workspaceRoot() {
  return path.resolve(process.cwd(), "..", "..");
}

function overlayCompareReportPath() {
  return path.join(workspaceRoot(), ".sthyra", "overlay-compare.json");
}

function modelRegistryPath() {
  return path.join(workspaceRoot(), ".sthyra", "model-registry.json");
}

function indicatorBlacklistPath() {
  return path.join(workspaceRoot(), ".sthyra", "indicator-blacklist.json");
}

function paperMonitorCheckpointPath() {
  return path.join(workspaceRoot(), ".sthyra", "paper-week-monitor.ndjson");
}

function paperMonitorAlertPath() {
  return path.join(workspaceRoot(), ".sthyra", "paper-week-alerts.ndjson");
}

async function readOverlayCompareReport(): Promise<OverlayCompareReport | null> {
  try {
    const raw = await readFile(overlayCompareReportPath(), "utf8");
    return JSON.parse(raw) as OverlayCompareReport;
  } catch {
    return null;
  }
}

async function readModelRegistry(): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(modelRegistryPath(), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readIndicatorBlacklist(): Promise<string[]> {
  try {
    const raw = await readFile(indicatorBlacklistPath(), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
  } catch {
    return [];
  }
}

function parseTimestampMs(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readLatestNdjsonRecord<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length === 0) {
      return null;
    }

    return JSON.parse(lines.at(-1) ?? "null") as T;
  } catch {
    return null;
  }
}

type PaperMonitorCheckpoint = {
  timestamp?: string;
  status?: string;
};

type PaperMonitorAlert = {
  timestamp?: string;
  message?: string;
};

async function readPaperMonitorStatus() {
  const [checkpoint, alert] = await Promise.all([
    readLatestNdjsonRecord<PaperMonitorCheckpoint>(paperMonitorCheckpointPath()),
    readLatestNdjsonRecord<PaperMonitorAlert>(paperMonitorAlertPath()),
  ]);
  const lastCheckAtMs = parseTimestampMs(checkpoint?.timestamp ?? null);
  const fresh = lastCheckAtMs !== null && Date.now() - lastCheckAtMs <= PAPER_MONITOR_FRESH_MS;

  return {
    status: checkpoint?.status ?? null,
    lastCheckAtMs,
    fresh,
    lastAlertMessage: alert?.message ?? null,
  };
}

function buildOverlayEffectReport(
  overlayCompare: OverlayCompareReport | null,
  tradeSummary: DashboardOperatorData["audit"]["tradeSummary"],
): OverlayEffectReport | null {
  if (!overlayCompare) {
    return null;
  }

  const candidates: OverlayEffectCandidate[] = overlayCompare.changes.map((change) => {
    const exactIndicatorTrades = tradeSummary.tradeHistory
      .filter((trade) => change.selected_indicator_id !== null && trade.indicator_id === change.selected_indicator_id && trade.symbol === change.symbol)
      .sort((left, right) => left.timestamp_ms - right.timestamp_ms);
    const modelMatchedTrades = tradeSummary.tradeHistory
      .filter((trade) => trade.model_id === change.selected_model_id && trade.symbol === change.symbol)
      .sort((left, right) => left.timestamp_ms - right.timestamp_ms);
    const matchedTrades = exactIndicatorTrades.length > 0 ? exactIndicatorTrades : modelMatchedTrades;
    const attributionBasis = exactIndicatorTrades.length > 0 ? "indicator" : modelMatchedTrades.length > 0 ? "model" : "none";
    const matchedTradeCount = matchedTrades.length;
    const realizedPnlTotal = matchedTrades.reduce((total, trade) => total + trade.realized_pnl, 0);
    const wins = matchedTrades.filter((trade) => trade.realized_pnl > 0).length;
    const winRate = matchedTradeCount > 0 ? wins / matchedTradeCount : null;
    const splitIndex = matchedTradeCount >= 4 ? Math.max(1, Math.floor(matchedTradeCount / 2)) : matchedTradeCount;
    const priorTrades = matchedTrades.slice(0, splitIndex);
    const recentTrades = matchedTrades.slice(splitIndex);
    const priorAveragePnl = priorTrades.length > 0
      ? priorTrades.reduce((total, trade) => total + trade.realized_pnl, 0) / priorTrades.length
      : null;
    const recentAveragePnl = recentTrades.length > 0
      ? recentTrades.reduce((total, trade) => total + trade.realized_pnl, 0) / recentTrades.length
      : null;

    let qualityTrend: OverlayEffectCandidate["quality_trend"] = "insufficient-data";
    if (priorAveragePnl !== null && recentAveragePnl !== null) {
      const delta = recentAveragePnl - priorAveragePnl;
      if (Math.abs(delta) < 1e-6) {
        qualityTrend = "flat";
      } else {
        qualityTrend = delta > 0 ? "improving" : "weakening";
      }
    }

    return {
      scenario: change.scenario,
      symbol: change.symbol,
      family: change.family,
      selected_model_id: change.selected_model_id,
      selected_indicator_id: change.selected_indicator_id,
      without_decision: change.without_overlay.decision,
      with_decision: change.with_overlay.decision,
      attribution_basis: attributionBasis,
      confidence_delta: change.delta.confidence_score,
      expected_value_delta: change.delta.expected_value_score,
      matched_trade_count: matchedTradeCount,
      exact_indicator_trade_count: exactIndicatorTrades.length,
      realized_pnl_total: realizedPnlTotal,
      win_rate: winRate,
      recent_average_pnl: recentAveragePnl,
      prior_average_pnl: priorAveragePnl,
      quality_trend: qualityTrend,
      last_trade_at: matchedTrades.at(-1)?.timestamp_ms ?? null,
      recent_trades: matchedTrades.slice(-3).reverse(),
    };
  });

  const affectedModels = new Set(candidates.map((candidate) => candidate.selected_model_id).filter(Boolean)).size;

  return {
    changed_candidates: overlayCompare.changed_candidates,
    affected_models: affectedModels,
    improving_candidates: candidates.filter((candidate) => candidate.quality_trend === "improving").length,
    weakening_candidates: candidates.filter((candidate) => candidate.quality_trend === "weakening").length,
    flat_candidates: candidates.filter((candidate) => candidate.quality_trend === "flat").length,
    insufficient_candidates: candidates.filter((candidate) => candidate.quality_trend === "insufficient-data").length,
    candidates,
  };
}

function botHealthLevelLabel(level: BotHealthLevel) {
  switch (level) {
    case "healthy":
      return "Healthy";
    case "watching":
      return "Watching";
    case "degraded":
      return "Degraded";
    default:
      return "Offline";
  }
}

function summarizeBotHealth(
  level: BotHealthLevel,
  reasons: string[],
  options: {
    recentPaperEntry: boolean;
    recentPaperExit: boolean;
    monitorFresh: boolean;
    awaitingFirstPaperFill: boolean;
  },
) {
  if (level === "healthy") {
    return "Paper runtime is ready, the monitor is fresh, and recent fills and closes are visible.";
  }

  if (level === "offline") {
    return reasons[0] ?? "Dashboard is not receiving a fresh runtime snapshot.";
  }

  if (level === "degraded") {
    return reasons[0] ?? "Bot is reachable but not in a safe paper posture.";
  }

  if (options.awaitingFirstPaperFill) {
    return "Paper posture is ready. The runtime has just restarted and is waiting for its first fresh paper fill before execution can be proven again.";
  }

  if (!options.recentPaperEntry) {
    return "Paper posture is ready, but there are no recent simulated fills proving the entry path is still active.";
  }

  if (!options.recentPaperExit) {
    return "Paper entries are active, but there is still no fresh paper close proving the current exit path end to end.";
  }

  if (!options.monitorFresh) {
    return "Runtime looks healthy, but the week monitor has not checked in recently enough to trust unattended status.";
  }

  return reasons[0] ?? "Bot health needs operator attention.";
}

export async function buildBotHealthReport(input: {
  snapshot: RuntimeSnapshot;
  pendingModeRequest: OperatorMode | null;
  audit: DashboardOperatorData["audit"];
  tradingSettings: TradingSettings;
}): Promise<BotHealthReport> {
  const { snapshot, pendingModeRequest, audit, tradingSettings } = input;
  const watchdogState = runtimeKpiValue(snapshot, "Watchdog State")?.toLowerCase() ?? "";
  const feedHealth = runtimeKpiValue(snapshot, "Feed Health")?.toLowerCase() ?? "";
  const lastPaperEntryAtMs = audit.executionEvents
    .find((event) => event.mode === "Paper" && event.event_type === "simulated-fill")
    ?.timestamp_ms ?? null;
  const lastPaperExitAtMs = audit.tradeSummary.tradeHistory.find((trade) => trade.mode === "Paper")?.timestamp_ms ?? null;
  const recentPaperEntry = lastPaperEntryAtMs !== null && Date.now() - lastPaperEntryAtMs <= RECENT_PAPER_ENTRY_WINDOW_MS;
  const recentPaperExit = lastPaperExitAtMs !== null && Date.now() - lastPaperExitAtMs <= RECENT_PAPER_EXIT_WINDOW_MS;
  const paperReady =
    snapshot.mode === "Paper"
    && tradingSettings.transportEnabled
    && tradingSettings.streamEnabled
    && !tradingSettings.tradingEnabled
    && tradingSettings.paperTradingReady;
  const monitor = await readPaperMonitorStatus();
  const reasons: string[] = [];
  const staleSnapshot = inferSnapshotStale(snapshot);
  const snapshotUpdatedAtMs = parsedSnapshotUpdatedAtMs(snapshot);
  const runtimeRecentlyRestarted = snapshotUpdatedAtMs !== null && Date.now() - snapshotUpdatedAtMs <= RECENT_RESTART_WARMUP_MS;
  const awaitingFirstPaperFill = paperReady && runtimeRecentlyRestarted && lastPaperEntryAtMs === null;

  if (snapshot.mode === "Unavailable") {
    reasons.push("Supervisor has not produced a runtime snapshot yet.");
  }

  if (staleSnapshot) {
    reasons.push("Runtime snapshot is stale.");
  }

  if (snapshot.mode !== "Paper") {
    reasons.push(`Runtime mode is ${snapshot.mode}, not Paper.`);
  }

  if (pendingModeRequest) {
    reasons.push(`Mode request to ${pendingModeRequest} is still pending.`);
  }

  if (!tradingSettings.transportEnabled || !tradingSettings.streamEnabled) {
    reasons.push("Binance transport or market stream is disabled.");
  }

  if (tradingSettings.tradingEnabled) {
    reasons.push("Live trading toggle is enabled while the dashboard expects paper posture.");
  }

  if (!tradingSettings.paperTradingReady) {
    reasons.push("Paper trading posture is not fully configured.");
  }

  if (watchdogState.includes("halt")) {
    reasons.push("Watchdog is reporting a halted state.");
  } else if (watchdogState.includes("protected")) {
    reasons.push("Watchdog is in protected mode.");
  } else if (watchdogState.includes("guard")) {
    reasons.push("Watchdog is guarding execution.");
  }

  if (feedHealth.includes("stale")) {
    reasons.push("Feed health is stale.");
  }

  if (!monitor.fresh) {
    reasons.push(monitor.lastCheckAtMs === null ? "Week monitor has not written any checkpoint yet." : "Week monitor checkpoint is stale.");
  }

  if (awaitingFirstPaperFill) {
    reasons.push("Runtime is in warmup and waiting for the first paper fill after restart.");
  } else if (!recentPaperEntry) {
    reasons.push("No recent paper simulated fill has been recorded.");
  }

  if (!recentPaperExit) {
    reasons.push("No fresh paper close has been recorded yet.");
  }

  let level: BotHealthLevel = "healthy";

  if (snapshot.mode === "Unavailable" || (staleSnapshot && !monitor.fresh)) {
    level = "offline";
  } else if (!paperReady || watchdogState.includes("halt") || watchdogState.includes("protected") || feedHealth.includes("stale") || pendingModeRequest !== null) {
    level = "degraded";
  } else if (!recentPaperEntry || !recentPaperExit || !monitor.fresh) {
    level = "watching";
  }

  return {
    level,
    label: botHealthLevelLabel(level),
    summary: summarizeBotHealth(level, reasons, {
      recentPaperEntry,
      recentPaperExit,
      monitorFresh: monitor.fresh,
      awaitingFirstPaperFill,
    }),
    reasons,
    paper_status: paperReady ? "Paper ready" : snapshot.mode === "Paper" ? "Paper incomplete" : `Mode ${snapshot.mode}`,
    monitor_status: monitor.lastCheckAtMs === null ? "No week monitor data" : monitor.fresh ? "Monitor fresh" : "Monitor stale",
    execution_status: awaitingFirstPaperFill
      ? "Awaiting first post-restart fill"
      : recentPaperEntry
        ? recentPaperExit
          ? "Recent paper fill and close"
          : "Recent paper fill, exit still unproven"
        : "No recent paper fill",
    startup_status: awaitingFirstPaperFill ? "Warmup after restart" : runtimeRecentlyRestarted ? "Recently restarted" : "Steady state",
    last_snapshot_at: snapshot.updated_at,
    last_monitor_check_at_ms: monitor.lastCheckAtMs,
    last_paper_entry_at_ms: lastPaperEntryAtMs,
    last_paper_exit_at_ms: lastPaperExitAtMs,
    pending_mode_request: pendingModeRequest,
    paper_ready: paperReady,
    recent_paper_entry: recentPaperEntry,
    recent_paper_exit: recentPaperExit,
    monitor_fresh: monitor.fresh,
    awaiting_first_paper_fill: awaitingFirstPaperFill,
    last_alert_message: monitor.lastAlertMessage,
  };
}

export async function getDashboardInitialData(eventLimit = 16): Promise<DashboardInitialData> {
  const [snapshot, eventPage, pendingModeRequest, audit, overlayCompare, tradingSettings] = await Promise.all([
    getRuntimeSnapshot(),
    readOperatorEventsPage(eventLimit),
    readPendingModeRequest(),
    readAuditSummary().catch(() => EMPTY_OPERATOR_DATA.audit),
    readOverlayCompareReport(),
    readTradingSettings(),
  ]);
  const botHealth = await buildBotHealthReport({
    snapshot,
    pendingModeRequest,
    audit,
    tradingSettings,
  });

  const operator: DashboardOperatorData = {
    events: eventPage.events,
    pendingModeRequest,
    audit,
    overlayCompare,
    overlayEffect: buildOverlayEffectReport(overlayCompare, audit.tradeSummary),
    botHealth,
  };

  return {
    snapshot,
    operator,
  };
}

function parsedSnapshotUpdatedAtMs(snapshot: RuntimeSnapshot) {
  const parsed = Date.parse(snapshot.updated_at);
  return Number.isFinite(parsed) ? parsed : null;
}

function inferSnapshotStale(snapshot: RuntimeSnapshot) {
  const updatedAtMs = parsedSnapshotUpdatedAtMs(snapshot);
  if (updatedAtMs === null) {
    return true;
  }

  return Date.now() - updatedAtMs > 15_000;
}

function buildResponseMeta(snapshot: RuntimeSnapshot) {
  return {
    request_id: randomUUID(),
    generated_at_ms: parsedSnapshotUpdatedAtMs(snapshot) ?? Date.now(),
    stale: inferSnapshotStale(snapshot),
  };
}

function snapshotWalletBalance(snapshot: RuntimeSnapshot) {
  return snapshot.balances.reduce((total, balance) => total + balance.wallet_balance, 0);
}

function runtimeKpiValue(snapshot: RuntimeSnapshot, label: string) {
  return snapshot.kpis.find((kpi) => kpi.label === label)?.value ?? null;
}

function deriveRiskPosture(snapshot: RuntimeSnapshot) {
  const watchdogState = runtimeKpiValue(snapshot, "Watchdog State")?.toLowerCase() ?? "";
  const feedHealth = runtimeKpiValue(snapshot, "Feed Health")?.toLowerCase() ?? "";

  if (snapshot.mode === "Halted" || watchdogState.includes("halt")) {
    return "Halted";
  }

  if (snapshot.mode === "Protected" || watchdogState.includes("protected") || feedHealth.includes("stale")) {
    return "Protected";
  }

  if (snapshot.risk_notes.length > 0 || watchdogState.includes("guard")) {
    return "Caution";
  }

  return "Healthy";
}

export async function getOverviewData() {
  const { snapshot, operator } = await getDashboardInitialData();
  const snapshotBalance = snapshotWalletBalance(snapshot);
  const walletBalance = operator.audit.balanceSummary.latestTotalWalletBalance ?? (snapshot.balances.length > 0 ? snapshotBalance : null);
  const realizedPnl = operator.audit.tradeSummary.realizedPnlTotal;
  const unrealizedPnl = snapshot.positions.reduce((total, position) => total + position.unrealized_pnl, 0);
  const openExposure = snapshot.positions.reduce((total, position) => total + position.notional_usd, 0);
  const staleFlags: string[] = [];

  if (inferSnapshotStale(snapshot)) {
    staleFlags.push("runtime-snapshot");
  }

  if (operator.pendingModeRequest) {
    staleFlags.push(`pending-mode-${operator.pendingModeRequest.toLowerCase()}`);
  }

  return {
    ...buildResponseMeta(snapshot),
    overview: {
      mode: snapshot.mode,
      venue: snapshot.venue,
      host: snapshot.host,
      headline: snapshot.headline,
      cycle: snapshot.cycle,
      wallet_balance_usd: walletBalance,
      realized_pnl_usd: realizedPnl,
      unrealized_pnl_usd: unrealizedPnl,
      open_exposure_usd: openExposure,
      top_opportunity: snapshot.opportunities[0] ?? null,
      top_position: snapshot.positions[0] ?? null,
      stale_flags: staleFlags,
    },
  };
}

export async function getPositionsData() {
  const { snapshot, operator } = await getDashboardInitialData();

  return {
    ...buildResponseMeta(snapshot),
    positions: {
      mode: snapshot.mode,
      open_positions: snapshot.positions,
      open_position_entries: operator.audit.openPositionEntries,
      balance_summary: operator.audit.balanceSummary,
      recent_trades: operator.audit.tradeSummary.recentTrades,
      incidents: operator.audit.incidents,
    },
  };
}

export async function getMarketsData(symbol: string) {
  const { snapshot, operator } = await getDashboardInitialData();
  const selectedSymbol = symbol === "All" ? "All" : symbol;
  const filterBySymbol = <T extends { symbol: string }>(items: T[]) => selectedSymbol === "All" ? items : items.filter((item) => item.symbol === selectedSymbol);

  return {
    ...buildResponseMeta(snapshot),
    market: {
      selected_symbol: selectedSymbol,
      mode: snapshot.mode,
      headline: snapshot.headline,
      opportunities: filterBySymbol(snapshot.opportunities),
      positions: filterBySymbol(snapshot.positions),
      candle_points: filterBySymbol(snapshot.candle_points),
      indicator_points: filterBySymbol(snapshot.indicator_points),
      research_models: selectedSymbol === "All"
        ? snapshot.research_models
        : snapshot.research_models.filter((model) => model.symbol === "All" || model.symbol === selectedSymbol),
      promoted_indicator: snapshot.promoted_indicator,
      news_sentiment: snapshot.news_sentiment,
      incidents: operator.audit.incidents,
      stale_flags: inferSnapshotStale(snapshot) ? ["runtime-snapshot"] : [],
    },
  };
}

export async function getRiskPostureData() {
  const { snapshot, operator } = await getDashboardInitialData();
  const openExposureUsd = snapshot.positions.reduce((total, position) => total + position.notional_usd, 0);
  const unrealizedPnlUsd = snapshot.positions.reduce((total, position) => total + position.unrealized_pnl, 0);

  return {
    ...buildResponseMeta(snapshot),
    risk: {
      posture_state: deriveRiskPosture(snapshot),
      mode: snapshot.mode,
      exchange_gate: snapshot.exchange_gate,
      execution_summary: snapshot.execution_summary,
      risk_notes: snapshot.risk_notes,
      risk_off: snapshot.news_sentiment.risk_off,
      sentiment: snapshot.news_sentiment,
      exact_coverage_rate: operator.audit.tradeSummary.exactCoverageRate,
      exact_trade_count: operator.audit.tradeSummary.exactTradeCount,
      estimated_trade_count: operator.audit.tradeSummary.estimatedTradeCount,
      open_exposure_usd: openExposureUsd,
      unrealized_pnl_usd: unrealizedPnlUsd,
      incidents: operator.audit.incidents,
      retention: operator.audit.retention,
      stale_flags: inferSnapshotStale(snapshot) ? ["runtime-snapshot"] : [],
    },
  };
}

export async function getExecutionPostureData() {
  const { snapshot, operator } = await getDashboardInitialData(32);

  return {
    ...buildResponseMeta(snapshot),
    execution: {
      mode: snapshot.mode,
      pending_mode_request: operator.pendingModeRequest,
      execution_summary: snapshot.execution_summary,
      exchange_gate: snapshot.exchange_gate,
      open_positions: snapshot.positions,
      order_intents: operator.audit.orderIntents,
      execution_events: operator.audit.executionEvents,
      operator_events: operator.events,
      incidents: operator.audit.incidents,
      stale_flags: inferSnapshotStale(snapshot) ? ["runtime-snapshot"] : [],
    },
  };
}

export async function getIncidentsData(limit = 20) {
  const { snapshot, operator } = await getDashboardInitialData(limit);

  return {
    ...buildResponseMeta(snapshot),
    incidents: {
      mode: snapshot.mode,
      items: operator.audit.incidents,
      operator_events: operator.events.filter((event) => event.level !== "info"),
      stale_flags: inferSnapshotStale(snapshot) ? ["runtime-snapshot"] : [],
    },
  };
}

export async function getModelPacksData() {
  const { snapshot, operator } = await getDashboardInitialData();
  const [registry, blacklistedIndicatorIds, policy] = await Promise.all([
    readModelRegistry(),
    readIndicatorBlacklist(),
    readTradingAutomationSettings(),
  ]);
  const promotedModel = typeof registry?.promoted_model === "object" && registry.promoted_model !== null
    ? registry.promoted_model as {
        model?: { id?: string; generation?: number; approval_threshold?: number };
        fitness_score?: number;
        profitability_score?: number;
        robustness_score?: number;
      }
    : null;
  const promotedIndicator = typeof registry?.promoted_indicator === "object" && registry.promoted_indicator !== null
    ? registry.promoted_indicator as {
        genome?: { id?: string; generation?: number; approval_threshold?: number; target_regime?: string | null; target_family?: string | null };
        fitness_score?: number;
        profitability_score?: number;
        robustness_score?: number;
        latency_score?: number;
      }
    : null;
  const signalLeaderboard = Array.isArray(registry?.leaderboard)
    ? registry.leaderboard as Array<{
        model?: { id?: string; generation?: number; target_symbol?: string | null; target_regime?: string | null; target_family?: string | null; approval_threshold?: number };
        fitness_score?: number;
        profitability_score?: number;
        robustness_score?: number;
        risk_adjusted_return?: number;
      }>
    : [];
  const indicatorLeaderboard = (Array.isArray(registry?.indicator_leaderboard)
    ? registry.indicator_leaderboard as Array<{
        genome?: { id?: string; generation?: number; target_symbol?: string | null; target_regime?: string | null; target_family?: string | null; approval_threshold?: number };
        fitness_score?: number;
        profitability_score?: number;
        robustness_score?: number;
        latency_score?: number;
      }>
    : []).map((entry) => ({
      ...entry,
      blacklisted: typeof entry.genome?.id === "string" && blacklistedIndicatorIds.includes(entry.genome.id),
    }));

  return {
    ...buildResponseMeta(snapshot),
    model_packs: {
      active: {
        promoted_indicator: snapshot.promoted_indicator,
        promoted_model: promotedModel,
        promoted_indicator_pack: promotedIndicator,
      },
      candidate: operator.overlayCompare
        ? {
            promoted_indicator: operator.overlayCompare.promoted_indicator,
            scenarios_evaluated: operator.overlayCompare.scenarios_evaluated,
            approvals_without_overlay: operator.overlayCompare.approvals_without_overlay,
            approvals_with_overlay: operator.overlayCompare.approvals_with_overlay,
            changed_candidates: operator.overlayCompare.changed_candidates,
            report_path: operator.overlayCompare.report_path,
            day_key: operator.overlayCompare.day_key,
          }
        : null,
          signal_leaderboard: signalLeaderboard,
          indicator_leaderboard: indicatorLeaderboard,
          blacklisted_indicator_ids: blacklistedIndicatorIds,
          policy,
      research_models: snapshot.research_models,
      comparator: operator.overlayCompare,
      stale_flags: [
        ...(inferSnapshotStale(snapshot) ? ["runtime-snapshot"] : []),
        ...(operator.overlayCompare ? [] : ["comparator-unavailable"]),
      ],
    },
  };
}