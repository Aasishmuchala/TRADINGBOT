import { readFile } from "node:fs/promises";
import path from "node:path";

export type StatusTone = "good" | "warn" | "risk";

export type Kpi = {
  label: string;
  value: string;
  tone: StatusTone;
};

export type QueueItem = {
  symbol: string;
  family: string;
  regime: string;
  model_id: string;
  model_scope: string;
  confidence: string;
  action: string;
};

export type RuntimeBalance = {
  asset: string;
  wallet_balance: number;
};

export type RuntimePosition = {
  symbol: string;
  quantity: number;
  entry_price: number;
  leverage: number;
  unrealized_pnl: number;
  notional_usd: number;
};

export type RuntimeCandlePoint = {
  symbol: string;
  timestamp_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type RuntimeIndicatorPoint = {
  symbol: string;
  timestamp_ms: number;
  price: number;
  ema_fast: number;
  ema_slow: number;
  rsi: number;
  macd_histogram: number;
  signal_consensus: number;
};

export type RuntimeResearchModel = {
  id: string;
  engine: string;
  symbol: string;
  regime: string;
  family: string;
  score: number;
  profitability: number;
  robustness: number;
  risk_adjusted_return: number;
  latency_score: number;
  threshold: number;
};

export type RuntimePromotedIndicator = {
  id: string | null;
  overlay_enabled: boolean;
  leaderboard_count: number;
};

export type RuntimeNewsSentiment = {
  sentiment_score: number;
  confidence: number;
  catalyst_score: number;
  risk_off: boolean;
  themes: string[];
};

export type RuntimeSnapshot = {
  mode: string;
  venue: string;
  host: string;
  headline: string;
  cycle: number;
  updated_at: string;
  kpis: Kpi[];
  opportunities: QueueItem[];
  risk_notes: string[];
  heal_logs: string[];
  execution_summary: string;
  exchange_gate: string;
  balances: RuntimeBalance[];
  positions: RuntimePosition[];
  candle_points: RuntimeCandlePoint[];
  indicator_points: RuntimeIndicatorPoint[];
  research_models: RuntimeResearchModel[];
  promoted_indicator: RuntimePromotedIndicator;
  news_sentiment: RuntimeNewsSentiment;
};

const fallbackSnapshot: RuntimeSnapshot = {
  mode: "Unavailable",
  venue: "Binance USD-M",
  host: "Mac Local Runtime",
  headline: "NyraQ Operator Machine",
  cycle: 0,
  updated_at: "unavailable",
  kpis: [
    { label: "System Mode", value: "Unavailable", tone: "warn" },
    { label: "Market Confidence", value: "No data", tone: "warn" },
    { label: "Daily Risk Budget", value: "No data", tone: "warn" },
    { label: "Exchange Sync", value: "No data", tone: "warn" },
    { label: "Feed Health", value: "No data", tone: "warn" },
    { label: "Watchdog State", value: "No data", tone: "warn" },
  ],
  opportunities: [],
  risk_notes: ["Supervisor has not produced a runtime snapshot yet."],
  heal_logs: ["Waiting for local runtime snapshot."],
  execution_summary: "WaitingForSupervisorSnapshot",
  exchange_gate: "Waiting for supervisor startup",
  balances: [],
  positions: [],
  candle_points: [],
  indicator_points: [],
  research_models: [],
  promoted_indicator: {
    id: null,
    overlay_enabled: true,
    leaderboard_count: 0,
  },
  news_sentiment: {
    sentiment_score: 0,
    confidence: 0,
    catalyst_score: 0,
    risk_off: false,
    themes: [],
  },
};

export async function getRuntimeSnapshot(): Promise<RuntimeSnapshot> {
  const snapshotPath = path.join(process.cwd(), "runtime", "runtime_snapshot.json");

  try {
    const raw = await readFile(snapshotPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<RuntimeSnapshot>;

    return {
      ...fallbackSnapshot,
      ...parsed,
      promoted_indicator: {
        ...fallbackSnapshot.promoted_indicator,
        ...(parsed.promoted_indicator ?? {}),
      },
    };
  } catch {
    return fallbackSnapshot;
  }
}
