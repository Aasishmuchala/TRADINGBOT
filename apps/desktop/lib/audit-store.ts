import path from "node:path";
import sqlite3 from "sqlite3";

export type AuditIncident = {
  id: number;
  mode: string;
  message: string;
};

export type LegacyExecutionIncident = AuditIncident;

export type AuditOrderIntent = {
  id: number;
  symbol: string;
  mode: string;
  decision: string;
  size_usd: number;
  model_id: string;
  model_scope: string;
  indicator_id?: string | null;
  indicator_scope?: string | null;
};

export type AuditExecutionEvent = {
  id: number;
  timestamp_ms: number;
  symbol: string;
  mode: string;
  decision: string;
  event_type: string;
  state: string;
  detail: string;
  model_id: string;
  model_scope: string;
  indicator_id?: string | null;
  indicator_scope?: string | null;
};

export type AuditOpenPositionEntry = {
  symbol: string;
  entry_timestamp_ms: number;
  updated_at_ms: number;
};

export type AuditRetentionStat = {
  currentCount: number;
  limit: number;
  maxAgeMs: number;
};

export type AuditBalanceCalendarDay = {
  day: string;
  closeBalance: number | null;
  delta: number | null;
  tone: "green" | "red" | "flat" | "empty";
};

export type AuditBalanceSummary = {
  latestTotalWalletBalance: number | null;
  latestSnapshotAt: number | null;
  latestDayDelta: number | null;
  calendar: AuditBalanceCalendarDay[];
};

export type AuditClosedTrade = {
  id: number;
  timestamp_ms: number;
  entry_timestamp_ms: number | null;
  symbol: string;
  mode: string;
  side: string;
  quantity: number;
  entry_price: number;
  exit_price: number;
  realized_pnl: number;
  pnl_ratio: number;
  close_reason: string;
  source: string;
  model_id: string;
  model_scope: string;
  indicator_id?: string | null;
  indicator_scope?: string | null;
};

export type AuditTradeMetricSet = {
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  realizedPnlTotal: number;
  averageWinPnl: number | null;
  averageLossPnl: number | null;
  profitFactor: number | null;
  expectancyPerTrade: number | null;
  averagePnlRatio: number | null;
};

export type AuditTradeCurvePoint = {
  timestamp_ms: number;
  cumulativePnl: number;
};

export type AuditTradeSummary = AuditTradeMetricSet & {
  exactTradeCount: number;
  estimatedTradeCount: number;
  exactCoverageRate: number | null;
  exactMetrics: AuditTradeMetricSet;
  realizedEquityCurve: AuditTradeCurvePoint[];
  tradeHistory: AuditClosedTrade[];
  recentTrades: AuditClosedTrade[];
};

export type AuditSummary = {
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

type AuditBalanceSnapshotRow = {
  timestamp_ms: number;
  asset: string;
  wallet_balance: number;
};

type DatabaseConnection = sqlite3.Database;

const LEGACY_INCIDENT_FILTER =
  "message like 'candidate %' or message like 'replay approved %' or message like 'live order path %' or message = 'supervisor boot sequence complete'";
const ORDER_INTENT_RETENTION_LIMIT = 500;
const EXECUTION_EVENT_RETENTION_LIMIT = 1000;
const ORDER_INTENT_RETENTION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const EXECUTION_EVENT_RETENTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const BALANCE_CALENDAR_DAYS = 35;
const BALANCE_HISTORY_LOOKBACK_MS = 120 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TRADE_OUTCOME_LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000;

function workspaceRoot() {
  return path.resolve(process.cwd(), "..", "..");
}

function auditDatabasePath() {
  return path.join(workspaceRoot(), ".sthyra", "audit.sqlite3");
}

function openDatabase(mode = sqlite3.OPEN_READONLY): Promise<DatabaseConnection> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(auditDatabasePath(), mode, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(database);
    });
  });
}

function runStatement(database: DatabaseConnection, query: string, params: Array<string | number>): Promise<void> {
  return new Promise((resolve, reject) => {
    database.run(query, params, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function allRows<T>(database: DatabaseConnection, query: string, params: Array<string | number>): Promise<T[]> {
  return new Promise((resolve, reject) => {
    database.all(query, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows as T[]);
    });
  });
}

function getScalar<T>(database: DatabaseConnection, query: string, params: Array<string | number>): Promise<T> {
  return new Promise((resolve, reject) => {
    database.get(query, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }
      const value = row ? (Object.values(row)[0] as T) : undefined;
      resolve(value as T);
    });
  });
}

