import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { buildBotHealthReport } from "@/lib/dashboard-server";
import {
  compactAuditDatabase,
  deleteLegacyExecutionIncidents,
  type AuditTradeSummary,
  readAuditSummary,
  readLegacyExecutionIncidents,
} from "@/lib/audit-store";
import {
  appendOperatorEvent,
  clearMaintenanceOperatorEvents,
  readOperatorEventsPage,
  readPendingModeRequest,
  writePendingModeRequest,
  type OperatorMode,
} from "@/lib/operator-control";
import { getRuntimeSnapshot } from "@/lib/runtime-snapshot";
import { readTradingAutomationSettings, readTradingSettings } from "@/lib/trading-settings";

export const dynamic = "force-dynamic";

type OperatorAction =
  | "bootstrap-runtime"
  | "status"
  | "overlay-compare"
  | "prune-indicators"
  | "delete-indicator"
  | "blacklist-indicator"
  | "unblacklist-indicator"
  | "restart-supervisor"
  | "stop-supervisor"
  | "export-audit"
  | "compact-audit-db"
  | "clear-maintenance-history"
  | "prune-legacy-incidents"
  | "set-mode";

const DEFAULT_EVENT_LIMIT = 60;
const MIN_EVENT_LIMIT = 5;
const MAX_EVENT_LIMIT = 240;
const MODE_CONFIRMATION_TIMEOUT_MS = Number(process.env.STHYRA_MODE_CONFIRMATION_TIMEOUT_MS ?? "30000");
const MODE_CONFIRMATION_POLL_MS = Number(process.env.STHYRA_MODE_CONFIRMATION_POLL_MS ?? "500");

function workspaceRoot() {
  return path.resolve(process.cwd(), "..", "..");
}

function stackScriptPath() {
  if (process.platform === "win32") {
    return path.join(workspaceRoot(), "scripts", "stack.ps1");
  }
  return path.join(workspaceRoot(), "scripts", "stack.sh");
}

