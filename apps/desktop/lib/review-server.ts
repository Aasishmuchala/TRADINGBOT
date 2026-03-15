import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { type AuditClosedTrade } from "@/lib/audit-store";
import { getDashboardInitialData } from "@/lib/dashboard-server";

type ReviewFilters = {
  symbolFilter: string;
  modelFilter: string;
  familyFilter: string;
  regimeFilter: string;
  closeReasonFilter: string;
  sideFilter: string;
  sourceFilter: string;
  holdFilter: string;
  dateRangeFilter: string;
  customStartDate: string;
  customEndDate: string;
  sortBy: string;
  limit: number;
};

function workspaceRoot() {
  return path.resolve(process.cwd(), "..", "..");
}

function exportsDir() {
  return path.join(workspaceRoot(), ".sthyra", "exports");
}

function normalizeFilter(value: string | null, fallback = "All") {
  return value && value.trim().length > 0 ? value.trim() : fallback;
}

function normalizeReviewFilters(searchParams: URLSearchParams): ReviewFilters {
  const parsedLimit = Number.parseInt(searchParams.get("limit") ?? "100", 10);

  return {
    symbolFilter: normalizeFilter(searchParams.get("symbol")),
    modelFilter: normalizeFilter(searchParams.get("model")),
    familyFilter: normalizeFilter(searchParams.get("family")),
    regimeFilter: normalizeFilter(searchParams.get("regime")),
    closeReasonFilter: normalizeFilter(searchParams.get("closeReason")),
    sideFilter: normalizeFilter(searchParams.get("side")),
    sourceFilter: normalizeFilter(searchParams.get("source")),
    holdFilter: normalizeFilter(searchParams.get("hold")),
    dateRangeFilter: normalizeFilter(searchParams.get("dateRange"), "All"),
    customStartDate: searchParams.get("startDate")?.trim() ?? "",
    customEndDate: searchParams.get("endDate")?.trim() ?? "",
    sortBy: normalizeFilter(searchParams.get("sortBy"), "newest"),
    limit: Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 250)) : 100,
  };
}

function parseTradeModelScope(modelScope: string) {
  const [symbol = "Unknown", family = "Unknown", regime = "Unknown"] = modelScope
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  return {
    symbol,
    family,
    regime,
  };
}

function tradeHoldDurationMs(trade: AuditClosedTrade) {
  if (trade.entry_timestamp_ms === null) {
    return null;
  }

  const durationMs = trade.timestamp_ms - trade.entry_timestamp_ms;
  return durationMs >= 0 ? durationMs : null;
}

function matchesHoldFilter(trade: AuditClosedTrade, holdFilter: string) {
  const durationMs = tradeHoldDurationMs(trade);

  switch (holdFilter) {
    case "Intraday":
      return durationMs !== null && durationMs < 6 * 60 * 60 * 1000;
    case "Swing":
      return durationMs !== null && durationMs >= 6 * 60 * 60 * 1000 && durationMs < 24 * 60 * 60 * 1000;
    case "MultiDay":
      return durationMs !== null && durationMs >= 24 * 60 * 60 * 1000;
    case "Unknown":
      return durationMs === null;
    default:
      return true;
  }
}

function compareReviewTrades(left: AuditClosedTrade, right: AuditClosedTrade, sortBy: string) {
  switch (sortBy) {
    case "oldest":
      return left.timestamp_ms - right.timestamp_ms;
    case "best-pnl":
      return right.realized_pnl - left.realized_pnl;
    case "worst-pnl":
      return left.realized_pnl - right.realized_pnl;
    case "longest-hold":
      return (tradeHoldDurationMs(right) ?? -1) - (tradeHoldDurationMs(left) ?? -1);
    case "shortest-hold":
      return (tradeHoldDurationMs(left) ?? Number.POSITIVE_INFINITY) - (tradeHoldDurationMs(right) ?? Number.POSITIVE_INFINITY);
    default:
      return right.timestamp_ms - left.timestamp_ms;
  }
}

