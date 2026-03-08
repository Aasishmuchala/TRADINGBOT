import type {
  AuditBalanceSummary,
  AuditClosedTrade,
  AuditExecutionEvent,
  AuditIncident,
  AuditOpenPositionEntry,
  AuditOrderIntent,
  AuditRetentionStat,
  AuditTradeSummary,
} from "@/lib/audit-store";
import type { OperatorEvent, OperatorMode } from "@/lib/operator-control";
import type { RuntimeSnapshot } from "@/lib/runtime-snapshot";

export type DashboardPage =
  | "overview"
  | "positions"
  | "markets"
  | "risk"
  | "execution"
  | "review"
  | "settings";

export type OperatorAction =
  | "bootstrap-runtime"
  | "status"
  | "overlay-compare"
  | "prune-indicators"
  | "restart-supervisor"
  | "stop-supervisor"
  | "export-audit"
  | "compact-audit-db"
  | "clear-maintenance-history"
  | "prune-legacy-incidents"
  | "set-mode";

export type OverlayCompareDecisionSnapshot = {
  decision: string;
  confidence_score: number;
  expected_value_score: number;
};

export type OverlayCompareChange = {
  scenario: string;
  symbol: string;
  family: string;
  selected_model_id: string | null;
  selected_indicator_id: string | null;
  without_overlay: OverlayCompareDecisionSnapshot;
  with_overlay: OverlayCompareDecisionSnapshot;
  delta: {
    confidence_score: number;
    expected_value_score: number;
  };
};

export type OverlayCompareReport = {
  report_path: string;
  day_key: string;
  promoted_indicator: string | null;
  scenarios_evaluated: number;
  approvals_without_overlay: number;
  approvals_with_overlay: number;
  changed_candidates: number;
  changes: OverlayCompareChange[];
};

export type OverlayEffectTrend = "improving" | "weakening" | "flat" | "insufficient-data";

export type OverlayEffectAttributionBasis = "indicator" | "model" | "none";

export type OverlayEffectCandidate = {
  scenario: string;
  symbol: string;
  family: string;
  selected_model_id: string | null;
  selected_indicator_id: string | null;
  without_decision: string;
  with_decision: string;
  attribution_basis: OverlayEffectAttributionBasis;
  confidence_delta: number;
  expected_value_delta: number;
  matched_trade_count: number;
  exact_indicator_trade_count: number;
  realized_pnl_total: number;
  win_rate: number | null;
  recent_average_pnl: number | null;
  prior_average_pnl: number | null;
  quality_trend: OverlayEffectTrend;
  last_trade_at: number | null;
  recent_trades: AuditClosedTrade[];
};

export type OverlayEffectReport = {
  changed_candidates: number;
  affected_models: number;
  improving_candidates: number;
  weakening_candidates: number;
  flat_candidates: number;
  insufficient_candidates: number;
  candidates: OverlayEffectCandidate[];
};

export type BotHealthLevel = "healthy" | "watching" | "degraded" | "offline";

export type BotHealthReport = {
  level: BotHealthLevel;
  label: string;
  summary: string;
  reasons: string[];
  paper_status: string;
  monitor_status: string;
  execution_status: string;
  startup_status: string;
  last_snapshot_at: string | null;
  last_monitor_check_at_ms: number | null;
  last_paper_entry_at_ms: number | null;
  last_paper_exit_at_ms: number | null;
  pending_mode_request: OperatorMode | null;
  paper_ready: boolean;
  recent_paper_entry: boolean;
  recent_paper_exit: boolean;
  monitor_fresh: boolean;
  awaiting_first_paper_fill: boolean;
  last_alert_message: string | null;
};

export type DashboardOperatorData = {
  events: OperatorEvent[];
  pendingModeRequest: OperatorMode | null;
  audit: {
    incidents: AuditIncident[];
    orderIntents: AuditOrderIntent[];
    executionEvents: AuditExecutionEvent[];
    openPositionEntries: AuditOpenPositionEntry[];
    balanceSummary: AuditBalanceSummary;
    tradeSummary: AuditTradeSummary;
    retention: {
      orderIntents: AuditRetentionStat;
      executionEvents: AuditRetentionStat;
    };
  };
  overlayCompare: OverlayCompareReport | null;
  overlayEffect: OverlayEffectReport | null;
  botHealth: BotHealthReport;
};

export type DashboardInitialData = {
  snapshot: RuntimeSnapshot;
  operator: DashboardOperatorData;
};

export const EMPTY_BALANCE_SUMMARY: AuditBalanceSummary = {
  latestTotalWalletBalance: null,
  latestSnapshotAt: null,
  latestDayDelta: null,
  calendar: [],
};

export const EMPTY_TRADE_SUMMARY: AuditTradeSummary = {
  closedTrades: 0,
  wins: 0,
  losses: 0,
  winRate: null,
  realizedPnlTotal: 0,
  averageWinPnl: null,
  averageLossPnl: null,
  profitFactor: null,
  expectancyPerTrade: null,
  averagePnlRatio: null,
  exactTradeCount: 0,
  estimatedTradeCount: 0,
  exactCoverageRate: null,
  exactMetrics: {
    closedTrades: 0,
    wins: 0,
    losses: 0,
    winRate: null,
    realizedPnlTotal: 0,
    averageWinPnl: null,
    averageLossPnl: null,
    profitFactor: null,
    expectancyPerTrade: null,
    averagePnlRatio: null,
  },
  realizedEquityCurve: [],
  tradeHistory: [],
  recentTrades: [],
};

export const EMPTY_OPERATOR_DATA: DashboardOperatorData = {
  events: [],
  pendingModeRequest: null,
  audit: {
    incidents: [],
    orderIntents: [],
    executionEvents: [],
    openPositionEntries: [],
    balanceSummary: EMPTY_BALANCE_SUMMARY,
    tradeSummary: EMPTY_TRADE_SUMMARY,
    retention: {
      orderIntents: { currentCount: 0, limit: 500, maxAgeMs: 7 * 24 * 60 * 60 * 1000 },
      executionEvents: { currentCount: 0, limit: 1000, maxAgeMs: 30 * 24 * 60 * 60 * 1000 },
    },
  },
  overlayCompare: null,
  overlayEffect: null,
  botHealth: {
    level: "offline",
    label: "Offline",
    summary: "Dashboard has not received a usable runtime snapshot yet.",
    reasons: ["Waiting for supervisor snapshot."],
    paper_status: "Unknown",
    monitor_status: "No monitor data",
    execution_status: "No paper fills yet",
    startup_status: "Waiting for runtime",
    last_snapshot_at: null,
    last_monitor_check_at_ms: null,
    last_paper_entry_at_ms: null,
    last_paper_exit_at_ms: null,
    pending_mode_request: null,
    paper_ready: false,
    recent_paper_entry: false,
    recent_paper_exit: false,
    monitor_fresh: false,
    awaiting_first_paper_fill: false,
    last_alert_message: null,
  },
};