function closeDatabase(database: DatabaseConnection): Promise<void> {
  return new Promise((resolve, reject) => {
    database.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function utcDayKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function buildBalanceSummary(rows: AuditBalanceSnapshotRow[]): AuditBalanceSummary {
  if (rows.length === 0) {
    return {
      latestTotalWalletBalance: null,
      latestSnapshotAt: null,
      latestDayDelta: null,
      calendar: [],
    };
  }

  const totalsByTimestamp = new Map<number, number>();

  for (const row of rows) {
    totalsByTimestamp.set(row.timestamp_ms, (totalsByTimestamp.get(row.timestamp_ms) ?? 0) + row.wallet_balance);
  }

  const timeline = Array.from(totalsByTimestamp.entries())
    .map(([timestampMs, totalWalletBalance]) => ({ timestampMs, totalWalletBalance }))
    .sort((left, right) => left.timestampMs - right.timestampMs);

  const latestPoint = timeline.at(-1) ?? null;
  const closesByDay = new Map<string, { timestampMs: number; totalWalletBalance: number }>();

  for (const point of timeline) {
    closesByDay.set(utcDayKey(point.timestampMs), point);
  }

  const todayUtc = utcDayKey(Date.now());
  const todayStartMs = Date.parse(`${todayUtc}T00:00:00.000Z`);
  const calendar: AuditBalanceCalendarDay[] = [];
  let previousClose: number | null = null;

  for (let offset = BALANCE_CALENDAR_DAYS - 1; offset >= 0; offset -= 1) {
    const dayStartMs = todayStartMs - offset * DAY_MS;
    const dayKey = utcDayKey(dayStartMs);
    const close = closesByDay.get(dayKey)?.totalWalletBalance ?? null;
    let delta: number | null = null;
    let tone: AuditBalanceCalendarDay["tone"] = "empty";

    if (close !== null) {
      if (previousClose !== null) {
        delta = close - previousClose;
      }

      if (delta === null || Math.abs(delta) < 1e-8) {
        tone = "flat";
      } else if (delta > 0) {
        tone = "green";
      } else {
        tone = "red";
      }

      previousClose = close;
    }

    calendar.push({
      day: dayKey,
      closeBalance: close,
      delta,
      tone,
    });
  }

  const populatedDays = calendar.filter((day) => day.closeBalance !== null);
  const latestDay = populatedDays.at(-1) ?? null;

  return {
    latestTotalWalletBalance: latestPoint?.totalWalletBalance ?? null,
    latestSnapshotAt: latestPoint?.timestampMs ?? null,
    latestDayDelta: latestDay?.delta ?? null,
    calendar,
  };
}

function buildTradeSummary(rows: AuditClosedTrade[]): AuditTradeSummary {
  const allMetrics = buildTradeMetricSet(rows);
  const exactRows = rows.filter((trade) => trade.source === "binance-user-trades");
  const exactMetrics = buildTradeMetricSet(exactRows);
  const exactTradeCount = exactRows.length;
  const estimatedTradeCount = rows.length - exactTradeCount;

  const closedTrades = rows.length;

  return {
    ...allMetrics,
    exactTradeCount,
    estimatedTradeCount,
    exactCoverageRate: closedTrades > 0 ? exactTradeCount / closedTrades : null,
    exactMetrics,
    realizedEquityCurve: buildRealizedEquityCurve(rows),
    tradeHistory: rows,
    recentTrades: rows.slice(0, 8),
  };
}

function buildTradeMetricSet(rows: AuditClosedTrade[]): AuditTradeMetricSet {
  const closedTrades = rows.length;
  const wins = rows.filter((trade) => trade.realized_pnl > 1e-8).length;
  const losses = rows.filter((trade) => trade.realized_pnl < -1e-8).length;
  const realizedPnlTotal = rows.reduce((total, trade) => total + trade.realized_pnl, 0);
  const grossProfit = rows
    .filter((trade) => trade.realized_pnl > 1e-8)
    .reduce((total, trade) => total + trade.realized_pnl, 0);
  const grossLossAbs = rows
    .filter((trade) => trade.realized_pnl < -1e-8)
    .reduce((total, trade) => total + Math.abs(trade.realized_pnl), 0);
  const pnlRatioTotal = rows.reduce((total, trade) => total + trade.pnl_ratio, 0);

  return {
    closedTrades,
    wins,
    losses,
    winRate: closedTrades > 0 ? wins / closedTrades : null,
    realizedPnlTotal,
    averageWinPnl: wins > 0 ? grossProfit / wins : null,
    averageLossPnl: losses > 0 ? -grossLossAbs / losses : null,
    profitFactor: grossLossAbs > 1e-8 ? grossProfit / grossLossAbs : null,
    expectancyPerTrade: closedTrades > 0 ? realizedPnlTotal / closedTrades : null,
    averagePnlRatio: closedTrades > 0 ? pnlRatioTotal / closedTrades : null,
  };
}

function buildRealizedEquityCurve(rows: AuditClosedTrade[]): AuditTradeCurvePoint[] {
  let cumulativePnl = 0;

  return [...rows]
    .sort((left, right) => left.timestamp_ms - right.timestamp_ms)
    .map((trade) => {
      cumulativePnl += trade.realized_pnl;
      return {
        timestamp_ms: trade.timestamp_ms,
        cumulativePnl,
      };
    })
    .slice(-48);
}

export async function readAuditSummary(limit = 20): Promise<AuditSummary> {
  const database = await openDatabase();
  const balanceCutoffMs = Date.now() - BALANCE_HISTORY_LOOKBACK_MS;
  const tradeCutoffMs = Date.now() - TRADE_OUTCOME_LOOKBACK_MS;

  try {
    const [incidents, orderIntents, executionEvents, openPositionEntries, balanceRows, tradeRows, orderIntentCount, executionEventCount] = await Promise.all([
      allRows<AuditIncident>(
        database,
        "select id, mode, message from incidents order by id desc limit ?",
        [limit],
      ),
      allRows<AuditOrderIntent>(
        database,
        "select id, symbol, mode, decision, size_usd, model_id, model_scope, indicator_id, indicator_scope from order_intents order by id desc limit ?",
        [limit],
      ).catch(async () => {
        const rows = await allRows<AuditOrderIntent>(
          database,
          "select id, symbol, mode, decision, size_usd, model_id, model_scope from order_intents order by id desc limit ?",
          [limit],
        );
        return rows.map((row) => ({ ...row, indicator_id: null, indicator_scope: null }));
      }),
      allRows<AuditExecutionEvent>(
        database,
        "select id, timestamp_ms, symbol, mode, decision, event_type, state, detail, model_id, model_scope, indicator_id, indicator_scope from execution_events order by id desc limit ?",
        [limit],
      ).catch(async () => {
        const rows = await allRows<AuditExecutionEvent>(
          database,
          "select id, timestamp_ms, symbol, mode, decision, event_type, state, detail, model_id, model_scope from execution_events order by id desc limit ?",
          [limit],
        );
        return rows.map((row) => ({ ...row, indicator_id: null, indicator_scope: null }));
      }),
      allRows<AuditOpenPositionEntry>(
        database,
        "select symbol, entry_timestamp_ms, updated_at_ms from runtime_position_entries order by symbol asc",
        [],
      ).catch(() => []),
      allRows<AuditBalanceSnapshotRow>(
        database,
        "select timestamp_ms, asset, wallet_balance from account_balance_snapshots where timestamp_ms >= ? order by timestamp_ms asc, asset asc",
        [balanceCutoffMs],
      ).catch(() => []),
      allRows<AuditClosedTrade>(
        database,
        "select id, timestamp_ms, entry_timestamp_ms, symbol, mode, side, quantity, entry_price, exit_price, realized_pnl, pnl_ratio, close_reason, source, model_id, model_scope, indicator_id, indicator_scope from trade_outcomes where timestamp_ms >= ? order by timestamp_ms desc limit 250",
        [tradeCutoffMs],
      ).catch(async () => {
        const rows = await allRows<AuditClosedTrade>(
          database,
          "select id, timestamp_ms, entry_timestamp_ms, symbol, mode, side, quantity, entry_price, exit_price, realized_pnl, pnl_ratio, close_reason, source, model_id, model_scope from trade_outcomes where timestamp_ms >= ? order by timestamp_ms desc limit 250",
          [tradeCutoffMs],
        ).catch(() => []);
        return rows.map((row) => ({ ...row, indicator_id: null, indicator_scope: null }));
      }),
      getScalar<number>(database, "select count(*) from order_intents", []),
      getScalar<number>(database, "select count(*) from execution_events", []),
    ]);

    return {
      incidents,
      orderIntents,
      executionEvents,
      openPositionEntries,
      balanceSummary: buildBalanceSummary(balanceRows),
      tradeSummary: buildTradeSummary(tradeRows),
      retention: {
        orderIntents: {
          currentCount: orderIntentCount,
          limit: ORDER_INTENT_RETENTION_LIMIT,
          maxAgeMs: ORDER_INTENT_RETENTION_MAX_AGE_MS,
        },
        executionEvents: {
          currentCount: executionEventCount,
          limit: EXECUTION_EVENT_RETENTION_LIMIT,
          maxAgeMs: EXECUTION_EVENT_RETENTION_MAX_AGE_MS,
        },
      },
    };
  } finally {
    await closeDatabase(database);
  }
}

export async function readLegacyExecutionIncidents(): Promise<LegacyExecutionIncident[]> {
  const database = await openDatabase();

  try {
    return await allRows<LegacyExecutionIncident>(
      database,
      `select id, mode, message from incidents where ${LEGACY_INCIDENT_FILTER} order by id desc`,
      [],
    );
  } finally {
    await closeDatabase(database);
  }
}

export async function deleteLegacyExecutionIncidents(): Promise<number> {
  const database = await openDatabase(sqlite3.OPEN_READWRITE);

  try {
    const incidents = await allRows<{ id: number }>(
      database,
      `select id from incidents where ${LEGACY_INCIDENT_FILTER}`,
      [],
    );

    if (incidents.length === 0) {
      return 0;
    }

    await runStatement(
      database,
      `delete from incidents where ${LEGACY_INCIDENT_FILTER}`,
      [],
    );

    return incidents.length;
  } finally {
    await closeDatabase(database);
  }
}

export async function compactAuditDatabase(): Promise<void> {
  const database = await openDatabase(sqlite3.OPEN_READWRITE);

  try {
    await runStatement(database, "vacuum", []);
  } finally {
    await closeDatabase(database);
  }
}