function summarizeReviewTrades(trades: AuditClosedTrade[]) {
  const closedTrades = trades.length;
  const wins = trades.filter((trade) => trade.realized_pnl > 1e-8).length;
  const losses = trades.filter((trade) => trade.realized_pnl < -1e-8).length;
  const realizedPnlTotal = trades.reduce((total, trade) => total + trade.realized_pnl, 0);
  const grossProfit = trades.filter((trade) => trade.realized_pnl > 1e-8).reduce((total, trade) => total + trade.realized_pnl, 0);
  const grossLossAbs = trades.filter((trade) => trade.realized_pnl < -1e-8).reduce((total, trade) => total + Math.abs(trade.realized_pnl), 0);
  const pnlRatioTotal = trades.reduce((total, trade) => total + trade.pnl_ratio, 0);
  const exactTradeCount = trades.filter((trade) => trade.source === "binance-user-trades").length;

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
    exactCoverageRate: closedTrades > 0 ? exactTradeCount / closedTrades : null,
  };
}

function averageHoldDurationMs(trades: AuditClosedTrade[]) {
  const durations = trades.map(tradeHoldDurationMs).filter((duration): duration is number => duration !== null);
  if (durations.length === 0) {
    return null;
  }

  return durations.reduce((total, duration) => total + duration, 0) / durations.length;
}

function buildFilteredEquityCurve(trades: AuditClosedTrade[]) {
  let cumulativePnl = 0;

  return [...trades]
    .sort((left, right) => left.timestamp_ms - right.timestamp_ms)
    .map((trade, index) => {
      cumulativePnl += trade.realized_pnl;
      return {
        trade_id: trade.id,
        timestamp_ms: trade.timestamp_ms,
        cumulative_pnl: cumulativePnl,
        visible_index: index,
      };
    })
    .slice(-96)
    .map((point, index) => ({
      ...point,
      visible_index: index,
    }));
}