function auditDatabasePath() {
  return path.join(workspaceRoot(), ".sthyra", "audit.sqlite3");
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

function sanitizeEventLimit(rawValue: string | null | undefined): number {
  const parsed = Number(rawValue);

  if (!Number.isFinite(parsed)) {
    return DEFAULT_EVENT_LIMIT;
  }

  return Math.min(MAX_EVENT_LIMIT, Math.max(MIN_EVENT_LIMIT, Math.floor(parsed)));
}

function sanitizeTimeout(rawValue: number, fallback: number, minimum: number) {
  return Number.isFinite(rawValue) ? Math.max(minimum, Math.floor(rawValue)) : fallback;
}

async function operatorPayload(
  message?: string,
  extra?: Record<string, unknown>,
  eventLimit = DEFAULT_EVENT_LIMIT,
  beforeEventId?: string | null,
) {
  const [snapshot, tradingSettings, eventPage, pendingModeRequest, audit, overlayCompare] = await Promise.all([
    getRuntimeSnapshot(),
    readTradingSettings(),
    readOperatorEventsPage(eventLimit, beforeEventId),
    readPendingModeRequest(),
    readAuditSummary().catch(() => ({
      incidents: [],
      orderIntents: [],
      executionEvents: [],
      openPositionEntries: [],
      balanceSummary: {
        latestTotalWalletBalance: null,
        latestSnapshotAt: null,
        latestDayDelta: null,
        calendar: [],
      },
      tradeSummary: {
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
      },
      retention: {
        orderIntents: { currentCount: 0, limit: 500, maxAgeMs: 7 * 24 * 60 * 60 * 1000 },
        executionEvents: { currentCount: 0, limit: 1000, maxAgeMs: 30 * 24 * 60 * 60 * 1000 },
      },
    })),
    readOverlayCompareReport(),
  ]);
  const botHealth = await buildBotHealthReport({
    snapshot,
    pendingModeRequest,
    audit,
    tradingSettings,
  });
  return {
    message,
    events: eventPage.events,
    pageInfo: {
      eventLimit,
      hasMore: eventPage.hasMore,
      nextBeforeEventId: eventPage.nextBeforeEventId,
    },
    pendingModeRequest,
    audit,
    overlayCompare,
    overlayEffect: buildOverlayEffectReport(overlayCompare, audit.tradeSummary),
    botHealth,
    ...extra,
  };
}

function buildOverlayEffectReport(
  overlayCompare: Awaited<ReturnType<typeof readOverlayCompareReport>>,
  tradeSummary: AuditTradeSummary,
) {
  if (!overlayCompare) {
    return null;
  }

  const candidates = overlayCompare.changes.map((change) => {
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

    let qualityTrend: "improving" | "weakening" | "flat" | "insufficient-data" = "insufficient-data";
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

  return {
    changed_candidates: overlayCompare.changed_candidates,
    affected_models: new Set(candidates.map((candidate) => candidate.selected_model_id).filter(Boolean)).size,
    improving_candidates: candidates.filter((candidate) => candidate.quality_trend === "improving").length,
    weakening_candidates: candidates.filter((candidate) => candidate.quality_trend === "weakening").length,
    flat_candidates: candidates.filter((candidate) => candidate.quality_trend === "flat").length,
    insufficient_candidates: candidates.filter((candidate) => candidate.quality_trend === "insufficient-data").length,
    candidates,
  };
}

function runStackCommand(args: string[], timeoutMs = 20_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32";
    const [cmd, cmdArgs] = isWindows
      ? ["powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", stackScriptPath(), ...args]]
      : ["zsh", [stackScriptPath(), ...args]];

    const child = spawn(cmd, cmdArgs, {
      cwd: workspaceRoot(),
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    const timeoutId = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timed out running stack command: ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeoutId);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function ensureSupervisorRunning() {
  const result = await runStackCommand(["start-supervisor"], 120_000);

  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "Failed to start supervisor.");
  }

  return result;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSnapshotMode(targetMode: OperatorMode, baselineUpdatedAt?: string | null) {
  const startedAt = Date.now();
  const confirmationTimeoutMs = sanitizeTimeout(MODE_CONFIRMATION_TIMEOUT_MS, 30_000, 1_000);
  const confirmationPollMs = sanitizeTimeout(MODE_CONFIRMATION_POLL_MS, 500, 100);

  while (Date.now() - startedAt < confirmationTimeoutMs) {
    const snapshot = await getRuntimeSnapshot();
    const updatedChanged = !baselineUpdatedAt || snapshot.updated_at !== baselineUpdatedAt;

    if (snapshot.mode === targetMode && updatedChanged) {
      return {
        confirmed: true,
        snapshot,
      };
    }

    await sleep(confirmationPollMs);
  }

  return {
    confirmed: false,
    snapshot: await getRuntimeSnapshot(),
  };
}

async function exportAuditTrail() {
  const snapshot = await getRuntimeSnapshot();
  const exportDir = path.join(workspaceRoot(), ".sthyra", "exports");
  const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
  const exportPath = path.join(exportDir, `audit-${timestamp}.json`);
  const payload = {
    generated_at: new Date().toISOString(),
    snapshot,
  };

  await mkdir(exportDir, { recursive: true });
  await writeFile(exportPath, JSON.stringify(payload, null, 2), "utf8");

  return exportPath;
}

async function archiveLegacyIncidents() {
  const incidents = await readLegacyExecutionIncidents();

  if (incidents.length === 0) {
    return { archivePath: null, prunedCount: 0 };
  }

  const exportDir = path.join(workspaceRoot(), ".sthyra", "exports");
  const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
  const archivePath = path.join(exportDir, `legacy-incidents-${timestamp}.json`);

  await mkdir(exportDir, { recursive: true });
  await writeFile(
    archivePath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
          reason: "Archived legacy incident-feed entries before normalizing the system anomaly feed.",
        incidents,
      },
      null,
      2,
    ),
    "utf8",
  );

  const prunedCount = await deleteLegacyExecutionIncidents();
  return { archivePath, prunedCount };
}

async function compactAuditStore() {
  const databasePath = auditDatabasePath();
  const beforeBytes = await stat(databasePath).then((result) => result.size).catch(() => 0);
  await compactAuditDatabase();
  const afterBytes = await stat(databasePath).then((result) => result.size).catch(() => beforeBytes);

  return {
    beforeBytes,
    afterBytes,
    databasePath,
  };
}

async function readOverlayCompareReport() {
  try {
    const raw = await readFile(overlayCompareReportPath(), "utf8");
    return JSON.parse(raw) as {
      report_path: string;
      day_key: string;
      promoted_indicator: string | null;
      scenarios_evaluated: number;
      approvals_without_overlay: number;
      approvals_with_overlay: number;
      changed_candidates: number;
      changes: Array<{
        scenario: string;
        symbol: string;
        family: string;
        selected_model_id: string | null;
        selected_indicator_id: string | null;
        without_overlay: {
          decision: string;
          confidence_score: number;
          expected_value_score: number;
        };
        with_overlay: {
          decision: string;
          confidence_score: number;
          expected_value_score: number;
        };
        delta: {
          confidence_score: number;
          expected_value_score: number;
        };
      }>;
    };
  } catch {
    return null;
  }
}

async function writeOverlayCompareReport(report: unknown) {
  const reportPath = overlayCompareReportPath();
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
}

async function readIndicatorBlacklist() {
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

async function writeIndicatorBlacklist(ids: string[]) {
  const filePath = indicatorBlacklistPath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(Array.from(new Set(ids)).sort(), null, 2), "utf8");
}

type StoredResearchReport = {
  day_key: string;
  promoted_indicator?: {
    genome?: { id?: string };
    fitness_score?: number;
  } | null;
  indicator_leaderboard?: Array<{
    genome?: { id?: string };
    fitness_score?: number;
  }>;
};

async function pruneResearchRegistry(options: { minFitness: number; retentionLimit: number }) {
  const registryPath = modelRegistryPath();
  const blacklistedIds = new Set(await readIndicatorBlacklist());

  try {
    const raw = await readFile(registryPath, "utf8");
    const report = JSON.parse(raw) as StoredResearchReport;
    const originalLeaderboard = Array.isArray(report.indicator_leaderboard) ? report.indicator_leaderboard : [];
    const retainedLeaderboard = originalLeaderboard
      .filter((entry) => {
        if (typeof entry?.fitness_score !== "number") {
          return false;
        }

        const id = entry?.genome?.id;
        return entry.fitness_score >= options.minFitness && !(typeof id === "string" && blacklistedIds.has(id));
      })
      .slice(0, options.retentionLimit);
    const retainedIds = new Set(
      retainedLeaderboard
        .map((entry) => entry?.genome?.id)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    );
    const previousPromotedId = report.promoted_indicator?.genome?.id ?? null;
    const previousPromotedFitness = report.promoted_indicator?.fitness_score;
    const promotedAllowed =
      typeof previousPromotedId === "string"
      && typeof previousPromotedFitness === "number"
      && previousPromotedFitness >= options.minFitness
      && !blacklistedIds.has(previousPromotedId)
      && retainedIds.has(previousPromotedId);
    const nextPromoted = promotedAllowed ? report.promoted_indicator ?? null : retainedLeaderboard[0] ?? null;
    const removedIds = originalLeaderboard
      .map((entry) => entry?.genome?.id)
      .filter((value): value is string => typeof value === "string" && value.length > 0 && !retainedIds.has(value));
    const changed =
      removedIds.length > 0
      || retainedLeaderboard.length !== originalLeaderboard.length
      || (nextPromoted?.genome?.id ?? null) !== previousPromotedId;

    if (changed) {
      await writeFile(
        registryPath,
        JSON.stringify(
          {
            ...report,
            promoted_indicator: nextPromoted,
            indicator_leaderboard: retainedLeaderboard,
          },
          null,
          2,
        ),
        "utf8",
      );
    }

    return {
      changed,
      registryPath,
      removedIds,
      removedCount: removedIds.length,
      remainingCount: retainedLeaderboard.length,
      promotedIndicator: nextPromoted?.genome?.id ?? null,
    };
  } catch {
    return {
      changed: false,
      registryPath,
      removedIds: [],
      removedCount: 0,
      remainingCount: 0,
      promotedIndicator: null,
    };
  }
}

async function updateIndicatorRegistry(indicatorId: string) {
  const registryPath = modelRegistryPath();

  try {
    const raw = await readFile(registryPath, "utf8");
    const report = JSON.parse(raw) as StoredResearchReport & { promoted_indicator?: StoredResearchReport["promoted_indicator"] | null };
    const originalLeaderboard = Array.isArray(report.indicator_leaderboard) ? report.indicator_leaderboard : [];
    const nextLeaderboard = originalLeaderboard.filter((entry) => entry?.genome?.id !== indicatorId);
    const removed = nextLeaderboard.length !== originalLeaderboard.length || report.promoted_indicator?.genome?.id === indicatorId;

    if (!removed) {
      return {
        registryPath,
        removed: false,
        remainingCount: nextLeaderboard.length,
        promotedIndicator: report.promoted_indicator?.genome?.id ?? null,
      };
    }

    const nextPromoted = report.promoted_indicator?.genome?.id === indicatorId
      ? nextLeaderboard[0] ?? null
      : report.promoted_indicator ?? null;

    await writeFile(
      registryPath,
      JSON.stringify(
        {
          ...report,
          promoted_indicator: nextPromoted,
          indicator_leaderboard: nextLeaderboard,
        },
        null,
        2,
      ),
      "utf8",
    );

    return {
      registryPath,
      removed: true,
      remainingCount: nextLeaderboard.length,
      promotedIndicator: nextPromoted?.genome?.id ?? null,
    };
  } catch {
    return {
      registryPath,
      removed: false,
      remainingCount: 0,
      promotedIndicator: null,
    };
  }
}

async function runOverlayCompareAction() {
  const result = await runStackCommand(["overlay-compare", "--json"], 120_000);
  const ok = result.code === 0;

  if (!ok) {
    throw new Error(result.stderr || result.stdout || "Overlay comparator failed.");
  }

  const overlayCompare = JSON.parse(result.stdout) as Awaited<ReturnType<typeof readOverlayCompareReport>>;
  await writeOverlayCompareReport(overlayCompare);

  await appendOperatorEvent({
    action: "overlay-compare",
    level: overlayCompare && overlayCompare.changed_candidates > 0 ? "warn" : "info",
    message: overlayCompare
      ? `Overlay comparator completed with ${overlayCompare.changed_candidates} changed candidate${overlayCompare.changed_candidates === 1 ? "" : "s"}.`
      : "Overlay comparator completed.",
    detail: overlayCompare
      ? [
          `promoted_indicator=${overlayCompare.promoted_indicator ?? "none"}`,
          `changed_candidates=${overlayCompare.changed_candidates}`,
          `approvals_without=${overlayCompare.approvals_without_overlay}`,
          `approvals_with=${overlayCompare.approvals_with_overlay}`,
        ].join("\n")
      : undefined,
  });

  return overlayCompare;
}

export async function GET(request: NextRequest) {
  const eventLimit = sanitizeEventLimit(request.nextUrl.searchParams.get("eventLimit"));
  const beforeEventId = request.nextUrl.searchParams.get("beforeEventId");
  return NextResponse.json(await operatorPayload(undefined, undefined, eventLimit, beforeEventId));
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { action?: OperatorAction; targetMode?: OperatorMode; indicatorId?: string } | null;
  const action = body?.action;
  const targetMode = body?.targetMode;
  const indicatorId = body?.indicatorId?.trim();

  if (!action) {
    return NextResponse.json({ message: "Missing operator action." }, { status: 400 });
  }

  try {
    switch (action) {
      case "bootstrap-runtime": {
        const automation = await readTradingAutomationSettings();
        const pruneResult = await pruneResearchRegistry({
          minFitness: automation.indicatorPruneMinFitness,
          retentionLimit: automation.indicatorRetentionLimit,
        });
        const startupResult = automation.autoStartRuntimeOnOpen ? await ensureSupervisorRunning() : null;
        const overlayCompare = automation.autoRunOverlayCompareOnOpen ? await runOverlayCompareAction() : await readOverlayCompareReport();
        const message = [
          automation.autoStartRuntimeOnOpen
            ? `runtime auto-start ${startupResult ? "completed" : "skipped"}`
            : "runtime auto-start disabled",
          automation.autoRunOverlayCompareOnOpen
            ? `overlay compare refreshed${overlayCompare ? ` with ${overlayCompare.changed_candidates} changed candidate${overlayCompare.changed_candidates === 1 ? "" : "s"}` : ""}`
            : "overlay compare auto-run disabled",
          pruneResult.removedCount > 0
            ? `pruned ${pruneResult.removedCount} weak indicator genome${pruneResult.removedCount === 1 ? "" : "s"}`
            : "indicator registry already clean",
        ].join("; ");

        await appendOperatorEvent({
          action,
          level: pruneResult.removedCount > 0 ? "warn" : "info",
          message: `Runtime bootstrap completed: ${message}.`,
          detail: [
            `cycle_interval_ms=${automation.supervisorIntervalMs}`,
            `research_refresh_minutes=${automation.researchRefreshIntervalMinutes}`,
            `indicator_min_fitness=${automation.indicatorPruneMinFitness}`,
            `indicator_retention_limit=${automation.indicatorRetentionLimit}`,
          ].join("\n"),
        });

        return NextResponse.json(
          await operatorPayload(`Runtime bootstrap completed: ${message}.`, {
            ok: true,
            pruneResult,
            overlayCompare,
          }),
        );
      }
      case "status": {
        const [statusResult, healthResult] = await Promise.all([
          runStackCommand(["status"]),
          runStackCommand(["health"]),
        ]);
        const message = [statusResult.stdout, healthResult.stdout].filter(Boolean).join("\n\n");
        const ok = statusResult.code === 0 && healthResult.code === 0;

        await appendOperatorEvent({
          action,
          level: ok ? "info" : "warn",
          message: ok ? "Stack health check completed." : "Stack health check reported degradation.",
          detail: message,
        });

        return NextResponse.json(await operatorPayload(message || "Stack status checked.", { ok }), {
          status: ok ? 200 : 503,
        });
      }
      case "overlay-compare": {
        const overlayCompare = await runOverlayCompareAction();

        return NextResponse.json(
          await operatorPayload(
            overlayCompare
              ? `Overlay comparator completed. ${overlayCompare.changed_candidates} candidate${overlayCompare.changed_candidates === 1 ? "" : "s"} changed under promoted-indicator influence.`
              : "Overlay comparator completed.",
            { ok: true, overlayCompare },
          ),
        );
      }
      case "prune-indicators": {
        const automation = await readTradingAutomationSettings();
        const pruneResult = await pruneResearchRegistry({
          minFitness: automation.indicatorPruneMinFitness,
          retentionLimit: automation.indicatorRetentionLimit,
        });

        await appendOperatorEvent({
          action,
          level: pruneResult.removedCount > 0 ? "warn" : "info",
          message:
            pruneResult.removedCount > 0
              ? `Pruned ${pruneResult.removedCount} weak indicator genome${pruneResult.removedCount === 1 ? "" : "s"}.`
              : "Indicator registry already satisfies the current pruning policy.",
          detail: [
            `path=${pruneResult.registryPath}`,
            `remaining=${pruneResult.remainingCount}`,
            `promoted_indicator=${pruneResult.promotedIndicator ?? "none"}`,
          ].join("\n"),
        });

        return NextResponse.json(
          await operatorPayload(
            pruneResult.removedCount > 0
              ? `Pruned ${pruneResult.removedCount} weak indicator genome${pruneResult.removedCount === 1 ? "" : "s"}. Runtime will adopt the cleaned leaderboard on the next refresh cycle.`
              : "Indicator registry already satisfies the current pruning policy.",
            { ok: true, pruneResult },
          ),
        );
      }
      case "delete-indicator": {
        if (!indicatorId) {
          return NextResponse.json({ message: "Missing indicator id." }, { status: 400 });
        }

        const result = await updateIndicatorRegistry(indicatorId);

        await appendOperatorEvent({
          action,
          level: result.removed ? "warn" : "info",
          message: result.removed ? `Deleted indicator genome ${indicatorId} from the active registry.` : `Indicator genome ${indicatorId} was not present in the active registry.`,
          detail: [`path=${result.registryPath}`, `remaining=${result.remainingCount}`, `promoted_indicator=${result.promotedIndicator ?? "none"}`].join("\n"),
        });

        return NextResponse.json(
          await operatorPayload(
            result.removed ? `Deleted indicator genome ${indicatorId} from the active registry.` : `Indicator genome ${indicatorId} was not present in the active registry.`,
            { ok: true, indicatorResult: result },
          ),
        );
      }
      case "blacklist-indicator": {
        if (!indicatorId) {
          return NextResponse.json({ message: "Missing indicator id." }, { status: 400 });
        }

        const blacklist = await readIndicatorBlacklist();
        if (!blacklist.includes(indicatorId)) {
          blacklist.push(indicatorId);
          await writeIndicatorBlacklist(blacklist);
        }
        const result = await updateIndicatorRegistry(indicatorId);

        await appendOperatorEvent({
          action,
          level: "warn",
          message: `Blacklisted indicator genome ${indicatorId}.`,
          detail: [`remaining=${result.remainingCount}`, `promoted_indicator=${result.promotedIndicator ?? "none"}`].join("\n"),
        });

        return NextResponse.json(
          await operatorPayload(`Blacklisted indicator genome ${indicatorId}.`, { ok: true, indicatorResult: result }),
        );
      }
      case "unblacklist-indicator": {
        if (!indicatorId) {
          return NextResponse.json({ message: "Missing indicator id." }, { status: 400 });
        }

        const blacklist = await readIndicatorBlacklist();
        const nextBlacklist = blacklist.filter((id) => id !== indicatorId);
        if (nextBlacklist.length !== blacklist.length) {
          await writeIndicatorBlacklist(nextBlacklist);
        }

        await appendOperatorEvent({
          action,
          level: "info",
          message: `Removed indicator genome ${indicatorId} from the blacklist.`,
        });

        return NextResponse.json(
          await operatorPayload(`Removed indicator genome ${indicatorId} from the blacklist.`, { ok: true, indicatorId }),
        );
      }
      case "restart-supervisor": {
        const result = await runStackCommand(["restart-supervisor"]);
        const ok = result.code === 0;

        await appendOperatorEvent({
          action,
          level: ok ? "warn" : "risk",
          message: ok ? "Supervisor restarted." : "Supervisor restart failed.",
          detail: result.stdout || result.stderr,
        });

        return NextResponse.json(await operatorPayload(result.stdout || "Supervisor restarted.", { ok }), {
          status: ok ? 200 : 500,
        });
      }
      case "stop-supervisor": {
        const result = await runStackCommand(["stop-supervisor"]);
        const ok = result.code === 0;

        await appendOperatorEvent({
          action,
          level: "risk",
          message: ok ? "Emergency stop executed. Supervisor stopped." : "Emergency stop failed.",
          detail: result.stdout || result.stderr,
        });

        return NextResponse.json(await operatorPayload(result.stdout || "Supervisor stopped.", { ok }), {
          status: ok ? 200 : 500,
        });
      }
      case "export-audit": {
        const exportPath = await exportAuditTrail();

        await appendOperatorEvent({
          action,
          level: "info",
          message: "Audit export completed.",
          detail: exportPath,
        });

        return NextResponse.json(
          await operatorPayload(`Audit export written to ${exportPath}`, { ok: true, exportPath }),
        );
      }
      case "compact-audit-db": {
        const result = await compactAuditStore();

        await appendOperatorEvent({
          action,
          level: "info",
          message: "Audit database compaction completed.",
          detail: `${result.databasePath}\n${result.beforeBytes} bytes -> ${result.afterBytes} bytes`,
        });

        return NextResponse.json(
          await operatorPayload(
            `Compacted audit database at ${result.databasePath}. ${result.beforeBytes} bytes -> ${result.afterBytes} bytes.`,
            { ok: true, ...result },
          ),
        );
      }
      case "clear-maintenance-history": {
        const removedCount = await clearMaintenanceOperatorEvents();

        return NextResponse.json(
          await operatorPayload(
            removedCount > 0
              ? `Cleared ${removedCount} maintenance history entr${removedCount === 1 ? "y" : "ies"}.`
              : "No maintenance history entries were present.",
            { ok: true, removedCount },
          ),
        );
      }
      case "prune-legacy-incidents": {
        const { archivePath, prunedCount } = await archiveLegacyIncidents();

        await appendOperatorEvent({
          action,
          level: prunedCount > 0 ? "warn" : "info",
          message:
            prunedCount > 0
              ? `Archived and pruned ${prunedCount} legacy incident-feed entries.`
              : "No legacy incident-feed entries were found.",
          detail: archivePath ?? undefined,
        });

        return NextResponse.json(
          await operatorPayload(
            prunedCount > 0
              ? `Archived ${prunedCount} legacy incident-feed entries to ${archivePath} and removed them from the incident feed.`
              : "No legacy incident-feed entries were found.",
            { ok: true, archivePath, prunedCount },
          ),
        );
      }
      case "set-mode": {
        if (!targetMode) {
          return NextResponse.json({ message: "Missing target mode." }, { status: 400 });
        }

        const baselineSnapshot = await getRuntimeSnapshot();

        if (baselineSnapshot.mode === targetMode) {
          await appendOperatorEvent({
            action,
            level: targetMode === "SemiAuto" ? "warn" : "info",
            message: `Operator mode already confirmed as ${targetMode}.`,
          });

          return NextResponse.json(
            await operatorPayload(`Runtime snapshot already confirms ${targetMode}.`, {
              ok: true,
              targetMode,
              confirmed: true,
              snapshotMode: baselineSnapshot.mode,
              snapshotUpdatedAt: baselineSnapshot.updated_at,
            }),
          );
        }

        const supervisorStart = await ensureSupervisorRunning();
        await writePendingModeRequest(targetMode);
        const confirmation = await waitForSnapshotMode(targetMode, baselineSnapshot.updated_at);

        await appendOperatorEvent({
          action,
          level: confirmation.confirmed
            ? targetMode === "SemiAuto"
              ? "warn"
              : "info"
            : "warn",
          message: confirmation.confirmed
            ? `Operator mode transition confirmed as ${targetMode}.`
            : `Operator mode transition to ${targetMode} is still pending confirmation.`,
          detail: [supervisorStart.stdout, `snapshot_mode=${confirmation.snapshot.mode}`, `snapshot_updated_at=${confirmation.snapshot.updated_at}`]
            .filter(Boolean)
            .join("\n"),
        });

        return NextResponse.json(
          await operatorPayload(
            confirmation.confirmed
              ? `Supervisor ready. Runtime snapshot confirms ${targetMode}.`
              : `Supervisor ready, but runtime snapshot has not yet confirmed ${targetMode}.`,
            {
              ok: confirmation.confirmed,
              targetMode,
              confirmed: confirmation.confirmed,
              supervisorStatus: supervisorStart.stdout || null,
              snapshotMode: confirmation.snapshot.mode,
              snapshotUpdatedAt: confirmation.snapshot.updated_at,
            },
          ),
          {
            status: confirmation.confirmed ? 200 : 202,
          },
        );
      }
      default:
        return NextResponse.json({ message: "Unsupported operator action." }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Operator command failed.";

    await appendOperatorEvent({
      action,
      level: "risk",
      message: "Operator action failed.",
      detail: message,
    });

    return NextResponse.json(await operatorPayload(message, { ok: false }), { status: 500 });
  }
}