function buildReviewSliceRankings(trades: AuditClosedTrade[]) {
  const grouped = new Map<string, { modelId: string; family: string; regime: string; trades: AuditClosedTrade[] }>();

  for (const trade of trades) {
    const scope = parseTradeModelScope(trade.model_scope);
    const key = `${trade.model_id}__${scope.family}__${scope.regime}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.trades.push(trade);
      continue;
    }

    grouped.set(key, {
      modelId: trade.model_id,
      family: scope.family,
      regime: scope.regime,
      trades: [trade],
    });
  }

  const slices = Array.from(grouped.entries())
    .map(([key, entry]) => {
      const metrics = summarizeReviewTrades(entry.trades);
      return {
        key,
        model_id: entry.modelId,
        family: entry.family,
        regime: entry.regime,
        trade_count: entry.trades.length,
        realized_pnl_total: metrics.realizedPnlTotal,
        expectancy_per_trade: metrics.expectancyPerTrade,
        win_rate: metrics.winRate,
        profit_factor: metrics.profitFactor,
        average_win_pnl: metrics.averageWinPnl,
        average_loss_pnl: metrics.averageLossPnl,
        exact_coverage_rate: metrics.exactCoverageRate,
      };
    })
    .filter((slice) => slice.trade_count >= 1);

  const ranked = [...slices].sort((left, right) => {
    const expectancyDelta = (right.expectancy_per_trade ?? Number.NEGATIVE_INFINITY) - (left.expectancy_per_trade ?? Number.NEGATIVE_INFINITY);
    if (Math.abs(expectancyDelta) > 1e-8) {
      return expectancyDelta;
    }
    return right.realized_pnl_total - left.realized_pnl_total;
  });

  return {
    best: ranked.slice(0, 3),
    worst: [...ranked].reverse().slice(0, 3),
    total: ranked.length,
  };
}

function resolveReviewDateRange(dateRangeFilter: string, customStartDate: string, customEndDate: string) {
  const now = Date.now();

  switch (dateRangeFilter) {
    case "7D":
      return { startMs: now - 7 * 24 * 60 * 60 * 1000, endMs: null };
    case "30D":
      return { startMs: now - 30 * 24 * 60 * 60 * 1000, endMs: null };
    case "90D":
      return { startMs: now - 90 * 24 * 60 * 60 * 1000, endMs: null };
    case "Custom": {
      const startMs = customStartDate ? Date.parse(`${customStartDate}T00:00:00.000Z`) : null;
      const endMs = customEndDate ? Date.parse(`${customEndDate}T23:59:59.999Z`) : null;
      return {
        startMs: Number.isFinite(startMs) ? startMs : null,
        endMs: Number.isFinite(endMs) ? endMs : null,
      };
    }
    default:
      return { startMs: null, endMs: null };
  }
}

function buildReviewTradesCsv(trades: AuditClosedTrade[]) {
  const headers = [
    "id",
    "symbol",
    "side",
    "source",
    "open_time_utc",
    "close_time_utc",
    "hold_duration_ms",
    "entry_price",
    "exit_price",
    "realized_pnl",
    "pnl_ratio",
    "close_reason",
    "model_id",
    "model_scope",
  ];

  const rows = trades.map((trade) => [
    String(trade.id),
    trade.symbol,
    trade.side,
    trade.source,
    trade.entry_timestamp_ms !== null ? new Date(trade.entry_timestamp_ms).toISOString() : "",
    new Date(trade.timestamp_ms).toISOString(),
    String(tradeHoldDurationMs(trade) ?? ""),
    String(trade.entry_price),
    String(trade.exit_price),
    String(trade.realized_pnl),
    String(trade.pnl_ratio),
    trade.close_reason,
    trade.model_id,
    trade.model_scope,
  ]);

  return [headers, ...rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n");
}

function csvEscape(value: string) {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

function buildReviewSliceFileSuffix(filters: ReviewFilters) {
  return [
    filters.symbolFilter,
    filters.modelFilter,
    filters.familyFilter,
    filters.regimeFilter,
    filters.closeReasonFilter,
    filters.sideFilter,
    filters.sourceFilter,
    filters.holdFilter,
    filters.dateRangeFilter,
  ]
    .map((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "all")
    .join("-");
}

function filterTrades(trades: AuditClosedTrade[], filters: ReviewFilters) {
  const reviewDateRange = resolveReviewDateRange(filters.dateRangeFilter, filters.customStartDate, filters.customEndDate);

  return trades.filter((trade) => {
    const scope = parseTradeModelScope(trade.model_scope);
    if (filters.symbolFilter !== "All" && trade.symbol !== filters.symbolFilter) {
      return false;
    }
    if (filters.modelFilter !== "All" && trade.model_id !== filters.modelFilter) {
      return false;
    }
    if (filters.familyFilter !== "All" && scope.family !== filters.familyFilter) {
      return false;
    }
    if (filters.regimeFilter !== "All" && scope.regime !== filters.regimeFilter) {
      return false;
    }
    if (filters.closeReasonFilter !== "All" && trade.close_reason !== filters.closeReasonFilter) {
      return false;
    }
    if (filters.sideFilter !== "All" && trade.side !== filters.sideFilter) {
      return false;
    }
    if (filters.sourceFilter !== "All" && trade.source !== filters.sourceFilter) {
      return false;
    }
    if (!matchesHoldFilter(trade, filters.holdFilter)) {
      return false;
    }
    if (reviewDateRange.startMs !== null && trade.timestamp_ms < reviewDateRange.startMs) {
      return false;
    }
    if (reviewDateRange.endMs !== null && trade.timestamp_ms > reviewDateRange.endMs) {
      return false;
    }
    return true;
  });
}

async function buildReviewDataset(searchParams: URLSearchParams) {
  const filters = normalizeReviewFilters(searchParams);
  const { snapshot, operator } = await getDashboardInitialData(250);
  const allTrades = operator.audit.tradeSummary.tradeHistory;
  const filteredTrades = filterTrades(allTrades, filters);
  const sortedTrades = [...filteredTrades].sort((left, right) => compareReviewTrades(left, right, filters.sortBy));
  const filteredSummary = summarizeReviewTrades(filteredTrades);
  const overallSummary = summarizeReviewTrades(allTrades);

  return {
    meta: {
      query_id: crypto.randomUUID(),
      generated_at: new Date().toISOString(),
      snapshot_updated_at: snapshot.updated_at,
      source_trade_count: allTrades.length,
      filtered_trade_count: filteredTrades.length,
      applied_limit: filters.limit,
    },
    filters,
    allTrades,
    filteredTrades,
    sortedTrades,
    filteredSummary,
    overallSummary,
    rankings: buildReviewSliceRankings(filteredTrades),
    equityCurve: buildFilteredEquityCurve(filteredTrades),
  };
}

export async function getReviewSliceQueryData(searchParams: URLSearchParams) {
  const dataset = await buildReviewDataset(searchParams);

  return {
    meta: dataset.meta,
    filters: dataset.filters,
    summary: dataset.filteredSummary,
    full_book_summary: dataset.overallSummary,
    comparison: {
      pnl_delta: dataset.filteredSummary.realizedPnlTotal - dataset.overallSummary.realizedPnlTotal,
      expectancy_delta: (dataset.filteredSummary.expectancyPerTrade ?? 0) - (dataset.overallSummary.expectancyPerTrade ?? 0),
      win_rate_delta: (dataset.filteredSummary.winRate ?? 0) - (dataset.overallSummary.winRate ?? 0),
      average_hold_duration_ms: averageHoldDurationMs(dataset.filteredTrades),
      full_book_average_hold_duration_ms: averageHoldDurationMs(dataset.allTrades),
    },
    equity_curve: dataset.equityCurve,
    trades: dataset.sortedTrades.slice(0, dataset.filters.limit).map((trade) => ({
      ...trade,
      hold_duration_ms: tradeHoldDurationMs(trade),
      model_scope_parts: parseTradeModelScope(trade.model_scope),
    })),
  };
}

export async function getReviewRankedSlicesData(searchParams: URLSearchParams) {
  const dataset = await buildReviewDataset(searchParams);

  return {
    meta: dataset.meta,
    filters: dataset.filters,
    summary: dataset.filteredSummary,
    ranked_slices: dataset.rankings,
  };
}

export async function getReviewTradeInspectData(tradeId: number) {
  const { snapshot, operator } = await getDashboardInitialData(250);
  const trades = [...operator.audit.tradeSummary.tradeHistory].sort((left, right) => left.timestamp_ms - right.timestamp_ms);
  const tradeIndex = trades.findIndex((trade) => trade.id === tradeId);
  const trade = tradeIndex >= 0 ? trades[tradeIndex] : null;

  if (!trade) {
    return null;
  }

  const scope = parseTradeModelScope(trade.model_scope);

  return {
    meta: {
      query_id: crypto.randomUUID(),
      generated_at: new Date().toISOString(),
      snapshot_updated_at: snapshot.updated_at,
    },
    trade: {
      ...trade,
      hold_duration_ms: tradeHoldDurationMs(trade),
      model_scope_parts: scope,
    },
    context: {
      previous_trade_id: tradeIndex > 0 ? trades[tradeIndex - 1]?.id ?? null : null,
      next_trade_id: tradeIndex < trades.length - 1 ? trades[tradeIndex + 1]?.id ?? null : null,
      symbol_trade_count: trades.filter((candidate) => candidate.symbol === trade.symbol).length,
      model_trade_count: trades.filter((candidate) => candidate.model_id === trade.model_id).length,
    },
  };
}

export async function exportReviewSliceData(searchParams: URLSearchParams) {
  const dataset = await buildReviewDataset(searchParams);
  const suffix = buildReviewSliceFileSuffix(dataset.filters);
  const fileName = `review-slice-${suffix}-${Date.now()}.csv`;
  const directory = exportsDir();
  const filePath = path.join(directory, fileName);

  await mkdir(directory, { recursive: true });
  await writeFile(filePath, buildReviewTradesCsv(dataset.sortedTrades), "utf8");

  return {
    meta: dataset.meta,
    filters: dataset.filters,
    export: {
      file_name: fileName,
      file_path: filePath,
      row_count: dataset.sortedTrades.length,
    },
  };
}

export function applyReviewSlice(sliceKey: string) {
  const [modelId = "All", family = "All", regime = "All"] = sliceKey.split("__");

  return {
    slice_key: sliceKey,
    filters: {
      modelFilter: modelId,
      familyFilter: family,
      regimeFilter: regime,
      symbolFilter: "All",
      closeReasonFilter: "All",
      sideFilter: "All",
      sourceFilter: "All",
      holdFilter: "All",
      dateRangeFilter: "All",
      customStartDate: "",
      customEndDate: "",
      sortBy: "newest",
    },
  };
}