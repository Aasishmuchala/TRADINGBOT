"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  Activity,
  BrainCircuit,
  CandlestickChart,
  Check,
  Download,
  Eraser,
  Gauge,
  Monitor,
  Moon,
  OctagonX,
  Radar,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sun,
  TerminalSquare,
  Trash2,
  Waves,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AuditBalanceCalendarDay, AuditClosedTrade } from "@/lib/audit-store";
import {
  EMPTY_OPERATOR_DATA,
  type BotHealthReport,
  type DashboardInitialData,
  type DashboardOperatorData,
  type DashboardPage,
  type OperatorAction,
} from "@/lib/dashboard-state";
import type { OperatorMode } from "@/lib/operator-control";
import type { RuntimeCandlePoint, RuntimeIndicatorPoint, RuntimePosition, RuntimeSnapshot } from "@/lib/runtime-snapshot";
import { cn } from "@/lib/utils";

type NavItem = {
  page: DashboardPage;
  href: string;
  label: string;
  description: string;
  icon: typeof Activity;
};

type TradingSettingsState = {
  binanceEnvironment: "testnet" | "mainnet";
  transportEnabled: boolean;
  streamEnabled: boolean;
  tradingEnabled: boolean;
  autoStartRuntimeOnOpen: boolean;
  autoRunOverlayCompareOnOpen: boolean;
  supervisorIntervalMs: number;
  researchRefreshIntervalMinutes: number;
  indicatorPruneMinFitness: number;
  indicatorRetentionLimit: number;
  hasApiKey: boolean;
  hasApiSecret: boolean;
  credentialsReady: boolean;
  credentialsValidated: boolean | null;
  credentialsValidationMessage: string | null;
  detectedCredentialEnvironment: "testnet" | "mainnet" | null;
  paperTradingConfigured: boolean;
  paperTradingReady: boolean;
  keychainAvailable: boolean;
  credentialBackend: "keychain" | "wincred" | "env" | "none";
};

type ModelPackSignalEntry = {
  model?: {
    id?: string;
    generation?: number;
    target_symbol?: string | null;
    target_regime?: string | null;
    target_family?: string | null;
    approval_threshold?: number;
  };
  fitness_score?: number;
  profitability_score?: number;
  robustness_score?: number;
  risk_adjusted_return?: number;
};

type ModelPackIndicatorEntry = {
  genome?: {
    id?: string;
    generation?: number;
    target_symbol?: string | null;
    target_regime?: string | null;
    target_family?: string | null;
    approval_threshold?: number;
  };
  fitness_score?: number;
  profitability_score?: number;
  robustness_score?: number;
  latency_score?: number;
  blacklisted?: boolean;
};

type ModelPacksState = {
  active: {
    promoted_model: ModelPackSignalEntry | null;
    promoted_indicator_pack: ModelPackIndicatorEntry | null;
  };
  signal_leaderboard: ModelPackSignalEntry[];
  indicator_leaderboard: ModelPackIndicatorEntry[];
  blacklisted_indicator_ids: string[];
  policy: {
    autoStartRuntimeOnOpen: boolean;
    autoRunOverlayCompareOnOpen: boolean;
    supervisorIntervalMs: number;
    researchRefreshIntervalMinutes: number;
    indicatorPruneMinFitness: number;
    indicatorRetentionLimit: number;
  } | null;
};

type ThemePreference = "system" | "light" | "dark";

const EMPTY_TRADING_SETTINGS: TradingSettingsState = {
  binanceEnvironment: "testnet",
  transportEnabled: false,
  streamEnabled: false,
  tradingEnabled: false,
  autoStartRuntimeOnOpen: true,
  autoRunOverlayCompareOnOpen: true,
  supervisorIntervalMs: 500,
  researchRefreshIntervalMinutes: 30,
  indicatorPruneMinFitness: 0.05,
  indicatorRetentionLimit: 6,
  hasApiKey: false,
  hasApiSecret: false,
  credentialsReady: false,
  credentialsValidated: null,
  credentialsValidationMessage: null,
  detectedCredentialEnvironment: null,
  paperTradingConfigured: false,
  paperTradingReady: false,
  keychainAvailable: false,
  credentialBackend: "none",
};

const EMPTY_MODEL_PACKS: ModelPacksState = {
  active: {
    promoted_model: null,
    promoted_indicator_pack: null,
  },
  signal_leaderboard: [],
  indicator_leaderboard: [],
  blacklisted_indicator_ids: [],
  policy: null,
};

const THEME_STORAGE_KEY = "sthyra-theme-preference";
const RUNTIME_BOOTSTRAP_SESSION_KEY = "sthyra-runtime-bootstrap-v1";

function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean) {
  return preference === "system" ? (systemPrefersDark ? "dark" : "light") : preference;
}

const navItems: NavItem[] = [
  { page: "overview", href: "/", label: "Overview", description: "P&L, live exposure, critical mistakes", icon: Activity },
  { page: "positions", href: "/positions", label: "Positions", description: "Open exposure, balances, daily close", icon: Waves },
  { page: "markets", href: "/markets", label: "Markets", description: "TradingView-style market and indicator panes", icon: CandlestickChart },
  { page: "risk", href: "/risk", label: "Risk", description: "Regime pressure, incidents, overlay impact", icon: ShieldCheck },
  { page: "execution", href: "/execution", label: "Execution", description: "Operator controls and system events", icon: TerminalSquare },
  { page: "review", href: "/review", label: "Review", description: "Closed trades, equity curve, mistakes", icon: BrainCircuit },
  { page: "settings", href: "/settings", label: "Settings", description: "Mode, venue, shell status", icon: Gauge },
];

export function DashboardApp({ initialData, page }: { initialData: DashboardInitialData; page: DashboardPage }) {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(initialData.snapshot);
  const [operator, setOperator] = useState<DashboardOperatorData>(initialData.operator);
  const [refreshState, setRefreshState] = useState(`Live runtime · cycle ${initialData.snapshot.cycle}`);
  const [operatorState, setOperatorState] = useState("Operator controls ready.");
  const [pendingOperatorAction, setPendingOperatorAction] = useState<OperatorAction | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [stopArmed, setStopArmed] = useState(false);
  const [themePreference, setThemePreference] = useState<ThemePreference>("system");
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    try {
      const storedPreference = window.localStorage.getItem(THEME_STORAGE_KEY)?.trim();
      if (storedPreference === "system" || storedPreference === "light" || storedPreference === "dark") {
        setThemePreference(storedPreference);
      }
    } catch {
      // Ignore storage access failures in constrained webviews.
    }
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      const root = document.documentElement;
      const nextTheme = themePreference === "dark" ? "dark" : "light";

      root.dataset.theme = nextTheme;
      root.style.colorScheme = nextTheme;
      root.classList.toggle("dark", nextTheme === "dark");
      setResolvedTheme(nextTheme);
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    const applyTheme = () => {
      const nextTheme = resolveTheme(themePreference, mediaQuery.matches);
      const root = document.documentElement;

      root.dataset.theme = nextTheme;
      root.style.colorScheme = nextTheme;
      root.classList.remove("dark");
      if (nextTheme === "dark") {
        root.classList.add("dark");
      }
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
      } catch {
        // Ignore storage access failures in constrained webviews.
      }
      setResolvedTheme(nextTheme);
    };

    applyTheme();

    const handleChange = () => {
      if (themePreference === "system") {
        applyTheme();
      }
    };

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    if (typeof mediaQuery.addListener === "function") {
      mediaQuery.addListener(handleChange);
      return () => mediaQuery.removeListener(handleChange);
    }

    return;
  }, [themePreference]);

  useEffect(() => {
    const timer = window.setTimeout(() => setStopArmed(false), 6000);
    return () => window.clearTimeout(timer);
  }, [stopArmed]);

  useEffect(() => {
    const tick = window.setInterval(() => {
      void refreshSnapshot();
    }, 4000);

    void refreshSnapshot();

    return () => {
      window.clearInterval(tick);
    };
  }, []);

  useEffect(() => {
    const tick = window.setInterval(() => {
      void refreshOperatorState();
    }, 12000);

    void refreshOperatorState();

    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    let cancelled = false;

    function readBootstrapState() {
      try {
        return window.sessionStorage.getItem(RUNTIME_BOOTSTRAP_SESSION_KEY);
      } catch {
        return null;
      }
    }

    function writeBootstrapState(value: "running" | "done") {
      try {
        window.sessionStorage.setItem(RUNTIME_BOOTSTRAP_SESSION_KEY, value);
      } catch {
        // Ignore storage access failures in constrained webviews.
      }
    }

    function clearBootstrapState() {
      try {
        window.sessionStorage.removeItem(RUNTIME_BOOTSTRAP_SESSION_KEY);
      } catch {
        // Ignore storage access failures in constrained webviews.
      }
    }

    async function bootstrapRuntimeOnOpen() {
      try {
        const existingState = readBootstrapState();
        if (existingState === "running" || existingState === "done") {
          return;
        }

        writeBootstrapState("running");
        setPendingOperatorAction("bootstrap-runtime");
        setOperatorState("Bootstrapping runtime automation...");

        const response = await fetch("/api/operator", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action: "bootstrap-runtime" }),
        });
        const payload = (await response.json()) as {
          message?: string;
          events?: DashboardOperatorData["events"];
          pendingModeRequest?: OperatorMode | null;
          audit?: DashboardOperatorData["audit"];
          overlayCompare?: DashboardOperatorData["overlayCompare"];
          overlayEffect?: DashboardOperatorData["overlayEffect"];
          botHealth?: DashboardOperatorData["botHealth"];
        };

        if (!response.ok) {
          throw new Error(payload.message ?? `HTTP ${response.status}`);
        }

        if (cancelled) {
          return;
        }

        setOperatorState(payload.message ?? "Runtime automation bootstrapped.");
        setOperator((previousOperator) => ({
          events: payload.events ?? previousOperator.events,
          pendingModeRequest: payload.pendingModeRequest ?? previousOperator.pendingModeRequest,
          audit: payload.audit ?? previousOperator.audit,
          overlayCompare: payload.overlayCompare ?? previousOperator.overlayCompare,
          overlayEffect: payload.overlayEffect ?? previousOperator.overlayEffect,
          botHealth: payload.botHealth ?? previousOperator.botHealth,
        }));
        writeBootstrapState("done");
        await refreshSnapshot(true);
        await refreshOperatorState();
      } catch (error) {
        if (!cancelled) {
          setOperatorState(error instanceof Error ? error.message : "Runtime automation bootstrap failed.");
        }
        clearBootstrapState();
      } finally {
        if (!cancelled) {
          setPendingOperatorAction((current) => (current === "bootstrap-runtime" ? null : current));
        }
      }
    }

    void bootstrapRuntimeOnOpen();

    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshSnapshot(manual = false) {
    if (manual) {
      setIsRefreshing(true);
    }

    try {
      const response = await fetch("/api/runtime-snapshot", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const nextSnapshot = (await response.json()) as RuntimeSnapshot;
      setSnapshot(nextSnapshot);
      setRefreshState(`${manual ? "Manual refresh" : "Live runtime"} · cycle ${nextSnapshot.cycle}`);
    } catch (error) {
      setRefreshState(`Refresh degraded · ${(error as Error).message}`);
    } finally {
      if (manual) {
        setIsRefreshing(false);
      }
    }
  }

  async function refreshOperatorState() {
    try {
      const response = await fetch("/api/operator?eventLimit=16", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = (await response.json()) as {
        events?: DashboardOperatorData["events"];
        pendingModeRequest?: OperatorMode | null;
        audit?: DashboardOperatorData["audit"];
        overlayCompare?: DashboardOperatorData["overlayCompare"];
        overlayEffect?: DashboardOperatorData["overlayEffect"];
        botHealth?: DashboardOperatorData["botHealth"];
      };

      setOperator((previousOperator) => ({
        events: payload.events ?? previousOperator.events,
        pendingModeRequest: payload.pendingModeRequest ?? previousOperator.pendingModeRequest,
        audit: payload.audit ?? previousOperator.audit,
        overlayCompare: payload.overlayCompare ?? previousOperator.overlayCompare,
        overlayEffect: payload.overlayEffect ?? previousOperator.overlayEffect,
        botHealth: payload.botHealth ?? previousOperator.botHealth,
      }));
      setOperatorState((currentState) =>
        currentState.startsWith("Operator API degraded") ? "Operator controls ready." : currentState,
      );
    } catch (error) {
      setOperatorState((currentState) => {
        if (pendingOperatorAction !== null) {
          return currentState;
        }

        const message = error instanceof Error ? error.message : "Unavailable";
        return `Operator API degraded · ${message}`;
      });
    }
  }

  async function runOperatorAction(action: OperatorAction, targetMode?: OperatorMode) {
    setPendingOperatorAction(action);
    setStopArmed(false);

    try {
      const response = await fetch("/api/operator", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action, targetMode }),
      });

      const payload = (await response.json()) as {
        message?: string;
        ok?: boolean;
        confirmed?: boolean;
        events?: DashboardOperatorData["events"];
        pendingModeRequest?: OperatorMode | null;
        audit?: DashboardOperatorData["audit"];
        overlayCompare?: DashboardOperatorData["overlayCompare"];
        overlayEffect?: DashboardOperatorData["overlayEffect"];
        botHealth?: DashboardOperatorData["botHealth"];
      };

      if (!response.ok && response.status !== 202) {
        throw new Error(payload.message ?? `HTTP ${response.status}`);
      }

      setOperatorState(payload.message ?? "Operator action completed.");
      setOperator((previousOperator) => ({
        events: payload.events ?? previousOperator.events,
        pendingModeRequest: payload.pendingModeRequest ?? previousOperator.pendingModeRequest,
        audit: payload.audit ?? previousOperator.audit,
        overlayCompare: payload.overlayCompare ?? previousOperator.overlayCompare,
        overlayEffect: payload.overlayEffect ?? previousOperator.overlayEffect,
        botHealth: payload.botHealth ?? previousOperator.botHealth,
      }));

      if (action === "status" || action === "set-mode" || action === "restart-supervisor") {
        const refreshDelayMs = action === "set-mode" && payload.confirmed === false ? 4_000 : 1_200;
        await new Promise((resolve) => window.setTimeout(resolve, refreshDelayMs));
        await refreshSnapshot(true);
      }

      await refreshOperatorState();
    } catch (error) {
      setOperatorState(error instanceof Error ? error.message : "Operator action failed.");
    } finally {
      setPendingOperatorAction(null);
    }
  }

  const balanceSummary = operator.audit.balanceSummary;
  const tradeSummary = operator.audit.tradeSummary;
  const currentModeLabel = snapshot.mode;
  const botHealth = operator.botHealth;
  const walletBalance = balanceSummary.latestTotalWalletBalance;
  const realizedPnl = tradeSummary.realizedPnlTotal;
  const unrealizedPnl = snapshot.positions.reduce((total, position) => total + position.unrealized_pnl, 0);
  const topOpportunity = snapshot.opportunities[0] ?? null;
  const topPosition = snapshot.positions[0] ?? null;
  const openRiskUsd = snapshot.positions.reduce((total, position) => total + position.notional_usd, 0);
  const exactCoverage = tradeSummary.exactCoverageRate;
  const topPositionEntryTimestamp = topPosition
    ? operator.audit.openPositionEntries.find((entry) => entry.symbol === topPosition.symbol)?.entry_timestamp_ms ?? null
    : null;

  const mistakes = buildMistakes(snapshot, operator);

  return (
    <div className="min-h-screen" style={{background:"var(--background)",color:"var(--foreground)",fontFamily:"var(--font-sans)"}}>
      <div className="flex min-h-screen w-full">

        {/* ══ SIDEBAR ══ */}
        <aside className="hidden lg:flex w-[220px] shrink-0 flex-col border-r" style={{background:"var(--sidebar)",borderColor:"var(--n-line)",backgroundImage:"var(--grad-sidebar)"}}>
          <div className="sticky top-0 flex h-screen flex-col">

            {/* Logo */}
            <div className="flex items-center gap-3 px-5 py-4 border-b" style={{borderColor:"var(--n-line)"}}>
              <div className="size-8 rounded-lg flex items-center justify-center shrink-0" style={{background:"rgba(59,130,246,0.15)",border:"1px solid rgba(59,130,246,0.25)"}}>
                <img alt="NyraQ" className="size-5 object-contain" src="/nyraq-mark.svg" style={{filter:"brightness(0) saturate(100%) invert(50%) sepia(90%) saturate(500%) hue-rotate(180deg) brightness(120%)"}} />
              </div>
              <div>
                <div className="text-[13px] font-semibold" style={{color:"var(--foreground)"}}>NyraQ</div>
                <div className="text-[10px]" style={{color:"var(--muted-foreground)"}}>Quant OS</div>
              </div>
            </div>

            {/* Nav */}
            <nav className="flex-1 overflow-y-auto py-3 px-2">
              <div className="n-nav-section">Monitor</div>
              {navItems.filter(i => ["overview","positions","markets"].includes(i.page)).map((item) => {
                const Icon = item.icon;
                const active = page === item.page;
                return (
                  <Link key={item.page} href={item.href} className={cn("n-nav-item", active && "active")}>
                    <Icon className="size-4 shrink-0" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
              <div className="n-nav-section" style={{marginTop:"16px"}}>Operate</div>
              {navItems.filter(i => ["risk","execution","review","settings"].includes(i.page)).map((item) => {
                const Icon = item.icon;
                const active = page === item.page;
                return (
                  <Link key={item.page} href={item.href} className={cn("n-nav-item", active && "active")}>
                    <Icon className="size-4 shrink-0" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </nav>

            {/* Status footer */}
            <div className="px-4 py-4 border-t space-y-3" style={{borderColor:"var(--n-line)"}}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="n-pill n-pill-blue">{currentModeLabel}</span>
                <span className="n-pill n-pill-neutral">{snapshot.venue}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="n-dot n-dot-green n-blink shrink-0" />
                <p className="text-[11px] truncate" style={{color:"var(--muted-foreground)"}}>{refreshState}</p>
              </div>
              <BotHealthBadge health={botHealth} />
            </div>

          </div>
        </aside>

        <main className="min-w-0 flex-1 flex flex-col">

          {/* ── Mobile nav ── */}
          <div className="lg:hidden border-b px-4 py-2.5" style={{borderColor:"var(--n-line)",background:"var(--sidebar)"}}>
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-2">
                <div className="size-6 rounded-md flex items-center justify-center" style={{background:"rgba(59,130,246,0.15)",border:"1px solid rgba(59,130,246,0.25)"}}>
                  <img alt="NyraQ" className="size-4 object-contain" src="/nyraq-mark.svg" style={{filter:"brightness(0) saturate(100%) invert(50%) sepia(90%) saturate(500%) hue-rotate(180deg) brightness(120%)"}} />
                </div>
                <span className="text-[13px] font-semibold" style={{color:"var(--foreground)"}}>NyraQ</span>
              </div>
            </div>
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = page === item.page;
                return (
                  <Link
                    key={item.page}
                    href={item.href}
                    className="flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-lg transition-colors"
                    style={active
                      ? {background:"rgba(59,130,246,0.12)",color:"var(--n-blue)",border:"1px solid rgba(59,130,246,0.2)"}
                      : {background:"rgba(255,255,255,0.04)",color:"var(--muted-foreground)",border:"1px solid var(--n-line)"}}
                  >
                    <Icon className="size-3.5" />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>

          {/* ══ TOPBAR ══ */}
          <header className="n-topbar shrink-0 justify-between">
            <div className="flex items-center gap-3">
              <h1 className="text-[15px] font-semibold" style={{color:"var(--foreground)"}}>{headlineForPage(page)}</h1>
              <BotHealthBadge health={botHealth} />
            </div>
            <div className="flex items-center gap-3">
              <span className="hidden text-[12px] sm:block truncate max-w-72" style={{color:"var(--muted-foreground)"}}>
                {pendingOperatorAction === null ? operatorState : `${pendingOperatorAction}…`}
              </span>
              <button
                className="n-btn n-btn-ghost"
                disabled={isRefreshing}
                onClick={() => void refreshSnapshot(true)}
              >
                <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} />
                Sync
              </button>
            </div>
          </header>

          {/* ══ PAGE CONTENT ══ */}
          <div className="flex-1 overflow-auto p-5 lg:p-6 space-y-5">

          {page === "overview" ? (
            <OverviewPage
              botHealth={botHealth}
              mistakes={mistakes}
              openRiskUsd={openRiskUsd}
              realizedPnl={realizedPnl}
              snapshot={snapshot}
              topOpportunity={topOpportunity}
              topPosition={topPosition}
              topPositionEntryTimestamp={topPositionEntryTimestamp}
              tradeSummary={tradeSummary}
              unrealizedPnl={unrealizedPnl}
              walletBalance={walletBalance}
            />
          ) : null}

          {page === "positions" ? (
            <PositionsPage
              balanceSummary={balanceSummary}
              openPositionEntries={operator.audit.openPositionEntries}
              snapshot={snapshot}
              tradeSummary={tradeSummary}
            />
          ) : null}

          {page === "markets" ? (
            <StrategiesPage
              openPositionEntries={operator.audit.openPositionEntries}
              snapshot={snapshot}
              tradeSummary={tradeSummary}
            />
          ) : null}

          {page === "risk" ? (
            <RiskPage operator={operator} snapshot={snapshot} />
          ) : null}

          {page === "execution" ? (
            <ExecutionPage
              botHealth={botHealth}
              operator={operator}
              pendingOperatorAction={pendingOperatorAction}
              runOperatorAction={runOperatorAction}
              snapshot={snapshot}
              stopArmed={stopArmed}
              setStopArmed={setStopArmed}
            />
          ) : null}

          {page === "review" ? (
            <ReviewPage exactCoverage={exactCoverage} mistakes={mistakes} tradeSummary={tradeSummary} />
          ) : null}

          {page === "settings" ? (
            <SettingsPage
              operator={operator}
              refreshOperatorState={refreshOperatorState}
              refreshSnapshot={refreshSnapshot}
              resolvedTheme={resolvedTheme}
              runOperatorAction={runOperatorAction}
              setThemePreference={setThemePreference}
              snapshot={snapshot}
              themePreference={themePreference}
            />
          ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}

function NyraQLockup({ compact = false }: { compact?: boolean }) {
  return (
    <div className={cn("flex items-center gap-4", compact && "gap-3")}>
      <div className={cn("flex items-center justify-center  border border-(--glass-border) bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_92%,var(--background)_8%),color-mix(in_srgb,var(--card)_98%,transparent_2%))] shadow-(--shadow-card) ring-1 ring-white/25 backdrop-blur-xl dark:ring-white/6", compact ? "size-14" : "size-16")}>
        <img alt="NyraQ mark" className={cn("object-contain", compact ? "size-10" : "size-12")} src="/nyraq-mark.svg" />
      </div>
      <div className="space-y-1.5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.3em] text-muted-foreground">NyraQ</div>
        <div className={cn("font-semibold tracking-[-0.05em] text-foreground", compact ? "text-base" : "text-lg")}>Quant terminal</div>
      </div>
    </div>
  );
}

function NyraQHeaderBadge() {
  return (
    <div className="inline-flex items-center gap-2 border border-[var(--n-line)] bg-background/72 px-3 py-2">
      <img alt="NyraQ mark" className="size-6 object-contain" src="/nyraq-mark.svg" />
      <span className="text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">NyraQ</span>
    </div>
  );
}

function OverviewPage({
  botHealth,
  walletBalance,
  realizedPnl,
  unrealizedPnl,
  openRiskUsd,
  snapshot,
  topOpportunity,
  topPosition,
  topPositionEntryTimestamp,
  tradeSummary,
  mistakes,
}: {
  botHealth: BotHealthReport;
  walletBalance: number | null;
  realizedPnl: number;
  unrealizedPnl: number;
  openRiskUsd: number;
  snapshot: RuntimeSnapshot;
  topOpportunity: RuntimeSnapshot["opportunities"][number] | null;
  topPosition: RuntimePosition | null;
  topPositionEntryTimestamp: number | null;
  tradeSummary: DashboardOperatorData["audit"]["tradeSummary"];
  mistakes: Array<{ title: string; why: string }>;
}) {
  const liveAccountConnected = snapshot.exchange_gate.includes("+account");
  const liveAccountFlat = liveAccountConnected && walletBalance === null && snapshot.positions.length === 0;

  return (
    <div className="space-y-3">

      {/* ══ ROW 1: KPI STRIP ══ */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <MetricCard label="Wallet Balance" tone="neutral" value={formatUsd(walletBalance)} />
        <MetricCard label="Realized P&L" tone={realizedPnl >= 0 ? "positive" : "negative"} value={formatSignedUsd(realizedPnl)} />
        <MetricCard label="Unrealized P&L" tone={unrealizedPnl >= 0 ? "positive" : "negative"} value={formatSignedUsd(unrealizedPnl)} />
        <MetricCard label="Open Exposure" tone="neutral" value={formatUsd(openRiskUsd)} />
      </div>

      {liveAccountFlat ? (
        <div className="border px-3 py-2 text-xs" style={{borderColor:"rgba(59,130,246,0.25)",background:"var(--n-blue-dim)",color:"var(--n-blue)"}}>
          ▶ LIVE ACCOUNT CONNECTED — NO WALLET BALANCE OR POSITIONS YET
        </div>
      ) : null}

      {/* ══ ROW 2: BOT STATUS + TRADE STATS + SYMBOL SCAN ══ */}
      <div className="grid gap-4 lg:grid-cols-[1fr_180px]" style={{background:"var(--n-line)"}}>

        {/* Bot health panel */}
        <div className="border-0 px-3 py-2.5 space-y-2" style={{background:"var(--card)"}}>
          <div className="flex items-center justify-between gap-2 border-b pb-2" style={{borderColor:"var(--n-line)"}}>
            <span className="n-label" style={{color:"var(--muted-foreground)"}}>BOT HEALTH</span>
            <BotHealthBadge health={botHealth} />
          </div>
          <div className="grid grid-cols-2 gap-px sm:grid-cols-4" style={{background:"var(--n-line)"}}>
            <WatchMetric label="PAPER" value={botHealth.paper_status} />
            <WatchMetric label="STARTUP" value={botHealth.startup_status} />
            <WatchMetric label="EXEC" value={botHealth.execution_status} />
            <WatchMetric label="MONITOR" value={botHealth.monitor_status} />
          </div>
          <p className="text-[10px] leading-4" style={{color:"var(--muted-foreground)"}}>{botHealth.summary}</p>
        </div>

        {/* Trade stats */}
        <div className="border-0 px-3 py-2.5 space-y-2" style={{background:"var(--card)"}}>
          <span className="n-label" style={{color:"var(--muted-foreground)"}}>TRADE STATS</span>
          <div className="grid grid-cols-2 gap-px" style={{background:"var(--n-line)"}}>
            <MetricBlock compact label="WIN RATE" value={formatPercent(tradeSummary.winRate, 1)} />
            <MetricBlock compact label="PROF FACTOR" value={formatNumber(tradeSummary.profitFactor)} />
            <MetricBlock compact label="EXPECTANCY" value={formatSignedUsd(tradeSummary.expectancyPerTrade)} />
            <MetricBlock compact label="TRADES" value={String(tradeSummary.closedTrades)} />
          </div>
        </div>
      </div>

      {/* ══ ROW 3: SYMBOL WATCHLIST ══ */}
      <div className="border" >
        <div className="flex items-center gap-2 px-3 py-1.5 border-b" style={{borderColor:"var(--n-line)"}}>
          <span className="n-label" style={{color:"var(--muted-foreground)"}}>WATCHLIST</span>
          <span className="text-[9px]" style={{color:"var(--n-line-strong)"}}>──</span>
          <span className="text-[9px]" style={{color:"var(--muted-foreground)",opacity:0.6}}>10 SYMBOLS · LIVE SCAN</span>
        </div>
        <div className="grid gap-4 grid-cols-5 sm:grid-cols-10" style={{background:"var(--n-line)"}}>
          {["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT","ADAUSDT","AVAXUSDT","LINKUSDT","DOTUSDT"].map((sym) => {
            const op = snapshot.opportunities.find((o) => o.symbol === sym && o.family !== "NoCandidate");
            const conf = op ? parseFloat(op.confidence) : 0;
            const isGood = op && !op.regime.includes("NoTrade") && !op.regime.includes("Disordered");
            const isBad = op && (op.regime.includes("NoTrade") || op.regime.includes("Disordered"));
            const symColor = isGood ? "var(--n-green)" : isBad ? "var(--n-red)" : "var(--muted-foreground)";
            const symBg = isGood ? "var(--n-green-dim)" : isBad ? "var(--n-red-dim)" : "var(--card)";
            return (
              <div className="px-2 py-2 text-center border-0" key={sym} style={{background:symBg}}>
                <div className="text-[11px] font-bold" style={{color:symColor}}>{sym.replace("USDT","")}</div>
                <div className="text-[8px] font-bold uppercase tracking-[0.08em] mt-0.5" style={{color:symColor,opacity:0.8}}>{op ? op.action.slice(0,4) : "——"}</div>
                {op && (
                  <div className="text-[8px] tabular-nums" style={{color:(op.htf_trend_bias ?? 0) > 0.3 ? "var(--n-green)" : (op.htf_trend_bias ?? 0) < -0.3 ? "var(--n-red)" : "var(--muted-foreground)"}}>
                    {(op.htf_trend_bias ?? 0) > 0.3 ? "▲" : (op.htf_trend_bias ?? 0) < -0.3 ? "▼" : "—"}
                  </div>
                )}
                {op && conf > 0 && (
                  <div className="mt-1 h-px w-full overflow-hidden" style={{background:"var(--n-line)"}}>
                    <div className="h-full" style={{width:`${Math.min(100, conf * 100)}%`,background:symColor}} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ══ ROW 4: CHART + SIDE PANEL ══ */}
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] items-start">
        <TradingViewPanel candles={snapshot.candle_points} points={snapshot.indicator_points} title="Market pane" />
        <div className="space-y-3">
          {/* Current attention */}
          <div className="border px-3 py-2.5 space-y-1.5" >
            <span className="n-label" style={{color:"var(--muted-foreground)"}}>CURRENT POSITION</span>
            <p className="text-xs leading-5" style={{color:"var(--foreground)"}}>
              {topPosition
                ? `${topPosition.symbol}  ${formatSignedUsd(topPosition.unrealized_pnl)} P&L${topPositionEntryTimestamp !== null ? `  open ${formatRelativeDuration(topPositionEntryTimestamp)}` : ""}`
                : "FLAT — no live position"}
            </p>
            {topOpportunity && (
              <p className="text-[10px] leading-4" style={{color:"var(--muted-foreground)"}}>
                BEST: {topOpportunity.symbol} {topOpportunity.action} conf={topOpportunity.confidence} HTF={((topOpportunity.htf_trend_bias ?? 0) >= 0 ? "+" : "")}{(topOpportunity.htf_trend_bias ?? 0).toFixed(2)}
              </p>
            )}
          </div>
          {/* Mistakes */}
          <div className="border" >
            <div className="px-3 py-1.5 border-b" style={{borderColor:"var(--n-line)"}}>
              <span className="n-label" style={{color:"var(--n-red)"}}>⚠ MISTAKES TO AVOID</span>
            </div>
            <div className="divide-y" style={{borderColor:"var(--n-line)"}}>
              {mistakes.map((mistake) => (
                <div className="px-3 py-2" key={mistake.title} style={{borderColor:"var(--n-line)"}}>
                  <div className="text-[10px] font-bold" style={{color:"var(--foreground)"}}>{mistake.title}</div>
                  <div className="mt-0.5 text-[10px] leading-4" style={{color:"var(--muted-foreground)"}}>{mistake.why}</div>
                </div>
              ))}
            </div>
          </div>
          {/* Proven execution */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1" style={{background:"var(--n-line)"}}>
            <ProvenExecutionCard
              body={botHealth.last_paper_entry_at_ms !== null ? `Proven paper entry ${formatRelativeDuration(botHealth.last_paper_entry_at_ms)}.` : botHealth.awaiting_first_paper_fill ? "Warmup — waiting for first paper fill." : "No fresh paper entry proven yet."}
              label="Last proven entry"
              timestampMs={botHealth.last_paper_entry_at_ms}
              tone={botHealth.recent_paper_entry ? "positive" : botHealth.awaiting_first_paper_fill ? "neutral" : "negative"}
            />
            <ProvenExecutionCard
              body={botHealth.last_paper_exit_at_ms !== null ? `Proven paper exit ${formatRelativeDuration(botHealth.last_paper_exit_at_ms)}.` : "No fresh paper close proven yet."}
              label="Last proven exit"
              timestampMs={botHealth.last_paper_exit_at_ms}
              tone={botHealth.recent_paper_exit ? "positive" : "neutral"}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function PositionsPage({
  snapshot,
  openPositionEntries,
  balanceSummary,
  tradeSummary,
}: {
  snapshot: RuntimeSnapshot;
  openPositionEntries: DashboardOperatorData["audit"]["openPositionEntries"];
  balanceSummary: DashboardOperatorData["audit"]["balanceSummary"];
  tradeSummary: DashboardOperatorData["audit"]["tradeSummary"];
}) {
  const entryTimesBySymbol = new Map(openPositionEntries.map((entry) => [entry.symbol, entry.entry_timestamp_ms]));
  const liveAccountConnected = snapshot.exchange_gate.includes("+account");
  const liveAccountFlat = liveAccountConnected && balanceSummary.latestTotalWalletBalance === null && snapshot.positions.length === 0;
  const emptyPositionsMessage = liveAccountFlat
    ? "Live Binance Futures account is connected, but there are no open positions and no non-zero futures wallet balances right now."
    : "No live positions are open.";
  const emptyBalanceMessage = liveAccountFlat
    ? "The live account is connected, but no non-zero futures wallet balance snapshots have been recorded yet. Fund the futures wallet or wait for the first non-zero balance change to populate the calendar."
    : "No daily balance closes are available yet.";

  return (
    <div className="space-y-3">
      {liveAccountFlat ? (
        <div className="px-3 py-2.5 text-[10px] leading-4" style={{background:"var(--card)",border:"1px solid var(--n-line)",color:"var(--muted-foreground)"}}>
          Positions and balance history are live, but the connected Binance Futures account is currently flat: zero open positions and zero non-zero wallet balances.
        </div>
      ) : null}

      <div className="grid gap-3 xl:grid-cols-[1.08fr_0.92fr]">
        <div className="n-card">
          <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
            <span className="n-label">Open positions</span>
            
          </div>
          <div className="px-4 pb-4">
            {snapshot.positions.length === 0 ? (
              <EmptyState message={emptyPositionsMessage} />
            ) : (
              <div className="n-card overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Symbol</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead>Opened</TableHead>
                      <TableHead>Entry</TableHead>
                      <TableHead>Leverage</TableHead>
                      <TableHead>Unrealized</TableHead>
                      <TableHead>Notional</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {snapshot.positions.map((position) => (
                      <TableRow key={position.symbol}>
                        <TableCell className="font-medium">{position.symbol}</TableCell>
                        <TableCell>{formatNumber(position.quantity, 4)}</TableCell>
                        <TableCell>
                          {entryTimesBySymbol.has(position.symbol) ? (
                            <div className="space-y-1">
                              <div>{formatTimestampMs(entryTimesBySymbol.get(position.symbol) ?? 0)}</div>
                              <div className="text-[11px] text-muted-foreground">{formatRelativeDuration(entryTimesBySymbol.get(position.symbol) ?? 0)}</div>
                            </div>
                          ) : (
                            "No data"
                          )}
                        </TableCell>
                        <TableCell>{formatUsd(position.entry_price, 2)}</TableCell>
                        <TableCell>{position.leverage.toFixed(1)}x</TableCell>
                        <TableCell className={signedValueTextClass(position.unrealized_pnl)}>
                          {formatSignedUsd(position.unrealized_pnl)}
                        </TableCell>
                        <TableCell>{formatUsd(position.notional_usd)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </div>

        <div className="n-card">
          <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
            <span className="n-label">Balance calendar</span>
            
          </div>
          <div className="px-4 pb-4">
            <BalanceCalendar days={balanceSummary.calendar} emptyMessage={emptyBalanceMessage} />
          </div>
        </div>
      </div>

      <div className="n-card">
        <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
          <span className="n-label">Recent closed trades</span>
          
        </div>
        <div className="px-4 pb-4">
          {tradeSummary.recentTrades.length === 0 ? (
            <EmptyState message="No closed trades recorded yet." />
          ) : (
            <div className="n-card overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Symbol</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>P&L</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tradeSummary.recentTrades.map((trade) => (
                    <TableRow key={trade.id}>
                      <TableCell>{formatTimestampMs(trade.timestamp_ms)}</TableCell>
                      <TableCell className="font-medium">{trade.symbol}</TableCell>
                      <TableCell>{trade.side}</TableCell>
                      <TableCell>{trade.source}</TableCell>
                      <TableCell>{trade.close_reason}</TableCell>
                      <TableCell className={signedValueTextClass(trade.realized_pnl)}>
                        {formatSignedUsd(trade.realized_pnl)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SymbolHeatmap({
  opportunities,
  symbols,
}: {
  opportunities: RuntimeSnapshot["opportunities"];
  symbols: string[];
}) {
  const ALL_SYMBOLS = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
    "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT",
  ];
  const displaySymbols = symbols.length > 0 ? symbols : ALL_SYMBOLS;

  function regimeTone(regime: string): string {
    if (regime.includes("Trending") || regime.includes("Breakout") || regime.includes("Momentum")) return "positive";
    if (regime.includes("NoTrade") || regime.includes("Disordered") || regime.includes("Reversal")) return "negative";
    return "neutral";
  }

  function confidenceTone(conf: number): string {
    if (conf >= 0.75) return "text-(--success-foreground)";
    if (conf >= 0.55) return "text-foreground";
    return "text-muted-foreground";
  }

  function shortRegime(regime: string): string {
    const map: Record<string, string> = {
      Trending: "Trend",
      Ranging: "Range",
      BreakoutExpansion: "Breakout",
      VolatilityCompression: "VolComp",
      ReversalAttempt: "Reversal",
      NoTrade: "NoTrade",
      Disordered: "Disorder",
    };
    return map[regime] ?? regime.slice(0, 8);
  }

  return (
    <div className="n-card">
      <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
        <span className="n-label">Symbol heatmap</span>
        
      </div>
      <div className="px-4 pb-4">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {displaySymbols.map((sym) => {
            const op = opportunities.find((o) => o.symbol === sym && o.family !== "NoCandidate");
            const conf = op ? parseFloat(op.confidence) : 0;
            const tone = op ? regimeTone(op.regime) : "neutral";
            const toneClass =
              tone === "positive"
                ? "border-(--success-border) bg-(--success-surface)"
                : tone === "negative"
                  ? "border-(--danger-border) bg-(--danger-surface)"
                  : "border-[var(--n-line)] bg-[var(--muted)]";

            const fundingRate = op?.funding_rate ?? 0;
            const htf = op?.htf_trend_bias ?? 0;
            const depth = op?.depth_imbalance ?? 0;
            const oi = op?.oi_delta ?? 0;

            const htfLabel = htf > 0.3 ? "↑ Bull" : htf < -0.3 ? "↓ Bear" : "— Flat";
            const htfColor = htf > 0.3 ? "text-(--success-foreground)" : htf < -0.3 ? "text-(--danger-foreground)" : "text-muted-foreground";
            const fundingColor = fundingRate > 0.0005 ? "text-(--danger-foreground)" : fundingRate < -0.0005 ? "text-(--success-foreground)" : "text-muted-foreground";
            const depthColor = depth > 0.15 ? "text-(--success-foreground)" : depth < -0.15 ? "text-(--danger-foreground)" : "text-muted-foreground";

            return (
              <div
                className={cn("relative overflow-hidden  border px-4 py-3 transition-all", toneClass)}
                key={sym}
              >
                <div className="text-sm font-semibold tracking-[-0.02em] text-foreground">
                  {sym.replace("USDT", "")}
                  <span className="ml-1 text-[10px] font-normal text-muted-foreground">/ USDT</span>
                </div>
                {op ? (
                  <>
                    <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                      {shortRegime(op.regime)}
                    </div>
                    <div className={cn("mt-1 text-xs font-medium tabular-nums", confidenceTone(conf))}>
                      {formatStrategyFamily(op.family)}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      conf {op.confidence} · {op.action}
                    </div>
                    {/* Signal row: HTF · Funding · Depth */}
                    <div className="mt-1.5 flex items-center gap-2 text-[10px] tabular-nums">
                      <span className={htfColor}>{htfLabel}</span>
                      <span className="text-border/60">·</span>
                      <span className={fundingColor} title="Funding rate per 8h">
                        F:{(fundingRate * 100).toFixed(3)}%
                      </span>
                      <span className="text-border/60">·</span>
                      <span className={depthColor} title="L2 depth imbalance">
                        D:{depth >= 0 ? "+" : ""}{depth.toFixed(2)}
                      </span>
                    </div>
                    {/* OI delta micro badge */}
                    {Math.abs(oi) > 0.01 && (
                      <div className={cn("mt-1 text-[10px]", oi > 0 ? "text-(--success-foreground)" : "text-(--danger-foreground)")}>
                        OI {oi > 0 ? "▲" : "▼"} {Math.abs(oi).toFixed(3)}
                      </div>
                    )}
                    {/* Confidence bar */}
                    <div className="mt-2 h-[3px] w-full overflow-hidden bg-black/10">
                      <div
                        className="h-full transition-all duration-500"
                        style={{
                          width: `${Math.min(100, conf * 100)}%`,
                          background: conf >= 0.75 ? "var(--cal-green-text)" : conf >= 0.55 ? "currentColor" : "rgba(148,163,184,0.6)",
                        }}
                      />
                    </div>
                  </>
                ) : (
                  <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">No signal</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StrategiesPage({
  snapshot,
  tradeSummary,
  openPositionEntries,
}: {
  snapshot: RuntimeSnapshot;
  tradeSummary: DashboardOperatorData["audit"]["tradeSummary"];
  openPositionEntries: DashboardOperatorData["audit"]["openPositionEntries"];
}) {
  const availableSymbols = strategySymbols(snapshot);
  const [selectedSymbol, setSelectedSymbol] = useState<string>(availableSymbols[0] ?? "All");
  const [selectedWindow, setSelectedWindow] = useState<number>(48);

  useEffect(() => {
    if (availableSymbols.length === 0) {
      setSelectedSymbol("All");
      return;
    }

    if (!availableSymbols.includes(selectedSymbol)) {
      setSelectedSymbol(availableSymbols[0]);
    }
  }, [availableSymbols, selectedSymbol]);

  const scopedSnapshot = filterSnapshotForStrategy(snapshot, selectedSymbol, selectedWindow);
  const scopedTrades = filterTradesForStrategy(tradeSummary.tradeHistory, selectedSymbol).slice(0, 16);
  const selectedPosition = selectedSymbol === "All"
    ? null
    : snapshot.positions.find((position) => position.symbol === selectedSymbol) ?? null;
  const selectedPositionEntryTimestamp = selectedSymbol === "All"
    ? null
    : openPositionEntries.find((entry) => entry.symbol === selectedSymbol)?.entry_timestamp_ms ?? null;
  const selectedOpportunity = selectedSymbol === "All"
    ? snapshot.opportunities[0] ?? null
    : snapshot.opportunities.find((item) => item.symbol === selectedSymbol) ?? null;
  const latestIndicatorPoint = scopedSnapshot.indicator_points.at(-1) ?? null;
  const latestCandle = scopedSnapshot.candle_points.at(-1) ?? null;

  return (
    <div className="space-y-3">
      <div className="n-card">
        <div className="px-4 pb-4 grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:p-5">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Markets workstation</Badge>
              <Badge variant="secondary">{selectedSymbol === "All" ? "All symbols" : selectedSymbol}</Badge>
            </div>
            <div className="text-base font-semibold tracking-[-0.03em] text-foreground">Signal intelligence, opportunity queue, and live chart in one surface.</div>
            <p className="max-w-3xl text-[10px] leading-4" style={{color:"var(--muted-foreground)"}}>Select a symbol from the watchlist to load its chart, indicators, and live signal context. Consensus, HTF bias, and funding rate update each cycle.</p>
          </div>
          <div className="space-y-2">
            <div className="grid gap-2 grid-cols-3">
              <MetricBlock compact label="Last price" value={latestCandle ? formatUsd(latestCandle.close, 2) : "No data"} />
              <MetricBlock compact label="Consensus" tone={(latestIndicatorPoint?.signal_consensus ?? 0) > 0 ? "positive" : (latestIndicatorPoint?.signal_consensus ?? 0) < 0 ? "negative" : "neutral"} value={latestIndicatorPoint ? formatSignedNumber(latestIndicatorPoint.signal_consensus, 3) : "No data"} />
              <MetricBlock compact label="Queued action" tone={selectedOpportunity?.action === "Buy" ? "positive" : selectedOpportunity?.action === "Sell" ? "negative" : "neutral"} value={selectedOpportunity ? `${selectedOpportunity.action} · ${selectedOpportunity.family}` : "No signal"} />
            </div>
            <div className="grid gap-2 grid-cols-3">
              <MetricBlock compact label="Funding rate" tone={(selectedOpportunity?.funding_rate ?? 0) > 0.0005 ? "negative" : (selectedOpportunity?.funding_rate ?? 0) < -0.0005 ? "positive" : "neutral"} value={selectedOpportunity ? `${((selectedOpportunity.funding_rate ?? 0) * 100).toFixed(4)}%` : "—"} />
              <MetricBlock compact label="HTF bias" tone={(selectedOpportunity?.htf_trend_bias ?? 0) > 0.2 ? "positive" : (selectedOpportunity?.htf_trend_bias ?? 0) < -0.2 ? "negative" : "neutral"} value={selectedOpportunity ? formatSignedNumber(selectedOpportunity.htf_trend_bias ?? 0, 2) : "—"} />
              <MetricBlock compact label="Depth imbal." tone={(selectedOpportunity?.depth_imbalance ?? 0) > 0.1 ? "positive" : (selectedOpportunity?.depth_imbalance ?? 0) < -0.1 ? "negative" : "neutral"} value={selectedOpportunity ? formatSignedNumber(selectedOpportunity.depth_imbalance ?? 0, 2) : "—"} />
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.2fr)_minmax(19rem,0.8fr)] 2xl:grid-cols-[minmax(0,1.24fr)_minmax(22rem,0.76fr)]">
        <div>
          <TradingViewPanel
            activePosition={selectedPosition}
            activePositionEntryTimestamp={selectedPositionEntryTimestamp}
            candles={scopedSnapshot.candle_points}
            points={scopedSnapshot.indicator_points}
            trades={scopedTrades}
            title="TradingView-style market and indicator stack"
            mode={snapshot.mode}
            symbol={selectedSymbol}
            selectedWindow={selectedWindow}
            symbolOptions={availableSymbols}
            updatedAt={snapshot.updated_at}
            venue={snapshot.venue}
            onSelectSymbol={setSelectedSymbol}
            onSelectWindow={setSelectedWindow}
          />
        </div>
        <div className="xl:sticky xl:top-6 xl:self-start">
          <WatchlistRail
            openPositionEntries={openPositionEntries}
            opportunities={snapshot.opportunities}
            points={snapshot.indicator_points}
            positions={snapshot.positions}
            selectedSymbol={selectedSymbol}
            setSelectedSymbol={setSelectedSymbol}
            symbols={availableSymbols}
            window={selectedWindow}
          />
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.02fr)_minmax(0,0.98fr)]">
        <div className="n-card">
          <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
            <span className="n-label">Opportunity queue</span>
            
          </div>
          <div className="px-4 pb-4">
            {scopedSnapshot.opportunities.length === 0 ? (
              <EmptyState message="No strategy candidates are currently queued." />
            ) : (
              <div className="n-card overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Symbol</TableHead>
                      <TableHead>Family</TableHead>
                      <TableHead>Regime</TableHead>
                      <TableHead>Conf</TableHead>
                      <TableHead className="text-right">Funding</TableHead>
                      <TableHead className="text-right">HTF</TableHead>
                      <TableHead className="text-right">OI Δ</TableHead>
                      <TableHead className="text-right">Depth</TableHead>
                      <TableHead className="text-right">BTC corr</TableHead>
                      <TableHead>Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {scopedSnapshot.opportunities.map((item, idx) => {
                      const fundingRate = item.funding_rate ?? 0;
                      const htf = item.htf_trend_bias ?? 0;
                      const oi = item.oi_delta ?? 0;
                      const depth = item.depth_imbalance ?? 0;
                      const corr = item.btc_correlation ?? 0;
                      const fundingPct = (fundingRate * 100).toFixed(4);
                      const fundingTone = fundingRate > 0.0005 ? "text-(--danger-foreground)" : fundingRate < -0.0005 ? "text-(--success-foreground)" : "text-muted-foreground";
                      const htfTone = htf > 0.2 ? "text-(--success-foreground)" : htf < -0.2 ? "text-(--danger-foreground)" : "text-muted-foreground";
                      const oiTone = oi > 0.02 ? "text-(--success-foreground)" : oi < -0.02 ? "text-(--danger-foreground)" : "text-muted-foreground";
                      const depthTone = depth > 0.1 ? "text-(--success-foreground)" : depth < -0.1 ? "text-(--danger-foreground)" : "text-muted-foreground";
                      const corrTone = corr > 0.8 ? "text-(--warning-foreground)" : "text-muted-foreground";
                      return (
                        <TableRow key={`${item.symbol}-${item.model_id}-${idx}`}>
                          <TableCell className="font-medium">{item.symbol}</TableCell>
                          <TableCell>{formatStrategyFamily(item.family)}</TableCell>
                          <TableCell>{item.regime}</TableCell>
                          <TableCell className="tabular-nums">{item.confidence}</TableCell>
                          <TableCell className={cn("text-right tabular-nums text-xs", fundingTone)}>{fundingPct}%</TableCell>
                          <TableCell className={cn("text-right tabular-nums text-xs", htfTone)}>{htf >= 0 ? "+" : ""}{htf.toFixed(2)}</TableCell>
                          <TableCell className={cn("text-right tabular-nums text-xs", oiTone)}>{oi >= 0 ? "+" : ""}{oi.toFixed(3)}</TableCell>
                          <TableCell className={cn("text-right tabular-nums text-xs", depthTone)}>{depth >= 0 ? "+" : ""}{depth.toFixed(2)}</TableCell>
                          <TableCell className={cn("text-right tabular-nums text-xs", corrTone)}>{corr.toFixed(2)}</TableCell>
                          <TableCell>
                            <Badge className={cn("border", actionBadgeClasses(item.action))} variant="outline">{item.action}</Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </div>

        <div className="n-card">
          <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
            <span className="n-label">Research leaderboard</span>
            
          </div>
          <div className="px-4 pb-4 space-y-4">
            {scopedSnapshot.research_models.length === 0 ? (
              <EmptyState message="No research leaderboard is available yet." />
            ) : (
              scopedSnapshot.research_models.slice(0, 8).map((model) => (
                <div className="p-5" style={{background:"var(--card)"}} key={model.id}>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-foreground">{model.id}</div>
                      <div className="mt-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">{model.symbol} · {model.family} · {model.regime}</div>
                    </div>
                    <Badge className="border-[var(--n-line)] bg-background text-foreground" variant="outline">score {model.score.toFixed(2)}</Badge>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3 text-sm text-muted-foreground">
                    <MetricBlock label="Profitability" value={formatNumber(model.profitability)} compact />
                    <MetricBlock label="Risk-adjusted" value={formatNumber(model.risk_adjusted_return)} compact />
                    <MetricBlock label="Robustness" value={formatNumber(model.robustness)} compact />
                    <MetricBlock label="Threshold" value={formatNumber(model.threshold)} compact />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <SymbolHeatmap opportunities={snapshot.opportunities} symbols={availableSymbols} />

      <div className="n-card">
        <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
          <span className="n-label">What this means for entries</span>
          
        </div>
        <div className="px-4 pb-4 grid gap-4 md:grid-cols-3">
          <StrategyNote title="Wait for structure" detail="Use price and EMA relationship first. A model score without structure alignment is not enough." />
          <StrategyNote title="Respect recent P&L" detail={`Recent expectancy is ${formatSignedUsd(tradeSummary.expectancyPerTrade)}. If it degrades, lower aggressiveness instead of searching for more trades.`} />
          <StrategyNote title="Confirm momentum regime" detail={`RSI, MACD, and volume should support ${selectedSymbol === "All" ? "the active symbol" : selectedSymbol}. Range logic in a trend pane is where forced errors begin.`} />
        </div>
      </div>
    </div>
  );
}

function RiskPage({ snapshot, operator }: { snapshot: RuntimeSnapshot; operator: DashboardOperatorData }) {
  const retentionOrderPct = percentUsed(operator.audit.retention.orderIntents.currentCount, operator.audit.retention.orderIntents.limit);
  const retentionExecPct = percentUsed(operator.audit.retention.executionEvents.currentCount, operator.audit.retention.executionEvents.limit);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 xl:grid-cols-[minmax(0,0.94fr)_minmax(0,1.06fr)]">
        <div className="n-card">
          <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
            <span className="n-label">Risk posture</span>
            
          </div>
          <div className="px-4 pb-4 space-y-3">
            <div className="grid gap-4 lg:grid-cols-2">
              <MetricBlock label="Execution summary" value={snapshot.execution_summary} />
              <MetricBlock label="Exchange gate" value={snapshot.exchange_gate} />
              <MetricBlock label="Sentiment" value={formatNumber(snapshot.news_sentiment.sentiment_score)} />
              <MetricBlock label="Risk-off flag" value={snapshot.news_sentiment.risk_off ? "True" : "False"} />
            </div>
            <div className="px-3 py-3 text-[10px] leading-4" style={{background:"var(--card)",border:"1px solid var(--n-line)",color:"var(--muted-foreground)"}}>
              {snapshot.risk_notes.length > 0 ? snapshot.risk_notes.join(" • ") : "No additional risk notes were emitted in the current snapshot."}
            </div>
          </div>
        </div>

        <div className="n-card">
          <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
            <span className="n-label">Audit pressure</span>
            
          </div>
          <div className="px-4 pb-4 space-y-3">
            <RetentionBar label="Order intent retention" percent={retentionOrderPct} detail={`${operator.audit.retention.orderIntents.currentCount}/${operator.audit.retention.orderIntents.limit}`} />
            <RetentionBar label="Execution event retention" percent={retentionExecPct} detail={`${operator.audit.retention.executionEvents.currentCount}/${operator.audit.retention.executionEvents.limit}`} />
            <div className="space-y-3">
              {(operator.audit.incidents.length > 0 ? operator.audit.incidents : [{ id: 0, mode: snapshot.mode, message: "No active incidents in the audit feed." }]).slice(0, 6).map((incident) => (
                <div className=" border border-[var(--n-line)] bg-[var(--muted)] px-5 py-4 text-sm text-muted-foreground" key={`${incident.id}-${incident.message}`}>
                  <span className="font-medium text-foreground">{incident.mode}</span>
                  <span className="mx-2 text-border">/</span>
                  {incident.message}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="n-card">
        <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
          <span className="n-label">Overlay comparator</span>
          
        </div>
        <div className="px-4 pb-4">
          {operator.overlayCompare ? (
            <div className="space-y-3">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <MetricCard label="Promoted indicator" tone="neutral" value={operator.overlayCompare.promoted_indicator ?? "None"} compact />
                <MetricCard label="Changed candidates" tone={operator.overlayCompare.changed_candidates > 0 ? "positive" : "neutral"} value={String(operator.overlayCompare.changed_candidates)} compact />
                <MetricCard label="Approvals without" tone="neutral" value={String(operator.overlayCompare.approvals_without_overlay)} compact />
                <MetricCard label="Approvals with" tone="neutral" value={String(operator.overlayCompare.approvals_with_overlay)} compact />
              </div>
              <div className="n-card overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Scenario</TableHead>
                      <TableHead>Candidate</TableHead>
                      <TableHead>Decision</TableHead>
                      <TableHead>Confidence Δ</TableHead>
                      <TableHead>EV Δ</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {operator.overlayCompare.changes.map((change) => (
                      <TableRow key={`${change.scenario}-${change.family}` }>
                        <TableCell className="font-medium">{change.scenario}</TableCell>
                        <TableCell>{change.symbol} · {change.family}</TableCell>
                        <TableCell>{change.without_overlay.decision} → {change.with_overlay.decision}</TableCell>
                        <TableCell className={signedValueTextClass(change.delta.confidence_score)}>{formatSignedNumber(change.delta.confidence_score)}</TableCell>
                        <TableCell className={signedValueTextClass(change.delta.expected_value_score)}>{formatSignedNumber(change.delta.expected_value_score)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {operator.overlayEffect ? (
                <div className="space-y-4">
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                    <MetricCard label="Affected models" tone="neutral" value={String(operator.overlayEffect.affected_models)} compact />
                    <MetricCard label="Improving" tone={operator.overlayEffect.improving_candidates > 0 ? "positive" : "neutral"} value={String(operator.overlayEffect.improving_candidates)} compact />
                    <MetricCard label="Weakening" tone={operator.overlayEffect.weakening_candidates > 0 ? "negative" : "neutral"} value={String(operator.overlayEffect.weakening_candidates)} compact />
                    <MetricCard label="Flat" tone="neutral" value={String(operator.overlayEffect.flat_candidates)} compact />
                    <MetricCard label="Insufficient" tone="neutral" value={String(operator.overlayEffect.insufficient_candidates)} compact />
                  </div>
                  <div className="px-3 py-3 text-[10px] leading-4" style={{background:"var(--muted)",border:"1px solid var(--n-line)",color:"var(--muted-foreground)"}}>
                    This is observational, not counterfactual. It prefers exact indicator-attributed closed trades when they exist and falls back to model-attributed trades only when indicator history is not yet available.
                  </div>
                  <div className="space-y-3">
                    {operator.overlayEffect.candidates.map((candidate) => (
                      <div className="p-5" style={{background:"var(--card)"}} key={`${candidate.scenario}-${candidate.selected_model_id ?? candidate.family}`}>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-medium text-foreground">{candidate.scenario}</div>
                            <div className="mt-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">
                              {candidate.symbol} · {candidate.family} · {candidate.selected_model_id ?? "No model attribution"} · {candidate.selected_indicator_id ?? "No indicator attribution"}
                            </div>
                          </div>
                          <Badge className={cn(" border", candidate.quality_trend === "improving" ? toneClasses("good") : candidate.quality_trend === "weakening" ? toneClasses("risk") : toneClasses("warn"))} variant="outline">
                            {candidate.quality_trend}
                          </Badge>
                        </div>
                        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4 text-sm">
                          <MetricBlock label="Decision shift" value={`${candidate.without_decision} → ${candidate.with_decision}`} compact />
                          <MetricBlock label="Attribution" value={candidate.attribution_basis} compact />
                          <MetricBlock label="Trades matched" value={String(candidate.matched_trade_count)} compact />
                          <MetricBlock label="Exact indicator trades" value={String(candidate.exact_indicator_trade_count)} compact />
                          <MetricBlock label="Realized P&L" value={formatSignedUsd(candidate.realized_pnl_total)} compact />
                          <MetricBlock label="Win rate" value={candidate.win_rate === null ? "N/A" : formatPercent(candidate.win_rate)} compact />
                          <MetricBlock label="Confidence Δ" value={formatSignedNumber(candidate.confidence_delta)} compact tone={candidate.confidence_delta > 0 ? "positive" : candidate.confidence_delta < 0 ? "negative" : "neutral"} />
                          <MetricBlock label="EV Δ" value={formatSignedNumber(candidate.expected_value_delta)} compact tone={candidate.expected_value_delta > 0 ? "positive" : candidate.expected_value_delta < 0 ? "negative" : "neutral"} />
                          <MetricBlock label="Recent avg P&L" value={candidate.recent_average_pnl === null ? "N/A" : formatSignedUsd(candidate.recent_average_pnl)} compact />
                          <MetricBlock label="Prior avg P&L" value={candidate.prior_average_pnl === null ? "N/A" : formatSignedUsd(candidate.prior_average_pnl)} compact />
                        </div>
                        <div className="mt-3 text-[10px]" style={{color:"var(--muted-foreground)"}}>
                          {candidate.last_trade_at !== null
                            ? `Last ${candidate.attribution_basis === "indicator" ? "indicator" : candidate.attribution_basis === "model" ? "model" : "attributed"} trade ${formatTimestampMs(candidate.last_trade_at)}.`
                            : "No attributed trades have closed yet for this changed candidate."}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <EmptyState message="No comparator report is persisted yet. Run it from the Execution page." />
          )}
        </div>
      </div>
    </div>
  );
}

function ExecutionPage({
  botHealth,
  snapshot,
  operator,
  pendingOperatorAction,
  runOperatorAction,
  stopArmed,
  setStopArmed,
}: {
  botHealth: BotHealthReport;
  snapshot: RuntimeSnapshot;
  operator: DashboardOperatorData;
  pendingOperatorAction: OperatorAction | null;
  runOperatorAction: (action: OperatorAction, targetMode?: OperatorMode) => Promise<void>;
  stopArmed: boolean;
  setStopArmed: (value: boolean) => void;
}) {
  const openEntryTimesBySymbol = new Map(operator.audit.openPositionEntries.map((entry) => [entry.symbol, entry.entry_timestamp_ms]));
  const livePositions = snapshot.positions.map((position) => ({
    ...position,
    entryTimestampMs: openEntryTimesBySymbol.get(position.symbol) ?? null,
  }));

  return (
    <div className="space-y-3">
      <div className="grid gap-3 xl:grid-cols-[0.9fr_1.1fr]">
        <div className="n-card">
          <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
            <span className="n-label">Mode and control plane</span>
            
          </div>
          <div className="px-4 pb-4 space-y-3">
            {(() => {
              const modeDescriptions: Record<string, { label: string; desc: string }> = {
                Research: { label: "Research", desc: "No fills. Scores candidates and trains models in the background only." },
                Paper: { label: "Paper", desc: "Simulated fills at live prices. Full strategy execution without real capital." },
                Protected: { label: "Protected", desc: "Live capital, reduced size. Extra confluence required before any fill." },
                SemiAuto: { label: "Semi-auto", desc: "Live capital, full size. Operator confirms each order before submission." },
              };
              return (
                <div className="grid gap-3 sm:grid-cols-2">
                  {(["Research", "Paper", "Protected", "SemiAuto"] as OperatorMode[]).map((mode) => {
                    const isActive = snapshot.mode === mode;
                    const meta = modeDescriptions[mode]!;
                    return (
                      <button
                        className={cn(
                          "flex w-full flex-col items-start gap-1  border px-4 py-4 text-left transition-all",
                          isActive
                            ? "border-foreground/25 bg-foreground text-background shadow-(--shadow-card)"
                            : "border-[var(--n-line)] bg-muted/20 text-foreground hover:border-border hover:bg-muted/50",
                          pendingOperatorAction !== null && "cursor-not-allowed opacity-50",
                        )}
                        disabled={pendingOperatorAction !== null}
                        key={mode}
                        onClick={() => void runOperatorAction("set-mode", mode)}
                        type="button"
                      >
                        <div className="flex w-full items-center gap-2">
                          {isActive ? <Check className="size-3.5 shrink-0" /> : <Radar className="size-3.5 shrink-0 opacity-50" />}
                          <span className="text-sm font-semibold tracking-[-0.02em]">{meta.label}</span>
                          {isActive && <span className="ml-auto text-[9px] font-normal uppercase tracking-[0.2em] opacity-60">active</span>}
                        </div>
                        <p className={cn("text-[11px] leading-4", isActive ? "opacity-60" : "text-muted-foreground")}>{meta.desc}</p>
                      </button>
                    );
                  })}
                </div>
              );
            })()}
            <div className=" border border-[var(--n-line)] bg-muted/20 px-4 py-3 mb-1">
              <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Maintenance actions</p>
              <p className="mt-1 text-[10px]" style={{color:"var(--muted-foreground)"}}>These run once and report back to the event feed. Safe to run at any time without affecting live positions.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <ActionButton action="status" icon={Activity} label="Stack status" pendingOperatorAction={pendingOperatorAction} runOperatorAction={runOperatorAction} />
              <ActionButton action="overlay-compare" icon={BrainCircuit} label="Overlay compare" pendingOperatorAction={pendingOperatorAction} runOperatorAction={runOperatorAction} />
              <ActionButton action="prune-indicators" icon={Trash2} label="Prune weak indicators" pendingOperatorAction={pendingOperatorAction} runOperatorAction={runOperatorAction} />
              <ActionButton action="export-audit" icon={Download} label="Export audit" pendingOperatorAction={pendingOperatorAction} runOperatorAction={runOperatorAction} />
              <ActionButton action="compact-audit-db" icon={Gauge} label="Compact audit DB" pendingOperatorAction={pendingOperatorAction} runOperatorAction={runOperatorAction} />
              <ActionButton action="prune-legacy-incidents" icon={ShieldCheck} label="Normalize incidents" pendingOperatorAction={pendingOperatorAction} runOperatorAction={runOperatorAction} />
              <ActionButton action="clear-maintenance-history" icon={Eraser} label="Clear maint. history" pendingOperatorAction={pendingOperatorAction} runOperatorAction={runOperatorAction} />
              <Button className="justify-start px-4 py-5" disabled={pendingOperatorAction !== null} onClick={() => void runOperatorAction("restart-supervisor")} variant="secondary">
                <RotateCcw className={cn("size-4", pendingOperatorAction === "restart-supervisor" && "animate-spin")} />
                Restart supervisor
              </Button>
              <Button
                className="justify-start px-4 py-5"
                disabled={pendingOperatorAction !== null}
                onClick={() => {
                  if (!stopArmed) {
                    setStopArmed(true);
                    return;
                  }

                  void runOperatorAction("stop-supervisor");
                }}
                variant="destructive"
              >
                <OctagonX className="size-4" />
                {stopArmed ? "Confirm stop" : "Emergency stop"}
              </Button>
            </div>
            {stopArmed ? (
              <div className=" border border-(--danger-border) bg-(--danger-surface) px-5 py-4 text-sm text-(--danger-foreground)">
                Emergency stop is armed for 6 seconds.
              </div>
            ) : null}
            <div className="p-5" style={{background:"var(--card)"}}>
              <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Live execution posture</div>
              {livePositions.length === 0 ? (
                <div className="mt-2 text-[10px] leading-4" style={{color:"var(--muted-foreground)"}}>No live positions are open, so execution actions are currently operating from a flat book.</div>
              ) : (
                <div className="mt-4 space-y-4">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <MetricBlock label="Open positions" value={String(livePositions.length)} compact />
                    <MetricBlock label="Largest notional" value={formatUsd(Math.max(...livePositions.map((position) => position.notional_usd)))} compact />
                    <MetricBlock label="Oldest hold" value={formatOldestHold(livePositions.map((position) => position.entryTimestampMs))} compact />
                  </div>
                  <div className="space-y-3">
                    {livePositions.slice(0, 4).map((position) => (
                      <div className=" border border-[var(--n-line)] bg-background/80 px-5 py-4 text-sm" key={position.symbol}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium text-foreground">{position.symbol}</span>
                          <span className="text-muted-foreground">{formatNumber(position.quantity, 4)} @ {formatUsd(position.entry_price, 2)}</span>
                        </div>
                        <div className="mt-1 text-muted-foreground">
                          {position.entryTimestampMs !== null
                            ? `Open ${formatRelativeDuration(position.entryTimestampMs)} from ${formatTimestampMs(position.entryTimestampMs)} with ${formatSignedUsd(position.unrealized_pnl)} unrealized.`
                            : `Open time unavailable. Current unrealized P&L is ${formatSignedUsd(position.unrealized_pnl)}.`}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div className="n-card">
            <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <span className="n-label">Runtime health</span>
                  
                </div>
                <BotHealthBadge health={botHealth} prominent />
              </div>
            </div>
            <div className="px-4 pb-4 space-y-4">
              <div className="p-5 text-xs leading-5" style={{background:"var(--card)"}}>{botHealth.summary}</div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <MetricBlock compact label="Paper posture" tone={botHealth.paper_ready ? "positive" : "negative"} value={botHealth.paper_status} />
                <MetricBlock compact label="Week monitor" tone={botHealth.monitor_fresh ? "positive" : "negative"} value={botHealth.monitor_status} />
                <MetricBlock compact label="Execution proof" tone={botHealth.recent_paper_entry ? (botHealth.recent_paper_exit ? "positive" : "neutral") : "negative"} value={botHealth.execution_status} />
                <MetricBlock compact label="Pending mode" tone={botHealth.pending_mode_request ? "negative" : "neutral"} value={botHealth.pending_mode_request ?? "None"} />
                <MetricBlock compact label="Snapshot updated" value={botHealth.last_snapshot_at ? formatOperatorTimestamp(botHealth.last_snapshot_at) : "No data"} />
                <MetricBlock compact label="Last monitor check" value={formatHealthTimestamp(botHealth.last_monitor_check_at_ms)} />
                <MetricBlock compact label="Last paper fill" value={formatHealthTimestamp(botHealth.last_paper_entry_at_ms)} tone={botHealth.recent_paper_entry ? "positive" : "negative"} />
                <MetricBlock compact label="Last paper close" value={formatHealthTimestamp(botHealth.last_paper_exit_at_ms)} tone={botHealth.recent_paper_exit ? "positive" : "neutral"} />
              </div>
              <div className="space-y-3">
                {botHealth.reasons.slice(0, 4).map((reason) => (
                  <div className=" border border-[var(--n-line)] bg-background/80 px-4 py-3 text-[10px] leading-4" style={{color:"var(--muted-foreground)"}} key={reason}>{reason}</div>
                ))}
                {botHealth.last_alert_message ? (
                  <div className=" border border-(--warning-border) bg-(--warning-surface) px-4 py-3 text-sm leading-6 text-(--warning-foreground)">
                    Latest monitor alert: {botHealth.last_alert_message}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="n-card">
            <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
              <span className="n-label">Operator event feed</span>
              
            </div>
            <div className="px-4 pb-4 space-y-3">
              {operator.events.length === 0 ? (
                <EmptyState message="No operator events are available." />
              ) : (
                operator.events.map((event) => (
                  <div className=" border border-[var(--n-line)] bg-[var(--muted)] p-4" key={event.id}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className={cn("border", toneClasses(event.level))} variant="outline">{event.level}</Badge>
                      <span className="text-sm font-medium text-foreground">{event.action}</span>
                      <span className="text-[10px]" style={{color:"var(--muted-foreground)"}}>{formatOperatorTimestamp(event.timestamp)}</span>
                    </div>
                    <div className="mt-2 text-sm text-foreground">{event.message}</div>
                    {event.detail ? <div className="mt-1 text-[10px] leading-4" style={{color:"var(--muted-foreground)"}}>{event.detail}</div> : null}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReviewPage({
  tradeSummary,
  mistakes,
  exactCoverage,
}: {
  tradeSummary: DashboardOperatorData["audit"]["tradeSummary"];
  mistakes: Array<{ title: string; why: string }>;
  exactCoverage: number | null;
}) {
  const symbolOptions = Array.from(new Set(tradeSummary.tradeHistory.map((trade) => trade.symbol))).sort();
  const modelOptions = Array.from(new Set(tradeSummary.tradeHistory.map((trade) => trade.model_id))).sort();
  const familyOptions = Array.from(new Set(tradeSummary.tradeHistory.map((trade) => parseTradeModelScope(trade.model_scope).family))).sort();
  const regimeOptions = Array.from(new Set(tradeSummary.tradeHistory.map((trade) => parseTradeModelScope(trade.model_scope).regime))).sort();
  const closeReasonOptions = Array.from(new Set(tradeSummary.tradeHistory.map((trade) => trade.close_reason))).sort();
  const [symbolFilter, setSymbolFilter] = useState<string>("All");
  const [modelFilter, setModelFilter] = useState<string>("All");
  const [familyFilter, setFamilyFilter] = useState<string>("All");
  const [regimeFilter, setRegimeFilter] = useState<string>("All");
  const [closeReasonFilter, setCloseReasonFilter] = useState<string>("All");
  const [sideFilter, setSideFilter] = useState<string>("All");
  const [sourceFilter, setSourceFilter] = useState<string>("All");
  const [holdFilter, setHoldFilter] = useState<string>("All");
  const [dateRangeFilter, setDateRangeFilter] = useState<string>("All");
  const [customStartDate, setCustomStartDate] = useState<string>("");
  const [customEndDate, setCustomEndDate] = useState<string>("");
  const [sortBy, setSortBy] = useState<string>("newest");
  const [reviewData, setReviewData] = useState<{
    summary: ReturnType<typeof summarizeReviewTrades>;
    fullBookSummary: ReturnType<typeof summarizeReviewTrades>;
    comparison: {
      averageHoldDurationMs: number | null;
      fullBookAverageHoldDurationMs: number | null;
    };
    equityCurve: Array<{ tradeId: number; timestamp_ms: number; cumulativePnl: number; visibleIndex: number }>;
    trades: Array<AuditClosedTrade & {
      hold_duration_ms: number | null;
      model_scope_parts: { symbol: string; family: string; regime: string };
    }>;
  } | null>(null);
  const [sliceRankings, setSliceRankings] = useState<{
    best: Array<{
      key: string;
      modelId: string;
      family: string;
      regime: string;
      tradeCount: number;
      realizedPnlTotal: number;
      expectancyPerTrade: number | null;
      winRate: number | null;
      profitFactor: number | null;
      averageWinPnl: number | null;
      averageLossPnl: number | null;
      exactCoverageRate: number | null;
    }>;
    worst: Array<{
      key: string;
      modelId: string;
      family: string;
      regime: string;
      tradeCount: number;
      realizedPnlTotal: number;
      expectancyPerTrade: number | null;
      winRate: number | null;
      profitFactor: number | null;
      averageWinPnl: number | null;
      averageLossPnl: number | null;
      exactCoverageRate: number | null;
    }>;
  }>({ best: [], worst: [] });
  const [selectedTrade, setSelectedTrade] = useState<(AuditClosedTrade & {
    hold_duration_ms: number | null;
    model_scope_parts: { symbol: string; family: string; regime: string };
  }) | null>(null);
  const [isReviewLoading, setIsReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [exportState, setExportState] = useState<string | null>(null);
  const [inspectedSliceKey, setInspectedSliceKey] = useState<string | null>(null);
  const [selectedTradeId, setSelectedTradeId] = useState<number | null>(null);

  const reviewDateRange = resolveReviewDateRange(dateRangeFilter, customStartDate, customEndDate);

  function buildReviewSearchParams() {
    const params = new URLSearchParams({
      symbol: symbolFilter,
      model: modelFilter,
      family: familyFilter,
      regime: regimeFilter,
      closeReason: closeReasonFilter,
      side: sideFilter,
      source: sourceFilter,
      hold: holdFilter,
      dateRange: dateRangeFilter,
      startDate: customStartDate,
      endDate: customEndDate,
      sortBy,
      limit: "100",
    });

    return params;
  }

  useEffect(() => {
    let cancelled = false;

    async function loadReviewData() {
      setIsReviewLoading(true);
      setReviewError(null);

      try {
        const params = buildReviewSearchParams();
        const [queryResponse, rankedResponse] = await Promise.all([
          fetch(`/api/review/slice/query?${params.toString()}`, { cache: "no-store" }),
          fetch(`/api/review/slices/ranked?${params.toString()}`, { cache: "no-store" }),
        ]);

        if (!queryResponse.ok) {
          throw new Error(`Review query failed with HTTP ${queryResponse.status}`);
        }

        if (!rankedResponse.ok) {
          throw new Error(`Review rankings failed with HTTP ${rankedResponse.status}`);
        }

        const queryPayload = await queryResponse.json() as {
          summary: ReturnType<typeof summarizeReviewTrades>;
          full_book_summary: ReturnType<typeof summarizeReviewTrades>;
          comparison: {
            average_hold_duration_ms: number | null;
            full_book_average_hold_duration_ms: number | null;
          };
          equity_curve: Array<{ trade_id: number; timestamp_ms: number; cumulative_pnl: number; visible_index: number }>;
          trades: Array<AuditClosedTrade & {
            hold_duration_ms: number | null;
            model_scope_parts: { symbol: string; family: string; regime: string };
          }>;
        };
        const rankedPayload = await rankedResponse.json() as {
          ranked_slices: {
            best: Array<{
              key: string;
              model_id: string;
              family: string;
              regime: string;
              trade_count: number;
              realized_pnl_total: number;
              expectancy_per_trade: number | null;
              win_rate: number | null;
              profit_factor: number | null;
              average_win_pnl: number | null;
              average_loss_pnl: number | null;
              exact_coverage_rate: number | null;
            }>;
            worst: Array<{
              key: string;
              model_id: string;
              family: string;
              regime: string;
              trade_count: number;
              realized_pnl_total: number;
              expectancy_per_trade: number | null;
              win_rate: number | null;
              profit_factor: number | null;
              average_win_pnl: number | null;
              average_loss_pnl: number | null;
              exact_coverage_rate: number | null;
            }>;
          };
        };

        if (cancelled) {
          return;
        }

        setReviewData({
          summary: queryPayload.summary,
          fullBookSummary: queryPayload.full_book_summary,
          comparison: {
            averageHoldDurationMs: queryPayload.comparison.average_hold_duration_ms,
            fullBookAverageHoldDurationMs: queryPayload.comparison.full_book_average_hold_duration_ms,
          },
          equityCurve: queryPayload.equity_curve.map((point) => ({
            tradeId: point.trade_id,
            timestamp_ms: point.timestamp_ms,
            cumulativePnl: point.cumulative_pnl,
            visibleIndex: point.visible_index,
          })),
          trades: queryPayload.trades,
        });
        setSliceRankings({
          best: rankedPayload.ranked_slices.best.map((slice) => ({
            key: slice.key,
            modelId: slice.model_id,
            family: slice.family,
            regime: slice.regime,
            tradeCount: slice.trade_count,
            realizedPnlTotal: slice.realized_pnl_total,
            expectancyPerTrade: slice.expectancy_per_trade,
            winRate: slice.win_rate,
            profitFactor: slice.profit_factor,
            averageWinPnl: slice.average_win_pnl,
            averageLossPnl: slice.average_loss_pnl,
            exactCoverageRate: slice.exact_coverage_rate,
          })),
          worst: rankedPayload.ranked_slices.worst.map((slice) => ({
            key: slice.key,
            modelId: slice.model_id,
            family: slice.family,
            regime: slice.regime,
            tradeCount: slice.trade_count,
            realizedPnlTotal: slice.realized_pnl_total,
            expectancyPerTrade: slice.expectancy_per_trade,
            winRate: slice.win_rate,
            profitFactor: slice.profit_factor,
            averageWinPnl: slice.average_win_pnl,
            averageLossPnl: slice.average_loss_pnl,
            exactCoverageRate: slice.exact_coverage_rate,
          })),
        });
      } catch (error) {
        if (!cancelled) {
          setReviewError(error instanceof Error ? error.message : "Review query failed.");
        }
      } finally {
        if (!cancelled) {
          setIsReviewLoading(false);
        }
      }
    }

    void loadReviewData();

    return () => {
      cancelled = true;
    };
  }, [symbolFilter, modelFilter, familyFilter, regimeFilter, closeReasonFilter, sideFilter, sourceFilter, holdFilter, dateRangeFilter, customStartDate, customEndDate, sortBy]);

  useEffect(() => {
    let cancelled = false;

    async function loadSelectedTrade() {
      if (selectedTradeId === null) {
        setSelectedTrade(null);
        return;
      }

      try {
        const response = await fetch(`/api/review/trades/${selectedTradeId}`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Trade inspection failed with HTTP ${response.status}`);
        }

        const payload = await response.json() as {
          trade: AuditClosedTrade & {
            hold_duration_ms: number | null;
            model_scope_parts: { symbol: string; family: string; regime: string };
          };
        };

        if (!cancelled) {
          setSelectedTrade(payload.trade);
        }
      } catch {
        if (!cancelled) {
          setSelectedTrade(null);
        }
      }
    }

    void loadSelectedTrade();

    return () => {
      cancelled = true;
    };
  }, [selectedTradeId]);

  const filteredTrades = reviewData?.trades ?? [];
  const reviewMetrics = reviewData?.summary ?? summarizeReviewTrades([]);
  const overallMetrics = reviewData?.fullBookSummary ?? summarizeReviewTrades(tradeSummary.tradeHistory);
  const filteredEquityCurve = reviewData?.equityCurve ?? [];
  type ReviewSlice = (typeof sliceRankings.best)[number];
  const isFocusedSlice = modelFilter !== "All" || familyFilter !== "All" || regimeFilter !== "All";
  const currentSliceLabel = [modelFilter, familyFilter, regimeFilter].filter((value) => value !== "All").join(" · ") || "All trades";
  const rankedSlices = [...sliceRankings.best, ...sliceRankings.worst].reduce<ReviewSlice[]>((allSlices, slice) => {
    if (allSlices.some((candidate) => candidate.key === slice.key)) {
      return allSlices;
    }
    allSlices.push(slice);
    return allSlices;
  }, []);
  const inspectedSlice = rankedSlices.find((slice) => slice.key === inspectedSliceKey) ?? null;
  const inspectedSliceTrades = inspectedSlice
    ? [...tradeSummary.tradeHistory]
      .filter((trade) => trade.model_id === inspectedSlice.modelId)
      .filter((trade) => parseTradeModelScope(trade.model_scope).family === inspectedSlice.family)
      .filter((trade) => parseTradeModelScope(trade.model_scope).regime === inspectedSlice.regime)
      .sort((left, right) => right.timestamp_ms - left.timestamp_ms)
    : [];
  const selectedCurvePoint = selectedTrade === null ? null : filteredEquityCurve.find((point) => point.tradeId === selectedTrade.id) ?? null;
  const selectedTradeIndexOnCurve = selectedCurvePoint?.visibleIndex ?? -1;
  const selectedTradeCumulativePnl = selectedCurvePoint?.cumulativePnl ?? null;
  const tradeDurationsMs = filteredTrades
    .map((trade) => trade.hold_duration_ms)
    .filter((durationMs): durationMs is number => durationMs !== null && durationMs >= 0);
  const averageTradeDurationMs = reviewData?.comparison.averageHoldDurationMs ?? null;
  const longestTradeDurationMs = tradeDurationsMs.length > 0 ? Math.max(...tradeDurationsMs) : null;
  const overallTradeDurationsMs = tradeSummary.tradeHistory
    .filter((trade) => trade.entry_timestamp_ms !== null)
    .map((trade) => trade.timestamp_ms - (trade.entry_timestamp_ms ?? trade.timestamp_ms))
    .filter((durationMs) => durationMs >= 0);
  const overallAverageTradeDurationMs = reviewData?.comparison.fullBookAverageHoldDurationMs
    ?? (overallTradeDurationsMs.length > 0
      ? overallTradeDurationsMs.reduce((total, durationMs) => total + durationMs, 0) / overallTradeDurationsMs.length
      : null);

  function isSliceActive(slice: ReviewSlice) {
    return modelFilter === slice.modelId && familyFilter === slice.family && regimeFilter === slice.regime;
  }

  async function applyReviewSlice(slice: ReviewSlice) {
    setInspectedSliceKey(slice.key);
    try {
      const response = await fetch("/api/review/slices/apply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ slice_key: slice.key }),
      });

      if (!response.ok) {
        throw new Error(`Apply slice failed with HTTP ${response.status}`);
      }

      const payload = await response.json() as {
        filters: {
          modelFilter: string;
          familyFilter: string;
          regimeFilter: string;
          symbolFilter: string;
          closeReasonFilter: string;
          sideFilter: string;
          sourceFilter: string;
          holdFilter: string;
          dateRangeFilter: string;
          customStartDate: string;
          customEndDate: string;
          sortBy: string;
        };
      };

      setSymbolFilter(payload.filters.symbolFilter);
      setModelFilter(payload.filters.modelFilter);
      setFamilyFilter(payload.filters.familyFilter);
      setRegimeFilter(payload.filters.regimeFilter);
      setCloseReasonFilter(payload.filters.closeReasonFilter);
      setSideFilter(payload.filters.sideFilter);
      setSourceFilter(payload.filters.sourceFilter);
      setHoldFilter(payload.filters.holdFilter);
      setDateRangeFilter(payload.filters.dateRangeFilter);
      setCustomStartDate(payload.filters.customStartDate);
      setCustomEndDate(payload.filters.customEndDate);
      setSortBy(payload.filters.sortBy);
    } catch {
      setSymbolFilter("All");
      setModelFilter(slice.modelId);
      setFamilyFilter(slice.family);
      setRegimeFilter(slice.regime);
      setCloseReasonFilter("All");
      setSideFilter("All");
      setSourceFilter("All");
      setHoldFilter("All");
      setDateRangeFilter("All");
      setCustomStartDate("");
      setCustomEndDate("");
      setSortBy("newest");
    }
  }

  function toggleInspectedSlice(slice: ReviewSlice) {
    setInspectedSliceKey((current) => current === slice.key ? null : slice.key);
  }

  function focusReviewTrade(trade: AuditClosedTrade, slice?: ReviewSlice) {
    if (slice) {
      void applyReviewSlice(slice);
    }
    setSelectedTradeId(trade.id);
  }

  async function exportFilteredTradesCsv() {
    if (filteredTrades.length === 0) {
      return;
    }

    setExportState("Exporting current review slice...");

    try {
      const response = await fetch(`/api/review/slice/export?${buildReviewSearchParams().toString()}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Export failed with HTTP ${response.status}`);
      }

      const payload = await response.json() as {
        export: {
          file_name: string;
          row_count: number;
        };
      };
      setExportState(`Exported ${payload.export.row_count} rows to ${payload.export.file_name}.`);
    } catch (error) {
      setExportState(error instanceof Error ? error.message : "Export failed.");
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.04fr)_minmax(0,0.96fr)]">
        <div className="n-card">
          <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
            <span className="n-label">Realized equity curve</span>
            
          </div>
          <div className="px-4 pb-4 space-y-3">
            <div className="grid gap-4 md:grid-cols-3">
              <MetricBlock compact label="Curve points" value={String(filteredEquityCurve.length)} />
              <MetricBlock compact label="Slice net P&L" value={formatSignedUsd(reviewMetrics.realizedPnlTotal)} />
              <MetricBlock compact label="Slice range" value={formatReviewDateRangeSummary(reviewDateRange, filteredTrades)} />
            </div>
            <EquityCurve points={filteredEquityCurve} selectedTrade={selectedTrade === null || selectedTradeIndexOnCurve < 0 ? null : {
              label: `${selectedTrade.symbol} ${selectedTrade.side}`,
              realizedPnl: selectedTrade.realized_pnl,
              timestampMs: selectedTrade.timestamp_ms,
              visibleIndex: selectedTradeIndexOnCurve,
            }} />
            {selectedTrade ? (
              <div className={cn(" border px-5 py-4 text-sm", selectedTradeIndexOnCurve >= 0 ? "border-[var(--n-line)] bg-[var(--muted)]" : "border-(--warning-border) bg-(--warning-surface) text-(--warning-foreground)")}>
                <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Selected trade context</div>
                {selectedTradeIndexOnCurve >= 0 ? (
                  <div className="mt-3 leading-6 text-muted-foreground">
                    <span className="font-medium text-foreground">{selectedTrade.symbol}</span> {selectedTrade.side.toLowerCase()} closed at {formatTimestampMs(selectedTrade.timestamp_ms)} for {formatSignedUsd(selectedTrade.realized_pnl)}.
                    {" "}This is visible trade {selectedTradeIndexOnCurve + 1} of {filteredEquityCurve.length} on the current equity curve, with cumulative slice P&amp;L at {formatSignedUsd(selectedTradeCumulativePnl)} after close.
                  </div>
                ) : (
                  <div className="mt-3 leading-6 text-muted-foreground">
                    <span className="font-medium text-foreground">{selectedTrade.symbol}</span> is selected, but it is outside the currently filtered equity view. Apply the relevant slice or loosen filters to place it back on the active curve.
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>

        <div className="n-card">
          <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
            <span className="n-label">Review guardrails</span>
            
          </div>
          <div className="px-4 pb-4 space-y-3">
            <MetricBlock label="Filtered trades" value={String(reviewMetrics.closedTrades)} />
            <MetricBlock label="Exact coverage" value={formatPercent(reviewMetrics.exactCoverageRate ?? exactCoverage, 0)} />
            <MetricBlock label="Average win" value={formatSignedUsd(reviewMetrics.averageWinPnl)} />
            <MetricBlock label="Average loss" value={formatSignedUsd(reviewMetrics.averageLossPnl)} />
            <MetricBlock label="Avg P&L ratio" value={formatSignedNumber(reviewMetrics.averagePnlRatio)} />
            <MetricBlock label="Avg hold" value={formatDurationMs(averageTradeDurationMs)} />
            <MetricBlock label="Longest hold" value={formatDurationMs(longestTradeDurationMs)} />
            <div className="px-3 py-3 text-[10px] leading-4" style={{background:"var(--card)",border:"1px solid var(--n-line)",color:"var(--muted-foreground)"}}>
              {reviewError
                ? `Review API degraded: ${reviewError}`
                : (reviewMetrics.exactCoverageRate ?? exactCoverage) !== null && (reviewMetrics.exactCoverageRate ?? exactCoverage)! < 0.6
                ? "A large portion of the trade review is still estimated. Do not overfit strategy decisions to incomplete closures."
                : reviewMetrics.closedTrades === 0
                  ? "The current filter slice has no matching trades, so there is nothing defensible to analyze yet."
                  : "Exact trade coverage is sufficient to trust the current filtered review metrics more heavily."}
            </div>
          </div>
        </div>
      </div>

      <div className="n-card">
        <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
          <span className="n-label">Slice versus full book</span>
          
        </div>
        <div className="px-4 pb-4 space-y-3">
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
            <div className="bg-[var(--muted)] p-5" style={{border:"1px solid var(--n-line)"}}>
              <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Current slice</div>
              <div className="mt-2 text-sm font-medium text-foreground">{currentSliceLabel}</div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <MetricBlock compact label="Trades" value={String(reviewMetrics.closedTrades)} />
                <MetricBlock compact label="Net P&L" value={formatSignedUsd(reviewMetrics.realizedPnlTotal)} />
                <MetricBlock compact label="Expectancy" value={formatSignedUsd(reviewMetrics.expectancyPerTrade)} />
                <MetricBlock compact label="Win rate" value={formatPercent(reviewMetrics.winRate, 1)} />
                <MetricBlock compact label="Profit factor" value={formatNumber(reviewMetrics.profitFactor)} />
                <MetricBlock compact label="Avg hold" value={formatDurationMs(averageTradeDurationMs)} />
              </div>
            </div>

            <div className="hidden items-center justify-center lg:flex">
              <div className=" border border-[var(--n-line)] bg-background px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Vs</div>
            </div>

            <div className="bg-muted/10 p-5" style={{border:"1px solid var(--n-line)"}}>
              <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Full book</div>
              <div className="mt-2 text-sm font-medium text-foreground">All closed trades</div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <MetricBlock compact label="Trades" value={String(overallMetrics.closedTrades)} />
                <MetricBlock compact label="Net P&L" value={formatSignedUsd(overallMetrics.realizedPnlTotal)} />
                <MetricBlock compact label="Expectancy" value={formatSignedUsd(overallMetrics.expectancyPerTrade)} />
                <MetricBlock compact label="Win rate" value={formatPercent(overallMetrics.winRate, 1)} />
                <MetricBlock compact label="Profit factor" value={formatNumber(overallMetrics.profitFactor)} />
                <MetricBlock compact label="Avg hold" value={formatDurationMs(overallAverageTradeDurationMs)} />
              </div>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
            <MetricBlock compact label="P&L edge" tone={(reviewMetrics.realizedPnlTotal ?? 0) >= (overallMetrics.realizedPnlTotal ?? 0) ? "positive" : "negative"} value={formatSignedUsd((reviewMetrics.realizedPnlTotal ?? 0) - (overallMetrics.realizedPnlTotal ?? 0))} />
            <MetricBlock compact label="Expectancy edge" tone={(reviewMetrics.expectancyPerTrade ?? 0) >= (overallMetrics.expectancyPerTrade ?? 0) ? "positive" : "negative"} value={formatSignedUsd((reviewMetrics.expectancyPerTrade ?? 0) - (overallMetrics.expectancyPerTrade ?? 0), 3)} />
            <MetricBlock compact label="Win-rate edge" tone={(reviewMetrics.winRate ?? 0) >= (overallMetrics.winRate ?? 0) ? "positive" : "negative"} value={formatPercentDelta((reviewMetrics.winRate ?? 0) - (overallMetrics.winRate ?? 0), 1)} />
            <MetricBlock compact label="Profit-factor edge" tone={(reviewMetrics.profitFactor ?? 0) >= (overallMetrics.profitFactor ?? 0) ? "positive" : "negative"} value={formatSignedNumber((reviewMetrics.profitFactor ?? 0) - (overallMetrics.profitFactor ?? 0), 2)} />
            <MetricBlock compact label="Hold delta" tone={resolveHoldDeltaTone(averageTradeDurationMs, overallAverageTradeDurationMs)} value={formatDurationDelta(averageTradeDurationMs, overallAverageTradeDurationMs)} />
          </div>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-[1.04fr_0.96fr]">
        <div className="n-card">
          <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
            <span className="n-label">Slice rankings</span>
            
          </div>
          <div className="px-4 pb-4 grid gap-3 2xl:grid-cols-2">
            <div className="space-y-4">
              <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Best slices</div>
              {sliceRankings.best.length === 0 ? (
                <EmptyState message="Not enough filtered trades to rank slice quality yet." />
              ) : (
                sliceRankings.best.map((slice) => {
                  const active = isSliceActive(slice);

                  return (
                  <div className={cn("min-w-0  border p-5 transition-colors", active ? "border-(--success-border) bg-(--success-surface) shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--success-border)_70%,transparent_30%)]" : "border-[color-mix(in_srgb,var(--success-border)_72%,transparent_28%)] bg-[color-mix(in_srgb,var(--success-surface)_82%,transparent_18%)]")} key={`best-${slice.key}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-foreground">{slice.modelId}</div>
                        <div className="mt-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">{formatStrategyFamily(slice.family)} · {slice.regime}</div>
                      </div>
                      <Badge className=" border border-(--success-border) bg-transparent text-(--success-foreground)" variant="outline">
                        {slice.tradeCount} trades
                      </Badge>
                    </div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2 text-sm text-muted-foreground">
                      <MetricBlock compact label="Net P&L" value={formatSignedUsd(slice.realizedPnlTotal)} />
                      <MetricBlock compact label="Expectancy" value={formatSignedUsd(slice.expectancyPerTrade)} />
                      <MetricBlock compact label="Win rate" value={formatPercent(slice.winRate, 1)} />
                      <MetricBlock compact label="Profit factor" value={formatNumber(slice.profitFactor)} />
                    </div>
                    <div className="mt-4 border border-[var(--n-line)] bg-background/70 px-4 py-3">
                      <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">Why it ranks here</div>
                      <div className="mt-2.5 space-y-1.5">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="text-muted-foreground">Avg win</span>
                          <span className="font-medium text-foreground">{formatSignedUsd(slice.averageWinPnl)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="text-muted-foreground">Avg loss</span>
                          <span className="font-medium text-foreground">{formatSignedUsd(slice.averageLossPnl)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="text-muted-foreground">Exact fills</span>
                          <span className={cn("font-medium", (slice.exactCoverageRate ?? 0) >= 0.7 ? "text-(--success-foreground)" : (slice.exactCoverageRate ?? 0) >= 0.4 ? "text-foreground" : "text-(--danger-foreground)")}>{formatPercent(slice.exactCoverageRate, 0)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                      <div className={cn("text-xs", active ? "text-(--success-foreground)" : "text-muted-foreground")}>
                        {active ? "Current review slice" : "Apply and clear conflicting filters"}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          className="rounded-2xl"
                          onClick={() => toggleInspectedSlice(slice)}
                          size="sm"
                          variant="secondary"
                        >
                          {inspectedSliceKey === slice.key ? "Hide trades" : "Inspect trades"}
                        </Button>
                        <Button
                          className="rounded-2xl"
                          disabled={active}
                          onClick={() => void applyReviewSlice(slice)}
                          size="sm"
                          variant="outline"
                        >
                          {active ? "Applied" : "Apply slice"}
                        </Button>
                      </div>
                    </div>
                  </div>
                )})
              )}
            </div>
            <div className="space-y-4">
              <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Weakest slices</div>
              {sliceRankings.worst.length === 0 ? (
                <EmptyState message="Not enough filtered trades to identify weak slices yet." />
              ) : (
                sliceRankings.worst.map((slice) => {
                  const active = isSliceActive(slice);

                  return (
                  <div className={cn("min-w-0  border p-5 transition-colors", active ? "border-(--danger-border) bg-(--danger-surface) shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--danger-border)_70%,transparent_30%)]" : "border-[color-mix(in_srgb,var(--danger-border)_72%,transparent_28%)] bg-[color-mix(in_srgb,var(--danger-surface)_82%,transparent_18%)]")} key={`worst-${slice.key}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-foreground">{slice.modelId}</div>
                        <div className="mt-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">{formatStrategyFamily(slice.family)} · {slice.regime}</div>
                      </div>
                      <Badge className=" border border-(--danger-border) bg-transparent text-(--danger-foreground)" variant="outline">
                        {slice.tradeCount} trades
                      </Badge>
                    </div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2 text-sm text-muted-foreground">
                      <MetricBlock compact label="Net P&L" value={formatSignedUsd(slice.realizedPnlTotal)} />
                      <MetricBlock compact label="Expectancy" value={formatSignedUsd(slice.expectancyPerTrade)} />
                      <MetricBlock compact label="Win rate" value={formatPercent(slice.winRate, 1)} />
                      <MetricBlock compact label="Profit factor" value={formatNumber(slice.profitFactor)} />
                    </div>
                    <div className="mt-4 border border-[var(--n-line)] bg-background/70 px-4 py-3">
                      <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">Why it ranks here</div>
                      <div className="mt-2.5 space-y-1.5">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="text-muted-foreground">Avg win</span>
                          <span className="font-medium text-foreground">{formatSignedUsd(slice.averageWinPnl)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="text-muted-foreground">Avg loss</span>
                          <span className="font-medium text-foreground">{formatSignedUsd(slice.averageLossPnl)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="text-muted-foreground">Exact fills</span>
                          <span className={cn("font-medium", (slice.exactCoverageRate ?? 0) >= 0.7 ? "text-(--success-foreground)" : (slice.exactCoverageRate ?? 0) >= 0.4 ? "text-foreground" : "text-(--danger-foreground)")}>{formatPercent(slice.exactCoverageRate, 0)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                      <div className={cn("text-xs", active ? "text-(--danger-foreground)" : "text-muted-foreground")}>
                        {active ? "Current review slice" : "Apply and clear conflicting filters"}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          className="rounded-2xl"
                          onClick={() => toggleInspectedSlice(slice)}
                          size="sm"
                          variant="secondary"
                        >
                          {inspectedSliceKey === slice.key ? "Hide trades" : "Inspect trades"}
                        </Button>
                        <Button
                          className="rounded-2xl"
                          disabled={active}
                          onClick={() => void applyReviewSlice(slice)}
                          size="sm"
                          variant="outline"
                        >
                          {active ? "Applied" : "Apply slice"}
                        </Button>
                      </div>
                    </div>
                  </div>
                )})
              )}
            </div>
            {inspectedSlice ? (
              <div className="2xl:col-span-2 border border-[var(--n-line)] bg-muted/20 p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Inspected slice</div>
                    <div className="mt-2 text-sm font-medium text-foreground">{inspectedSlice.modelId} · {inspectedSlice.family} · {inspectedSlice.regime}</div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      {inspectedSliceTrades.length} trade{inspectedSliceTrades.length === 1 ? "" : "s"} across the full closed-trade history for this model family and regime.
                    </div>
                  </div>
                  <Button className="rounded-2xl" onClick={() => setInspectedSliceKey(null)} size="sm" variant="outline">
                    Close drill-down
                  </Button>
                </div>
                <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <MetricBlock compact label="Net P&L" value={formatSignedUsd(inspectedSlice.realizedPnlTotal)} />
                  <MetricBlock compact label="Expectancy" value={formatSignedUsd(inspectedSlice.expectancyPerTrade)} />
                  <MetricBlock compact label="Win rate" value={formatPercent(inspectedSlice.winRate, 1)} />
                  <MetricBlock compact label="Exact fills" value={formatPercent(inspectedSlice.exactCoverageRate, 0)} tone={(inspectedSlice.exactCoverageRate ?? 0) >= 0.7 ? "positive" : (inspectedSlice.exactCoverageRate ?? 0) >= 0.4 ? "neutral" : "negative"} />
                </div>
                {inspectedSliceTrades.length === 0 ? (
                  <div className="mt-4">
                    <EmptyState message="No trades are available for this slice yet." />
                  </div>
                ) : (
                  <div className="mt-5 overflow-hidden border border-[var(--n-line)] bg-background/80">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Open → Close</TableHead>
                          <TableHead>Hold</TableHead>
                          <TableHead>Symbol</TableHead>
                          <TableHead>Reason</TableHead>
                          <TableHead>Side</TableHead>
                          <TableHead>Entry → Exit</TableHead>
                          <TableHead>P&L</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {inspectedSliceTrades.slice(0, 8).map((trade) => (
                          <TableRow
                            className={cn("cursor-pointer", selectedTradeId === trade.id && "bg-[var(--muted)]")}
                            key={`slice-${inspectedSlice.key}-${trade.id}`}
                            onClick={() => focusReviewTrade(trade, inspectedSlice)}
                          >
                            <TableCell>
                              {trade.entry_timestamp_ms !== null
                                ? `${formatTimestampMs(trade.entry_timestamp_ms)} → ${formatTimestampMs(trade.timestamp_ms)}`
                                : formatTimestampMs(trade.timestamp_ms)}
                            </TableCell>
                            <TableCell>{trade.entry_timestamp_ms !== null ? formatDurationMs(trade.timestamp_ms - trade.entry_timestamp_ms) : "No data"}</TableCell>
                            <TableCell className="font-medium">{trade.symbol}</TableCell>
                            <TableCell>{trade.close_reason}</TableCell>
                            <TableCell>{trade.side}</TableCell>
                            <TableCell>{formatUsd(trade.entry_price)} → {formatUsd(trade.exit_price)}</TableCell>
                            <TableCell className={signedValueTextClass(trade.realized_pnl)}>{formatSignedUsd(trade.realized_pnl)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>

        <div className="n-card">
          <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
            <span className="n-label">Trade history</span>
            
          </div>
          <div className="px-4 pb-4 space-y-3">
            <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              <div className="space-y-2">
                <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Symbol</div>
                <select
                  className="h-12 w-full border border-[var(--n-line)] bg-background px-4 text-sm text-foreground outline-none"
                  onChange={(event) => setSymbolFilter(event.target.value)}
                  value={symbolFilter}
                >
                  <option value="All">All symbols</option>
                  {symbolOptions.map((symbol) => (
                    <option key={symbol} value={symbol}>{symbol}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Model</div>
                <select
                  className="h-12 w-full border border-[var(--n-line)] bg-background px-4 text-sm text-foreground outline-none"
                  onChange={(event) => setModelFilter(event.target.value)}
                  value={modelFilter}
                >
                  <option value="All">All models</option>
                  {modelOptions.map((modelId) => (
                    <option key={modelId} value={modelId}>{modelId}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Family</div>
                <select
                  className="h-12 w-full border border-[var(--n-line)] bg-background px-4 text-sm text-foreground outline-none"
                  onChange={(event) => setFamilyFilter(event.target.value)}
                  value={familyFilter}
                >
                  <option value="All">All families</option>
                  {familyOptions.map((family) => (
                    <option key={family} value={family}>{family}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Regime</div>
                <select
                  className="h-12 w-full border border-[var(--n-line)] bg-background px-4 text-sm text-foreground outline-none"
                  onChange={(event) => setRegimeFilter(event.target.value)}
                  value={regimeFilter}
                >
                  <option value="All">All regimes</option>
                  {regimeOptions.map((regime) => (
                    <option key={regime} value={regime}>{regime}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Reason</div>
                <select
                  className="h-12 w-full border border-[var(--n-line)] bg-background px-4 text-sm text-foreground outline-none"
                  onChange={(event) => setCloseReasonFilter(event.target.value)}
                  value={closeReasonFilter}
                >
                  <option value="All">All reasons</option>
                  {closeReasonOptions.map((reason) => (
                    <option key={reason} value={reason}>{reason}</option>
                  ))}
                </select>
              </div>
              <SegmentedControl
                activeValue={dateRangeFilter}
                label="Range"
                onSelect={setDateRangeFilter}
                options={[
                  { label: "All", value: "All" },
                  { label: "7D", value: "7D" },
                  { label: "30D", value: "30D" },
                  { label: "90D", value: "90D" },
                  { label: "Custom", value: "Custom" },
                ]}
              />
              <SegmentedControl
                activeValue={sideFilter}
                label="Side"
                onSelect={setSideFilter}
                options={[
                  { label: "All", value: "All" },
                  { label: "Long", value: "Long" },
                  { label: "Short", value: "Short" },
                ]}
              />
              <SegmentedControl
                activeValue={sourceFilter}
                label="Source"
                onSelect={setSourceFilter}
                options={[
                  { label: "All", value: "All" },
                  { label: "Exact", value: "Exact" },
                  { label: "Estimated", value: "Estimated" },
                ]}
              />
              <SegmentedControl
                activeValue={holdFilter}
                label="Hold"
                onSelect={setHoldFilter}
                options={[
                  { label: "All", value: "All" },
                  { label: "Intraday", value: "Intraday" },
                  { label: "Swing", value: "Swing" },
                  { label: "Multi-day", value: "MultiDay" },
                  { label: "Unknown", value: "Unknown" },
                ]}
              />
              <div className="space-y-2">
                <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Sort</div>
                <select
                  className="h-12 w-full border border-[var(--n-line)] bg-background px-4 text-sm text-foreground outline-none"
                  onChange={(event) => setSortBy(event.target.value)}
                  value={sortBy}
                >
                  <option value="newest">Most recent</option>
                  <option value="oldest">Oldest</option>
                  <option value="best-pnl">Best P&amp;L</option>
                  <option value="worst-pnl">Worst P&amp;L</option>
                  <option value="longest-hold">Longest hold</option>
                  <option value="shortest-hold">Shortest hold</option>
                </select>
              </div>
            </div>
            {dateRangeFilter === "Custom" ? (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                <div className="space-y-2">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Start date</div>
                  <input
                    className="h-12 w-full border border-[var(--n-line)] bg-background px-4 text-sm text-foreground outline-none"
                    onChange={(event) => setCustomStartDate(event.target.value)}
                    type="date"
                    value={customStartDate}
                  />
                </div>
                <div className="space-y-2">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">End date</div>
                  <input
                    className="h-12 w-full border border-[var(--n-line)] bg-background px-4 text-sm text-foreground outline-none"
                    onChange={(event) => setCustomEndDate(event.target.value)}
                    type="date"
                    value={customEndDate}
                  />
                </div>
                <div className="flex items-end">
                  <Button className="h-12 " onClick={() => {
                    setCustomStartDate("");
                    setCustomEndDate("");
                  }} variant="outline">
                    Reset dates
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <MetricBlock compact label="Slice P&L" value={formatSignedUsd(reviewMetrics.realizedPnlTotal)} />
              <MetricBlock compact label="Slice win rate" value={formatPercent(reviewMetrics.winRate, 1)} />
              <MetricBlock compact label="Slice profit factor" value={formatNumber(reviewMetrics.profitFactor)} />
              <MetricBlock compact label="Slice expectancy" value={formatSignedUsd(reviewMetrics.expectancyPerTrade)} />
            </div>
            {selectedTrade ? (
              <div className=" border border-[var(--n-line)] bg-[var(--muted)] px-5 py-4 text-[10px] leading-4" style={{color:"var(--muted-foreground)"}}>
                <span className="font-medium text-foreground">Selected review trade:</span>{" "}
                {selectedTrade.symbol} {selectedTrade.side.toLowerCase()} closed {formatTimestampMs(selectedTrade.timestamp_ms)} with {formatSignedUsd(selectedTrade.realized_pnl)}.
                {selectedTrade.entry_timestamp_ms !== null ? ` Hold time ${formatDurationMs(selectedTrade.timestamp_ms - selectedTrade.entry_timestamp_ms)}.` : " Hold time unavailable."}
              </div>
            ) : null}
            <div className="flex flex-col gap-4 border border-[var(--n-line)] bg-[var(--muted)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm text-muted-foreground">
                {isReviewLoading
                  ? "Refreshing the current review slice..."
                  : filteredTrades.length === 0
                  ? "No trades match the current review slice."
                  : `${filteredTrades.length} trade${filteredTrades.length === 1 ? "" : "s"} in the current review slice.`}
              </div>
              <Button disabled={filteredTrades.length === 0 || isReviewLoading} onClick={() => void exportFilteredTradesCsv()} variant="outline">
                <Download className="size-4" />
                Export slice CSV
              </Button>
            </div>
            {exportState ? (
              <div className=" border border-[var(--n-line)] bg-muted/20 px-5 py-4 text-sm text-muted-foreground">{exportState}</div>
            ) : null}
            {filteredTrades.length === 0 ? (
              <EmptyState message={tradeSummary.tradeHistory.length === 0 ? "No trade history is available yet." : isReviewLoading ? "Loading review slice..." : "No trades match the current review filters."} />
            ) : (
              <div className="n-card overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Open → Close</TableHead>
                      <TableHead>Hold</TableHead>
                      <TableHead>Symbol</TableHead>
                      <TableHead className="hidden xl:table-cell">Model</TableHead>
                      <TableHead className="hidden 2xl:table-cell">Family</TableHead>
                      <TableHead className="hidden 2xl:table-cell">Regime</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Side</TableHead>
                      <TableHead>Entry → Exit</TableHead>
                      <TableHead>P&L</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredTrades.slice(0, 20).map((trade) => (
                      <TableRow
                        className={cn("cursor-pointer", selectedTradeId === trade.id && "bg-[var(--muted)]")}
                        key={trade.id}
                        onClick={() => setSelectedTradeId(trade.id)}
                      >
                        <TableCell>
                          {trade.entry_timestamp_ms !== null
                            ? `${formatTimestampMs(trade.entry_timestamp_ms)} → ${formatTimestampMs(trade.timestamp_ms)}`
                            : formatTimestampMs(trade.timestamp_ms)}
                        </TableCell>
                        <TableCell>{trade.entry_timestamp_ms !== null ? formatDurationMs(trade.timestamp_ms - trade.entry_timestamp_ms) : "No data"}</TableCell>
                        <TableCell className="font-medium">{trade.symbol}</TableCell>
                        <TableCell className="hidden xl:table-cell">{trade.model_id}</TableCell>
                        <TableCell className="hidden 2xl:table-cell">{trade.model_scope_parts.family}</TableCell>
                        <TableCell className="hidden 2xl:table-cell">{trade.model_scope_parts.regime}</TableCell>
                        <TableCell>{trade.close_reason}</TableCell>
                        <TableCell>{trade.side}</TableCell>
                        <TableCell>{formatUsd(trade.entry_price)} → {formatUsd(trade.exit_price)}</TableCell>
                        <TableCell className={signedValueTextClass(trade.realized_pnl)}>{formatSignedUsd(trade.realized_pnl)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </div>

        <div className="n-card">
          <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
            <span className="n-label">Review mistakes</span>
            
          </div>
          <div className="px-4 pb-4 space-y-3">
            {mistakes.map((mistake) => (
              <div className=" border border-[var(--n-line)] bg-[var(--muted)] p-4" key={mistake.title}>
                <div className="text-sm font-medium text-foreground">{mistake.title}</div>
                <div className="mt-1 text-[10px] leading-4" style={{color:"var(--muted-foreground)"}}>{mistake.why}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsPage({
  snapshot,
  operator,
  refreshSnapshot,
  refreshOperatorState,
  runOperatorAction,
  themePreference,
  setThemePreference,
  resolvedTheme,
}: {
  snapshot: RuntimeSnapshot;
  operator: DashboardOperatorData;
  refreshSnapshot: (manual?: boolean) => Promise<void>;
  refreshOperatorState: () => Promise<void>;
  runOperatorAction: (action: OperatorAction, targetMode?: OperatorMode) => Promise<void>;
  themePreference: ThemePreference;
  setThemePreference: (value: ThemePreference) => void;
  resolvedTheme: "light" | "dark";
}) {
  const [tradingSettings, setTradingSettings] = useState<TradingSettingsState>(EMPTY_TRADING_SETTINGS);
  const [settingsState, setSettingsState] = useState("Loading trading settings...");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiSecretDraft, setApiSecretDraft] = useState("");
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [modelPacks, setModelPacks] = useState<ModelPacksState>(EMPTY_MODEL_PACKS);
  const [researchState, setResearchState] = useState("Loading research policy...");
  const [pendingIndicatorAction, setPendingIndicatorAction] = useState<string | null>(null);

  useEffect(() => {
    void refreshTradingSettings();
    void refreshModelPacks();
  }, []);

  useEffect(() => {
    const tick = window.setInterval(() => {
      void refreshTradingSettings();
    }, 10000);

    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    const tick = window.setInterval(() => {
      void refreshModelPacks();
    }, 15000);

    return () => window.clearInterval(tick);
  }, []);

  async function refreshTradingSettings() {
    try {
      const response = await fetch("/api/settings/trading", { cache: "no-store" });
      const payload = (await response.json()) as TradingSettingsState & { message?: string };

      if (!response.ok) {
        throw new Error(payload.message ?? `HTTP ${response.status}`);
      }

      setTradingSettings(payload);
      setSettingsState(
        payload.paperTradingReady
          ? `Paper session is configured for live Binance ${payload.binanceEnvironment} data with simulated fills.`
          : payload.paperTradingConfigured && payload.credentialsValidated === false
            ? payload.credentialsValidationMessage
              ? payload.credentialsValidationMessage
              : `Stored credentials are rejected by Binance ${payload.binanceEnvironment}.`
          : payload.credentialsReady
            ? `Credentials are stored for Binance ${payload.binanceEnvironment}. Enable transport and restart into Paper mode to stop using simulated account state.`
            : "Store Binance Futures credentials to move this runtime off simulated transport.",
      );
    } catch (error) {
      setSettingsState(error instanceof Error ? error.message : "Failed to load trading settings.");
    }
  }

  async function refreshModelPacks() {
    try {
      const response = await fetch("/api/model-packs", { cache: "no-store" });
      const payload = (await response.json()) as { model_packs?: ModelPacksState; message?: string };

      if (!response.ok) {
        throw new Error(payload.message ?? `HTTP ${response.status}`);
      }

      const nextModelPacks = payload.model_packs ?? EMPTY_MODEL_PACKS;
      setModelPacks(nextModelPacks);
      setResearchState(
        nextModelPacks.indicator_leaderboard.length > 0
          ? `Indicator genomes are being ranked against a minimum fitness of ${formatNumber(nextModelPacks.policy?.indicatorPruneMinFitness ?? tradingSettings.indicatorPruneMinFitness)}.`
          : `No indicator genomes currently clear the active fitness floor of ${formatNumber(nextModelPacks.policy?.indicatorPruneMinFitness ?? tradingSettings.indicatorPruneMinFitness)}.`,
      );
    } catch (error) {
      setResearchState(error instanceof Error ? error.message : "Failed to load research leaderboards.");
    }
  }

  async function runIndicatorRegistryAction(action: "delete-indicator" | "blacklist-indicator" | "unblacklist-indicator", indicatorId: string) {
    const actionKey = `${action}:${indicatorId}`;
    setPendingIndicatorAction(actionKey);

    try {
      const response = await fetch("/api/operator", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action, indicatorId }),
      });
      const payload = (await response.json()) as { message?: string };

      if (!response.ok) {
        throw new Error(payload.message ?? `HTTP ${response.status}`);
      }

      setResearchState(payload.message ?? "Indicator registry updated.");
      await refreshModelPacks();
      await refreshSnapshot(true);
      await refreshOperatorState();
    } catch (error) {
      setResearchState(error instanceof Error ? error.message : "Indicator registry update failed.");
    } finally {
      setPendingIndicatorAction(null);
    }
  }

  async function saveTradingSettings(startPaperTrading: boolean) {
    setIsSavingSettings(true);

    try {
      const response = await fetch("/api/settings/trading", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          binanceEnvironment: tradingSettings.binanceEnvironment,
          transportEnabled: tradingSettings.transportEnabled,
          streamEnabled: tradingSettings.streamEnabled,
          tradingEnabled: tradingSettings.tradingEnabled,
          autoStartRuntimeOnOpen: tradingSettings.autoStartRuntimeOnOpen,
          autoRunOverlayCompareOnOpen: tradingSettings.autoRunOverlayCompareOnOpen,
          supervisorIntervalMs: tradingSettings.supervisorIntervalMs,
          researchRefreshIntervalMinutes: tradingSettings.researchRefreshIntervalMinutes,
          indicatorPruneMinFitness: tradingSettings.indicatorPruneMinFitness,
          indicatorRetentionLimit: tradingSettings.indicatorRetentionLimit,
          apiKey: apiKeyDraft,
          apiSecret: apiSecretDraft,
        }),
      });

      const payload = (await response.json()) as TradingSettingsState & { message?: string };
      if (!response.ok) {
        throw new Error(payload.message ?? `HTTP ${response.status}`);
      }

      setTradingSettings(payload);
      setApiKeyDraft("");
      setApiSecretDraft("");
      setSettingsState("Trading settings saved locally.");

      if (startPaperTrading) {
        await runOperatorAction("restart-supervisor");
        await runOperatorAction("set-mode", "Paper");
        setSettingsState(`Supervisor restarted and Paper mode requested using Binance ${payload.binanceEnvironment} transport.`);
      }

      await refreshTradingSettings();
    } catch (error) {
      setSettingsState(error instanceof Error ? error.message : "Failed to save trading settings.");
    } finally {
      setIsSavingSettings(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-4 xl:grid-cols-3">
        <MetricCard compact label="Mode" tone="neutral" value={snapshot.mode} />
        <MetricCard compact label="Venue" tone="neutral" value={snapshot.venue} />
        <MetricCard compact label="Host" tone="neutral" value={snapshot.host} />
      </div>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
        <div className="space-y-3">
          <div className="n-card">
            <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
              <span className="n-label">Mode requests</span>
              
            </div>
            <div className="px-4 pb-4 space-y-4">
              <MetricBlock label="Pending request" value={operator.pendingModeRequest ?? "None"} />
              <MetricBlock label="Promoted indicator" value={snapshot.promoted_indicator.id ?? "None"} />
              <MetricBlock label="Overlay enabled" value={snapshot.promoted_indicator.overlay_enabled ? "True" : "False"} />
              <MetricBlock label="Leaderboard count" value={String(snapshot.promoted_indicator.leaderboard_count)} />
              <Button className=" px-5" onClick={() => void runOperatorAction("status")} variant="outline">
                <Activity className="size-4" />
                Refresh stack status
              </Button>
            </div>
          </div>

          <div className="n-card">
            <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
              <span className="n-label">Theme</span>
              
            </div>
            <div className="px-4 pb-4 space-y-2">
              {(["system", "light", "dark"] as ThemePreference[]).map((mode) => {
                const active = themePreference === mode;
                const Icon = mode === "system" ? Monitor : mode === "light" ? Sun : Moon;
                const sub = mode === "system" ? `Follows system · now ${resolvedTheme}` : `Fixed ${mode} palette`;
                return (
                  <button
                    className={cn(
                      "flex w-full items-center gap-3 rounded-[18px] border px-3.5 py-2.5 text-left transition-all duration-150",
                      active
                        ? "border-border bg-card text-foreground shadow-(--shadow-card)"
                        : "border-[var(--n-line)] bg-muted/20 text-foreground hover:border-border hover:bg-muted/50",
                    )}
                    key={mode}
                    onClick={() => setThemePreference(mode)}
                    type="button"
                  >
                    <span className={cn("flex size-7 shrink-0 items-center justify-center ", active ? "bg-muted" : "bg-muted")}>
                      <Icon className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn("block text-sm font-medium capitalize")}>{mode}</span>
                      <span className={cn("block text-[11px]", active ? "text-muted-foreground" : "text-muted-foreground")}>{sub}</span>
                    </span>
                    {active ? <Check className="size-3.5 shrink-0 opacity-70" /> : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div className="n-card">
          <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
            <span className="n-label">Binance paper session</span>
            
          </div>
          <div className="px-4 pb-4 space-y-4">
            <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
              <MetricBlock label="Environment" value={tradingSettings.binanceEnvironment === "testnet" ? "Testnet" : "Mainnet"} compact />
              <MetricBlock label={tradingSettings.credentialBackend === "wincred" ? "Credential Manager" : "Keychain"} value={tradingSettings.keychainAvailable ? "Available" : "Unavailable"} compact />
              <MetricBlock label="API key" value={tradingSettings.hasApiKey ? "Stored" : "Missing"} compact />
              <MetricBlock label="API secret" value={tradingSettings.hasApiSecret ? "Stored" : "Missing"} compact />
              <MetricBlock label="Cycle interval" value={`${tradingSettings.supervisorIntervalMs} ms`} compact />
              <MetricBlock
                label="Credential validation"
                value={
                  tradingSettings.credentialsValidated === true
                    ? "Valid"
                    : tradingSettings.credentialsValidated === false
                      ? "Rejected"
                      : "Unchecked"
                }
                compact
              />
              <MetricBlock
                label="Research refresh"
                value={`${tradingSettings.researchRefreshIntervalMinutes} min`}
                compact
              />
              <MetricBlock
                label="Paper transport"
                value={
                  tradingSettings.paperTradingReady
                    ? "Ready"
                    : tradingSettings.paperTradingConfigured
                      ? "Configured"
                      : "Not ready"
                }
                compact
              />
            </div>
            <div className=" border border-[var(--n-line)] bg-muted/20 px-4 py-3">
              <div className="grid gap-3 md:grid-cols-3">
                <MetricBlock label="Live mode" value={snapshot.mode} compact />
                <MetricBlock label="Snapshot updated" value={new Date(snapshot.updated_at).toLocaleTimeString()} compact />
                <MetricBlock label="Session posture" value={snapshot.execution_summary.split(" / ")[0] ?? snapshot.mode} compact />
              </div>
              <p className="mt-3 text-sm text-muted-foreground">{snapshot.execution_summary}</p>
            </div>
            {tradingSettings.credentialsValidationMessage ? (
              <p className="rounded-[18px] border border-amber-500/20 bg-amber-500/8 px-4 py-3 text-sm text-amber-950 dark:text-amber-100">
                {tradingSettings.credentialsValidationMessage}
              </p>
            ) : null}
            <div className="grid gap-3 md:grid-cols-2">
              {(["testnet", "mainnet"] as const).map((environment) => {
                const active = tradingSettings.binanceEnvironment === environment;
                const detected = tradingSettings.detectedCredentialEnvironment === environment;
                return (
                  <button
                    key={environment}
                    type="button"
                    onClick={() => setTradingSettings((current) => ({ ...current, binanceEnvironment: environment }))}
                    className={cn(
                      " border px-4 py-3 text-left transition-all",
                      active ? "border-border bg-card shadow-sm" : "border-[var(--n-line)] bg-background hover:bg-[var(--muted)]",
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium capitalize">{environment}</span>
                      {active ? <Check className="size-4 opacity-70" /> : null}
                    </div>
                    <p className="mt-2 text-[10px]" style={{color:"var(--muted-foreground)"}}>
                      {environment === "testnet"
                        ? "Binance Futures testnet private account access."
                        : "Binance Futures mainnet private account access with simulated fills while live orders stay off."}
                    </p>
                    {detected ? <p className="mt-2 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">· matches stored credentials</p> : null}
                  </button>
                );
              })}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2">
                <span className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Binance API key</span>
                <input
                  className="h-12 w-full border border-[var(--n-line)] bg-background px-4 text-sm text-foreground outline-none"
                  onChange={(event) => setApiKeyDraft(event.target.value)}
                  placeholder={tradingSettings.hasApiKey ? `Stored in ${tradingSettings.credentialBackend === "wincred" ? "Credential Manager" : "Keychain"}. Paste only to replace.` : "Paste Binance Futures API key"}
                  type="password"
                  value={apiKeyDraft}
                />
              </label>
              <label className="space-y-2">
                <span className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Binance API secret</span>
                <input
                  className="h-12 w-full border border-[var(--n-line)] bg-background px-4 text-sm text-foreground outline-none"
                  onChange={(event) => setApiSecretDraft(event.target.value)}
                  placeholder={tradingSettings.hasApiSecret ? `Stored in ${tradingSettings.credentialBackend === "wincred" ? "Credential Manager" : "Keychain"}. Paste only to replace.` : "Paste Binance Futures API secret"}
                  type="password"
                  value={apiSecretDraft}
                />
              </label>
            </div>
            {tradingSettings.credentialBackend === "wincred" || (!tradingSettings.keychainAvailable && typeof window !== "undefined") ? (
              <div className=" border border-[var(--n-line)] bg-muted/20 px-4 py-4 space-y-2">
                <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Windows Credential Manager</p>
                <p className="text-sm text-muted-foreground">Credentials are stored via <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">cmdkey</code>. To verify or remove them manually, run in Command Prompt:</p>
                <pre className="overflow-x-auto rounded-[14px] bg-muted px-4 py-3 text-xs font-mono text-foreground leading-relaxed">{`cmdkey /list:sthyra.binance/api-key\ncmdkey /list:sthyra.binance/api-secret\ncmdkey /delete:sthyra.binance/api-key`}</pre>
                <p className="text-[10px]" style={{color:"var(--muted-foreground)"}}>The app uses PowerShell <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">Get-StoredCredential</code> to read secrets at runtime. No plaintext is written to disk.</p>
              </div>
            ) : null}
            <div className="grid gap-3 md:grid-cols-3">
              <ToggleSettingCard
                checked={tradingSettings.transportEnabled}
                description={`Use Binance ${tradingSettings.binanceEnvironment} REST transport for account snapshots and exchange metadata.`}
                label="Enable transport"
                onToggle={(checked) => setTradingSettings((current) => ({ ...current, transportEnabled: checked }))}
              />
              <ToggleSettingCard
                checked={tradingSettings.streamEnabled}
                description="Use Binance stream-first book data instead of the local simulated feed."
                label="Enable market stream"
                onToggle={(checked) => setTradingSettings((current) => ({ ...current, streamEnabled: checked }))}
              />
              <ToggleSettingCard
                checked={tradingSettings.tradingEnabled}
                description="Leave this off for Paper mode. Turning it on arms real order submission in SemiAuto and FullAuto."
                label="Arm live orders"
                onToggle={(checked) => setTradingSettings((current) => ({ ...current, tradingEnabled: checked }))}
                tone={tradingSettings.tradingEnabled ? "risk" : "neutral"}
              />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <ToggleSettingCard
                checked={tradingSettings.autoStartRuntimeOnOpen}
                description="Start or reconnect the supervisor automatically whenever the app opens."
                label="Auto-start runtime on open"
                onToggle={(checked) => setTradingSettings((current) => ({ ...current, autoStartRuntimeOnOpen: checked }))}
              />
              <ToggleSettingCard
                checked={tradingSettings.autoRunOverlayCompareOnOpen}
                description="Re-run overlay validation on app open so promoted indicators keep influencing only when they still help approvals."
                label="Auto-run overlay compare"
                onToggle={(checked) => setTradingSettings((current) => ({ ...current, autoRunOverlayCompareOnOpen: checked }))}
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-2">
                <span className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Cycle interval ms</span>
                <div className=" border border-[var(--n-line)] bg-background px-4 py-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium tabular-nums text-foreground">{tradingSettings.supervisorIntervalMs} ms</span>
                    <span className="text-[9px] font-bold uppercase tracking-[0.14em]" style={{color:"var(--muted-foreground)"}}>
                      {tradingSettings.supervisorIntervalMs <= 150 ? "Aggressive" : tradingSettings.supervisorIntervalMs <= 350 ? "Fast" : tradingSettings.supervisorIntervalMs <= 750 ? "Balanced" : tradingSettings.supervisorIntervalMs <= 1500 ? "Conservative" : "Slow"}
                    </span>
                  </div>
                  <input
                    className="w-full"
                    max={5000}
                    min={100}
                    onChange={(event) => {
                      if (!Number.isFinite(event.target.valueAsNumber)) return;
                      setTradingSettings((current) => ({
                        ...current,
                        supervisorIntervalMs: Math.max(100, Math.min(5000, Math.round(event.target.valueAsNumber))),
                      }));
                    }}
                    step={50}
                    type="range"
                    value={tradingSettings.supervisorIntervalMs}
                  />
                  <div className="flex justify-between text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                    {[100, 250, 500, 1000, 2000, 5000].map((preset) => (
                      <button
                        className={cn(
                          " px-1 py-0.5 transition-colors",
                          tradingSettings.supervisorIntervalMs === preset
                            ? "bg-muted text-foreground font-semibold"
                            : "hover:text-foreground",
                        )}
                        key={preset}
                        onClick={() => setTradingSettings((current) => ({ ...current, supervisorIntervalMs: preset }))}
                        type="button"
                      >
                        {preset < 1000 ? `${preset}` : `${preset / 1000}k`}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <label className="space-y-2">
                <span className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Research refresh min</span>
                <input
                  className="h-12 w-full border border-[var(--n-line)] bg-background px-4 text-sm text-foreground outline-none"
                  max={1440}
                  min={1}
                  onChange={(event) => {
                    if (!Number.isFinite(event.target.valueAsNumber)) {
                      return;
                    }

                    setTradingSettings((current) => ({
                      ...current,
                      researchRefreshIntervalMinutes: Math.max(1, Math.min(1440, Math.round(event.target.valueAsNumber))),
                    }));
                  }}
                  step={1}
                  type="number"
                  value={tradingSettings.researchRefreshIntervalMinutes}
                />
              </label>
              <label className="space-y-2">
                <span className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Indicator min fitness</span>
                <input
                  className="h-12 w-full border border-[var(--n-line)] bg-background px-4 text-sm text-foreground outline-none"
                  max={1}
                  min={-0.5}
                  onChange={(event) => {
                    if (!Number.isFinite(event.target.valueAsNumber)) {
                      return;
                    }

                    setTradingSettings((current) => ({
                      ...current,
                      indicatorPruneMinFitness: Math.max(-0.5, Math.min(1, Number(event.target.valueAsNumber.toFixed(3)))),
                    }));
                  }}
                  step={0.01}
                  type="number"
                  value={tradingSettings.indicatorPruneMinFitness}
                />
              </label>
              <label className="space-y-2">
                <span className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Retention limit</span>
                <input
                  className="h-12 w-full border border-[var(--n-line)] bg-background px-4 text-sm text-foreground outline-none"
                  max={32}
                  min={1}
                  onChange={(event) => {
                    if (!Number.isFinite(event.target.valueAsNumber)) {
                      return;
                    }

                    setTradingSettings((current) => ({
                      ...current,
                      indicatorRetentionLimit: Math.max(1, Math.min(32, Math.round(event.target.valueAsNumber))),
                    }));
                  }}
                  step={1}
                  type="number"
                  value={tradingSettings.indicatorRetentionLimit}
                />
              </label>
            </div>
            <div className="px-3 py-3 text-[10px] leading-4" style={{background:"var(--card)",border:"1px solid var(--n-line)",color:"var(--muted-foreground)"}}>
              {settingsState}
            </div>
            <div className="flex flex-wrap gap-3">
              <Button className=" px-5" disabled={isSavingSettings} onClick={() => void saveTradingSettings(false)} variant="outline">
                <Download className={cn("size-4", isSavingSettings && "animate-pulse")} />
                Save credentials and runtime flags
              </Button>
              <Button
                className=" px-5"
                disabled={isSavingSettings || !tradingSettings.transportEnabled || !tradingSettings.streamEnabled}
                onClick={() => void saveTradingSettings(true)}
              >
                <Radar className={cn("size-4", isSavingSettings && "animate-pulse")} />
                Save and start paper trading
              </Button>
              <Button className=" px-5" disabled={isSavingSettings} onClick={() => void refreshTradingSettings()} variant="secondary">
                <RefreshCw className="size-4" />
                Refresh trading settings
              </Button>
            </div>
          </div>
        </div>

          <div className="n-card">
            <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
              <span className="n-label">Research policy and leaderboards</span>
              
            </div>
            <div className="px-4 pb-4 space-y-3">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <MetricBlock label="Promoted model" value={modelPacks.active.promoted_model?.model?.id ?? "None"} compact />
                <MetricBlock label="Promoted indicator" value={modelPacks.active.promoted_indicator_pack?.genome?.id ?? "None"} compact />
                <MetricBlock label="Signal leaderboard" value={String(modelPacks.signal_leaderboard.length)} compact />
                <MetricBlock label="Blacklisted indicators" value={String(modelPacks.blacklisted_indicator_ids.length)} compact />
              </div>
              <div className="px-3 py-3 text-[10px] leading-4" style={{background:"var(--card)",border:"1px solid var(--n-line)",color:"var(--muted-foreground)"}}>
                {researchState}
                <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <MetricBlock label="Refresh cadence" value={`${modelPacks.policy?.researchRefreshIntervalMinutes ?? tradingSettings.researchRefreshIntervalMinutes} min`} compact />
                  <MetricBlock label="Cycle latency" value={`${modelPacks.policy?.supervisorIntervalMs ?? tradingSettings.supervisorIntervalMs} ms`} compact />
                  <MetricBlock label="Min fitness" value={formatNumber(modelPacks.policy?.indicatorPruneMinFitness ?? tradingSettings.indicatorPruneMinFitness)} compact />
                  <MetricBlock label="Retention cap" value={String(modelPacks.policy?.indicatorRetentionLimit ?? tradingSettings.indicatorRetentionLimit)} compact />
                </div>
              </div>
              <div className="grid gap-3 xl:grid-cols-2">
                <div className="space-y-3">
                  <div>
                    <div className="text-sm font-medium text-foreground">Signal model scores</div>
                    <div className="mt-1 text-[10px]" style={{color:"var(--muted-foreground)"}}>Fitness, profitability, robustness, and risk-adjusted return for the leading signal models.</div>
                  </div>
                  {modelPacks.signal_leaderboard.length === 0 ? (
                    <EmptyState message="No signal leaderboard is available yet." />
                  ) : (
                    modelPacks.signal_leaderboard.slice(0, 6).map((entry, index) => (
                      <div className="p-4" style={{background:"var(--card)"}} key={entry.model?.id ?? `signal-${index}`}>
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-medium text-foreground">{entry.model?.id ?? "Unnamed model"}</div>
                            <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                              {(entry.model?.target_symbol ?? "All")} · {(entry.model?.target_family ?? "All families")} · {(entry.model?.target_regime ?? "All regimes")}
                            </div>
                          </div>
                          <Badge className=" border-[var(--n-line)] bg-background text-foreground" variant="outline">
                            fit {formatNumber(entry.fitness_score ?? null)}
                          </Badge>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                          <MetricBlock label="Profitability" value={formatNumber(entry.profitability_score ?? null)} compact />
                          <MetricBlock label="Robustness" value={formatNumber(entry.robustness_score ?? null)} compact />
                          <MetricBlock label="Risk-adjusted" value={formatNumber(entry.risk_adjusted_return ?? null)} compact />
                          <MetricBlock label="Threshold" value={formatNumber(entry.model?.approval_threshold ?? null)} compact />
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <div className="space-y-3">
                  <div>
                    <div className="text-sm font-medium text-foreground">Indicator genome scores</div>
                    <div className="mt-1 text-[10px]" style={{color:"var(--muted-foreground)"}}>Delete weak genomes from the active registry or blacklist them so they cannot be promoted again.</div>
                  </div>
                  {modelPacks.indicator_leaderboard.length === 0 ? (
                    <EmptyState message={`No indicator genomes currently survive the active fitness floor of ${formatNumber(modelPacks.policy?.indicatorPruneMinFitness ?? tradingSettings.indicatorPruneMinFitness)}.`} />
                  ) : (
                    modelPacks.indicator_leaderboard.slice(0, 6).map((entry, entryIdx) => {
                      const indicatorId = entry.genome?.id ?? "unknown-indicator";
                      const deleteKey = `delete-indicator:${indicatorId}`;
                      const blacklistKey = `blacklist-indicator:${indicatorId}`;

                      return (
                        <div className="p-4" style={{background:"var(--card)"}} key={`${indicatorId}-${entryIdx}`}>
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="text-sm font-medium text-foreground">{indicatorId}</div>
                              <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                                {(entry.genome?.target_symbol ?? "All")} · {(entry.genome?.target_family ?? "All families")} · {(entry.genome?.target_regime ?? "All regimes")}
                              </div>
                            </div>
                            <Badge className=" border-[var(--n-line)] bg-background text-foreground" variant="outline">
                              fit {formatNumber(entry.fitness_score ?? null)}
                            </Badge>
                          </div>
                          <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                            <MetricBlock label="Profitability" value={formatNumber(entry.profitability_score ?? null)} compact />
                            <MetricBlock label="Robustness" value={formatNumber(entry.robustness_score ?? null)} compact />
                            <MetricBlock label="Latency" value={formatNumber(entry.latency_score ?? null)} compact />
                            <MetricBlock label="Threshold" value={formatNumber(entry.genome?.approval_threshold ?? null)} compact />
                          </div>
                          <div className="mt-4 flex flex-wrap gap-3">
                            <Button
                              className=" px-4"
                              disabled={pendingIndicatorAction !== null}
                              onClick={() => void runIndicatorRegistryAction("delete-indicator", indicatorId)}
                              variant="outline"
                            >
                              <Trash2 className={cn("size-4", pendingIndicatorAction === deleteKey && "animate-pulse")} />
                              Delete now
                            </Button>
                            <Button
                              className=" px-4"
                              disabled={pendingIndicatorAction !== null || entry.blacklisted}
                              onClick={() => void runIndicatorRegistryAction("blacklist-indicator", indicatorId)}
                              variant="secondary"
                            >
                              <ShieldCheck className={cn("size-4", pendingIndicatorAction === blacklistKey && "animate-pulse")} />
                              {entry.blacklisted ? "Blacklisted" : "Blacklist"}
                            </Button>
                          </div>
                        </div>
                      );
                    })
                  )}
                  {modelPacks.blacklisted_indicator_ids.length > 0 ? (
                    <div className="bg-background/75 p-4" style={{border:"1px solid var(--n-line)"}}>
                      <div className="text-sm font-medium text-foreground">Blocked indicator IDs</div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {modelPacks.blacklisted_indicator_ids.map((indicatorId) => {
                          const actionKey = `unblacklist-indicator:${indicatorId}`;

                          return (
                            <div className="flex items-center gap-2 border border-[var(--n-line)] bg-[var(--muted)] px-3 py-2" key={indicatorId}>
                              <span className="text-xs text-foreground">{indicatorId}</span>
                              <button
                                className="text-[10px] transition-colors hover:text-foreground" style={{color:"var(--muted-foreground)"}}
                                disabled={pendingIndicatorAction !== null}
                                onClick={() => void runIndicatorRegistryAction("unblacklist-indicator", indicatorId)}
                                type="button"
                              >
                                {pendingIndicatorAction === actionKey ? "Removing..." : "Allow again"}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>

          <div className="n-card">
            <div className="px-4 py-3 border-b" style={{borderColor:"var(--n-line)"}}>
              <span className="n-label">Theme rationale</span>
              
            </div>
            <div className="px-4 pb-4 grid gap-3 md:grid-cols-2">
              <StrategyNote title="Neutral shell" detail="Whitespace and slate tones keep attention on price, P&L, and risk instead of decorative gradients." />
              <StrategyNote title="Separate pages" detail="Each navigation item now owns a route and a detailed context instead of scrolling through a single overloaded page." />
              <StrategyNote title="Indicator-first panes" detail="Price, EMA, RSI, and MACD are grouped like a trading terminal instead of mixing them with maintenance controls." />
              <StrategyNote title="Review discipline" detail="Mistakes and trade review live together so lessons are anchored to actual book outcomes." />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ToggleSettingCard({
  checked,
  description,
  label,
  onToggle,
  tone = "neutral",
}: {
  checked: boolean;
  description: string;
  label: string;
  onToggle: (checked: boolean) => void;
  tone?: "neutral" | "risk";
}) {
  const activeColor = tone === "risk" ? "var(--n-red)" : "var(--n-green)";
  const activeBg   = tone === "risk" ? "var(--n-red-dim)" : "var(--n-green-dim)";
  const activeBorder = tone === "risk" ? "var(--n-red-border)" : "var(--n-green-border)";
  return (
    <button
      className="border px-3 py-3 text-left transition-colors w-full"
      style={{
        borderRadius:"var(--radius)",
        borderColor: checked ? activeBorder : "var(--n-line)",
        background: checked ? activeBg : "var(--card)",
        borderLeftWidth: checked ? "2px" : "1px",
        borderLeftColor: checked ? activeColor : "var(--n-line)",
      }}
      onClick={() => onToggle(!checked)}
      type="button"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-bold uppercase tracking-[0.08em]" style={{color: checked ? activeColor : "var(--foreground)"}}>{label}</div>
        <span className="n-label border px-1.5 py-0.5" style={{
          color: checked ? activeColor : "var(--muted-foreground)",
          borderColor: checked ? activeBorder : "var(--n-line)",
          background: "transparent",
        }}>{checked ? "ON" : "OFF"}</span>
      </div>
      <div className="mt-1 text-[10px] leading-4" style={{color:"var(--muted-foreground)"}}>{description}</div>
    </button>
  );
}

function TradingViewPanel({
  activePosition,
  activePositionEntryTimestamp,
  candles,
  mode,
  points,
  trades,
  title,
  symbol,
  symbolOptions,
  selectedWindow,
  updatedAt,
  venue,
  onSelectSymbol,
  onSelectWindow,
}: {
  activePosition?: RuntimePosition | null;
  activePositionEntryTimestamp?: number | null;
  candles: RuntimeCandlePoint[];
  mode?: string;
  points: RuntimeIndicatorPoint[];
  trades?: AuditClosedTrade[];
  title: string;
  symbol?: string;
  symbolOptions?: string[];
  selectedWindow?: number;
  updatedAt?: string;
  venue?: string;
  onSelectSymbol?: (symbol: string) => void;
  onSelectWindow?: (window: number) => void;
}) {
  const requestedWindow = selectedWindow ?? 48;
  const chartPoints = points.length > 0 ? points.slice(-requestedWindow) : [];
  const chartCandles = candles.length > 0 ? candles.slice(-requestedWindow) : [];
  const [hoverIndex, setHoverIndex] = useState(Math.max(chartPoints.length - 1, 0));

  useEffect(() => {
    setHoverIndex(Math.max(chartPoints.length - 1, 0));
  }, [chartPoints.length, requestedWindow, symbol]);

  const normalizedCandles = chartCandles.length === chartPoints.length
    ? chartCandles
    : chartPoints.map((point, index) => {
        const previous = chartPoints[index - 1]?.price ?? point.price;
        const low = Math.min(previous, point.price);
        const high = Math.max(previous, point.price);

        return {
          symbol: point.symbol,
          timestamp_ms: point.timestamp_ms,
          open: previous,
          high,
          low,
          close: point.price,
          volume: 0,
        };
      });
  const tradeMarkers = buildTradeMarkers(normalizedCandles, trades ?? []);
  const activeIndex = normalizedCandles.length === 0 ? 0 : Math.min(hoverIndex, normalizedCandles.length - 1);
  const activeCandle = normalizedCandles[activeIndex] ?? null;
  const activePoint = chartPoints[activeIndex] ?? chartPoints.at(-1) ?? null;
  const activeMarker = tradeMarkers.find((marker) => {
    const startIndex = Math.min(marker.entryCandleIndex, marker.exitCandleIndex);
    const endIndex = Math.max(marker.entryCandleIndex, marker.exitCandleIndex);
    return activeIndex >= startIndex && activeIndex <= endIndex;
  }) ?? null;
  const lastTimestamp = activeCandle?.timestamp_ms ?? chartPoints.at(-1)?.timestamp_ms ?? null;

  return (
    <div className="n-card">
      <div className="border-b" style={{borderColor:"var(--n-line)"}}>
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b" style={{borderColor:"var(--n-line)"}}>
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-bold uppercase tracking-[0.16em]" style={{color:"var(--muted-foreground)"}}>CHART DECK</span>
            <span className="text-[9px]" style={{color:"var(--n-line-strong)"}}>│</span>
            <span className="text-[9px] font-bold" style={{color:"var(--n-blue)"}}>{symbol ?? "ALL"}</span>
            <span className="text-[9px]" style={{color:"var(--n-line-strong)"}}>│</span>
            <span className="text-[9px]" style={{color:"var(--muted-foreground)"}}>{requestedWindow} BARS</span>
          </div>
          {symbolOptions && onSelectSymbol && onSelectWindow ? (
            <div className="flex items-center gap-2">
              <SegmentedControl activeValue={symbol ?? "All"} label="Symbol" options={symbolOptions.map((item) => ({ label: item, value: item }))} onSelect={onSelectSymbol} />
              <SegmentedControl activeValue={String(requestedWindow)} label="Window" options={[{ label: "12", value: "12" },{ label: "24", value: "24" },{ label: "48", value: "48" }]} onSelect={(value) => onSelectWindow(Number(value))} />
            </div>
          ) : null}
        </div>
        <div className="grid gap-4 border-b border-[var(--n-line)] sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5" style={{background:"var(--n-line)"}}>
          <TerminalStat label="Venue" value={venue ?? "Local"} />
          <TerminalStat label="Mode" value={mode ?? "Unknown"} />
          <TerminalStat label="Symbol" value={activeCandle?.symbol ?? symbol ?? "None"} />
          <TerminalStat label="Time" value={lastTimestamp !== null ? formatTimestampMs(lastTimestamp) : "No data"} />
          <TerminalStat label="Open" value={activeCandle ? formatUsd(activeCandle.open, 2) : "No data"} />
          <TerminalStat label="High" value={activeCandle ? formatUsd(activeCandle.high, 2) : "No data"} />
          <TerminalStat label="Low" value={activeCandle ? formatUsd(activeCandle.low, 2) : "No data"} />
          <TerminalStat label="Close" value={activeCandle ? formatUsd(activeCandle.close, 2) : "No data"} />
          <TerminalStat label="Volume" value={activeCandle ? formatNumber(activeCandle.volume, 2) : "No data"} />
          <TerminalStat label="EMA fast" value={activePoint ? formatUsd(activePoint.ema_fast, 2) : "No data"} />
          <TerminalStat label="EMA slow" value={activePoint ? formatUsd(activePoint.ema_slow, 2) : "No data"} />
          <TerminalStat label="RSI" value={activePoint ? formatNumber(activePoint.rsi, 2) : "No data"} />
          <TerminalStat label="MACD hist" value={activePoint ? formatSignedNumber(activePoint.macd_histogram, 4) : "No data"} />
          <TerminalStat label="Consensus" value={activePoint ? formatSignedNumber(activePoint.signal_consensus, 4) : "No data"} />
          <TerminalStat
            label="Position"
            value={activePosition
              ? `${formatNumber(activePosition.quantity, 4)} @ ${formatUsd(activePosition.entry_price, 2)} · ${formatSignedUsd(activePosition.unrealized_pnl)}`
              : "Flat"}
          />
          <TerminalStat
            label="Hold"
            value={activePositionEntryTimestamp !== null && activePositionEntryTimestamp !== undefined
              ? `${formatRelativeDuration(activePositionEntryTimestamp)} · ${formatTimestampMs(activePositionEntryTimestamp)}`
              : "No live hold"}
          />
          <TerminalStat
            label="Execution"
            value={activeMarker
              ? `${activeMarker.trade.side} ${formatSignedUsd(activeMarker.trade.realized_pnl)} · ${activeMarker.trade.entry_timestamp_ms !== null ? formatTimestampMs(activeMarker.trade.entry_timestamp_ms) : "entry n/a"} -> ${formatTimestampMs(activeMarker.trade.timestamp_ms)}`
              : "No marker"}
          />
          <TerminalStat label="Updated" value={updatedAt ? formatOperatorTimestamp(updatedAt) : "No data"} />
        </div>
      </div>
      <div className="px-4 pb-4 pt-3 space-y-3">
        {chartPoints.length < 2 ? (
          <div className="bg-[var(--muted)] px-4 py-10 text-[10px] leading-4" style={{border:"1px solid var(--n-line)",color:"var(--muted-foreground)"}}>Not enough indicator data to render the market pane.</div>
        ) : (
          <>
            <MarketPane candles={chartCandles} points={chartPoints} hoverIndex={activeIndex} onHoverIndex={setHoverIndex} tradeMarkers={tradeMarkers} />
            <VolumePane candles={chartCandles} points={chartPoints} hoverIndex={activeIndex} onHoverIndex={setHoverIndex} />
            <div className="grid gap-4 lg:grid-cols-2">
              <IndicatorPane hoverIndex={activeIndex} label="RSI" series={chartPoints.map((point) => point.rsi)} max={100} min={0} onHoverIndex={setHoverIndex} positiveThreshold={70} negativeThreshold={30} />
              <HistogramPane hoverIndex={activeIndex} label="MACD Histogram" onHoverIndex={setHoverIndex} series={chartPoints.map((point) => point.macd_histogram)} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function WatchlistRail({
  symbols,
  selectedSymbol,
  setSelectedSymbol,
  points,
  positions,
  openPositionEntries,
  opportunities,
  window,
}: {
  symbols: string[];
  selectedSymbol: string;
  setSelectedSymbol: (symbol: string) => void;
  points: RuntimeIndicatorPoint[];
  positions: RuntimePosition[];
  openPositionEntries: DashboardOperatorData["audit"]["openPositionEntries"];
  opportunities: RuntimeSnapshot["opportunities"];
  window: number;
}) {
  const entryTimesBySymbol = new Map(openPositionEntries.map((entry) => [entry.symbol, entry.entry_timestamp_ms]));
  const watchlist = symbols.map((symbol) => {
    const symbolPoints = points.filter((point) => point.symbol === symbol).slice(-window);
    const firstPoint = symbolPoints[0] ?? null;
    const lastPoint = symbolPoints.at(-1) ?? null;
    const position = positions.find((item) => item.symbol === symbol) ?? null;
    const opportunity = opportunities.find((item) => item.symbol === symbol) ?? null;
    const priceChangePct = firstPoint && lastPoint && firstPoint.price > 0
      ? ((lastPoint.price - firstPoint.price) / firstPoint.price) * 100
      : null;

    return {
      symbol,
      lastPrice: lastPoint?.price ?? null,
      priceChangePct,
      rsi: lastPoint?.rsi ?? null,
      consensus: lastPoint?.signal_consensus ?? null,
      action: opportunity?.action ?? "NoSignal",
      family: opportunity?.family ?? "No family",
      regime: opportunity?.regime ?? null,
      confidence: opportunity?.confidence ? parseFloat(opportunity.confidence) : null,
      entryTimestampMs: entryTimesBySymbol.get(symbol) ?? null,
      position,
      sparkPrices: symbolPoints.map((p) => p.price),
      fundingRate: opportunity?.funding_rate ?? 0,
      htfBias: opportunity?.htf_trend_bias ?? 0,
      depthImbalance: opportunity?.depth_imbalance ?? 0,
    };
  });

  return (
    <div className="n-card">
      <div className="px-4 pt-4 pb-3 border-b" style={{borderColor:"var(--n-line)"}}>
        <span className="n-label">Watchlist</span>
      </div>
      <div className="px-4 pb-4 space-y-3.5">
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricBlock compact label="Symbols" value={String(watchlist.length)} />
          <MetricBlock compact label="Live positions" value={String(watchlist.filter((item) => item.position !== null).length)} />
          <MetricBlock compact label="Queued setups" value={String(watchlist.filter((item) => item.action !== "NoSignal").length)} />
        </div>
        {watchlist.length === 0 ? (
          <EmptyState message="No symbols are available in the current runtime snapshot." />
        ) : (
          <div className="space-y-3 xl:max-h-232 xl:overflow-auto xl:pr-1">
            {watchlist.map((item) => {
              const active = item.symbol === selectedSymbol;

              return (
                <button
                  className={cn(
                    "block w-full  border px-4 py-4 text-left transition-all duration-200",
                    active
                      ? "border-border bg-card shadow-(--shadow-card) ring-1 ring-border"
                      : "border-[var(--n-line)] bg-[var(--muted)] hover:border-border hover:bg-muted/55",
                  )}
                  key={item.symbol}
                  onClick={() => setSelectedSymbol(item.symbol)}
                  type="button"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div className="text-base font-semibold tracking-[-0.03em]">{item.symbol}</div>
                        {item.regime && (
                          <span className={cn(" border px-2 py-0.5 text-[9px] uppercase tracking-[0.18em]",
                            active ? "border-[var(--n-line)] bg-muted text-muted-foreground"
                              : item.regime.includes("NoTrade") || item.regime.includes("Disordered")
                                ? "border-(--danger-border) bg-(--danger-surface) text-(--danger-foreground)"
                                : item.regime.includes("Trending") || item.regime.includes("Breakout")
                                  ? "border-(--success-border) bg-(--success-surface) text-(--success-foreground)"
                                  : "border-[var(--n-line)] bg-muted/50 text-muted-foreground"
                          )}>
                            {item.regime.replace("BreakoutExpansion", "Breakout").replace("VolatilityCompression", "VolComp").replace("ReversalAttempt", "Reversal").slice(0, 9)}
                          </span>
                        )}
                      </div>
                      <div className={cn("mt-1 text-xs uppercase tracking-[0.2em]", active ? "text-muted-foreground" : "text-muted-foreground")}>{formatStrategyFamily(item.family)}</div>
                    </div>
                    <div className="flex flex-col items-end gap-1.5">
                      <Badge className={cn(" border", active ? "border-border bg-muted text-foreground" : actionBadgeClasses(item.action))} variant="outline">
                        {item.action}
                      </Badge>
                      {/* Mini sparkline */}
                      {item.sparkPrices.length >= 3 && (() => {
                        const spW = 64; const spH = 24; const spPad = 2;
                        const spMin = Math.min(...item.sparkPrices);
                        const spMax = Math.max(...item.sparkPrices);
                        const spSpread = spMax - spMin || 1;
                        const spScaleX = (i: number) => spPad + (i / Math.max(item.sparkPrices.length - 1, 1)) * (spW - spPad * 2);
                        const spScaleY = (v: number) => spH - spPad - ((v - spMin) / spSpread) * (spH - spPad * 2);
                        const pts = item.sparkPrices.map((v, i) => `${spScaleX(i)},${spScaleY(v)}`).join(" ");
                        const isUp = item.sparkPrices.at(-1)! >= item.sparkPrices[0]!;
                        return (
                          <svg height={spH} viewBox={`0 0 ${spW} ${spH}`} width={spW}>
                            <polyline fill="none" points={pts} stroke={isUp ? "#22c55e" : "#ef4444"} strokeOpacity={active ? "0.9" : "0.6"} strokeWidth="1.5" />
                          </svg>
                        );
                      })()}
                    </div>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                    <WatchMetric active={active} label="Last" value={formatUsd(item.lastPrice, 2)} />
                    <WatchMetric active={active} label="Change" value={item.priceChangePct === null ? "No data" : `${item.priceChangePct >= 0 ? "+" : ""}${formatNumber(item.priceChangePct, 2)}%`} />
                    <WatchMetric active={active} label="RSI" value={formatNumber(item.rsi, 2)} />
                    <WatchMetric active={active} label="Consensus" value={formatSignedNumber(item.consensus, 3)} />
                    <WatchMetric active={active} label="Hold" value={item.entryTimestampMs !== null ? formatRelativeDuration(item.entryTimestampMs) : "Flat"} />
                    <WatchMetric active={active} label="Opened" value={item.entryTimestampMs !== null ? formatTimestampMs(item.entryTimestampMs) : "No data"} />
                    <WatchMetric active={active} label="HTF bias" value={`${item.htfBias >= 0 ? "+" : ""}${item.htfBias.toFixed(2)}`} />
                    <WatchMetric active={active} label="Funding" value={`${(item.fundingRate * 100).toFixed(4)}%`} />
                  </div>
                  <div className={cn("mt-3 text-sm leading-6", active ? "text-muted-foreground" : "text-muted-foreground")}>
                    {item.position
                      ? `Live position ${formatNumber(item.position.quantity, 4)} at ${formatUsd(item.position.entry_price, 2)} with ${formatSignedUsd(item.position.unrealized_pnl)} unrealized.${item.entryTimestampMs !== null ? ` Open since ${formatTimestampMs(item.entryTimestampMs)}.` : ""}`
                      : "No open position on this symbol."}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function MarketPane({
  candles,
  points,
  hoverIndex,
  onHoverIndex,
  tradeMarkers,
}: {
  candles: RuntimeCandlePoint[];
  points: RuntimeIndicatorPoint[];
  hoverIndex: number;
  onHoverIndex: (index: number) => void;
  tradeMarkers: TradeMarker[];
}) {
  const width = 900;
  const height = 320;
  const paddingX = 28;
  const paddingY = 22;
  const normalizedCandles = candles.length === points.length
    ? candles
    : points.map((point, index) => {
        const previous = points[index - 1]?.price ?? point.price;
        const low = Math.min(previous, point.price);
        const high = Math.max(previous, point.price);

        return {
          symbol: point.symbol,
          timestamp_ms: point.timestamp_ms,
          open: previous,
          high,
          low,
          close: point.price,
          volume: 0,
        };
      });
  const prices = normalizedCandles.flatMap((candle) => [candle.open, candle.high, candle.low, candle.close]);
  const emaFast = points.map((point) => point.ema_fast);
  const emaSlow = points.map((point) => point.ema_slow);
  const minValue = Math.min(...prices, ...emaFast, ...emaSlow);
  const maxValue = Math.max(...prices, ...emaFast, ...emaSlow);
  const scaleY = createScale(minValue, maxValue, height - paddingY, paddingY);
  const scaleX = createIndexScale(points.length, paddingX, width - paddingX);
  const activeCandle = normalizedCandles[hoverIndex] ?? normalizedCandles.at(-1) ?? null;
  const crosshairX = scaleX(Math.min(hoverIndex, Math.max(normalizedCandles.length - 1, 0)));

  function updateHoverIndex(clientX: number, left: number, widthPx: number) {
    if (normalizedCandles.length === 0) {
      return;
    }

    const ratio = Math.max(0, Math.min(1, (clientX - left) / Math.max(widthPx, 1)));
    const nextIndex = Math.round(ratio * (normalizedCandles.length - 1));
    onHoverIndex(nextIndex);
  }

  // Build closed polygon path for area fill under close prices
  const closePrices = normalizedCandles.map((c) => c.close);
  const areaPath = closePrices.length > 1
    ? `M ${scaleX(0)},${scaleY(closePrices[0]!)} ` +
      closePrices.slice(1).map((p, i) => `L ${scaleX(i + 1)},${scaleY(p)}`).join(" ") +
      ` L ${scaleX(closePrices.length - 1)},${height} L ${scaleX(0)},${height} Z`
    : "";

  // 5 Y-axis price labels
  const yLabelCount = 5;
  const yLabels = Array.from({ length: yLabelCount }, (_, i) => {
    const value = minValue + (maxValue - minValue) * (i / (yLabelCount - 1));
    const y = scaleY(value);
    return { value, y };
  });

  return (
    <div className="overflow-hidden border border-[var(--n-line)] bg-[var(--muted)]">
      <svg
        className="h-80 w-full"
        onMouseLeave={() => onHoverIndex(Math.max(normalizedCandles.length - 1, 0))}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          updateHoverIndex(event.clientX, rect.left, rect.width);
        }}
        preserveAspectRatio="none"
        viewBox={`0 0 ${width} ${height}`}
      >
        <defs>
          <linearGradient gradientUnits="userSpaceOnUse" id="marketAreaGrad" x1="0" x2="0" y1={paddingY} y2={height}>
            <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="candleUpGrad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#22c55e" stopOpacity="1" />
            <stop offset="100%" stopColor="#16a34a" stopOpacity="1" />
          </linearGradient>
          <linearGradient id="candleDownGrad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#ef4444" stopOpacity="1" />
            <stop offset="100%" stopColor="#dc2626" stopOpacity="1" />
          </linearGradient>
        </defs>
        <ChartGrid height={height} width={width} />

        {/* Y-axis price labels */}
        {yLabels.map(({ value, y }, i) => (
          <text key={`ylabel-${i}`} fill="rgba(148,163,184,0.7)" fontSize="9" textAnchor="start" x="4" y={Math.max(10, Math.min(y - 2, height - 4))}>
            {value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toFixed(value < 10 ? 2 : 0)}
          </text>
        ))}

        {/* Area fill under close price */}
        {areaPath && <path d={areaPath} fill="url(#marketAreaGrad)" />}

        {/* Crosshair */}
        {activeCandle ? <line stroke="rgba(100,116,139,0.35)" strokeDasharray="5 6" strokeWidth="1" x1={crosshairX} x2={crosshairX} y1="0" y2={height} /> : null}

        {/* Candles */}
        {normalizedCandles.map((candle, index) => {
          const x = scaleX(index);
          const open = candle.open;
          const close = candle.close;
          const bodyTop = scaleY(Math.max(open, close));
          const bodyBottom = scaleY(Math.min(open, close));
          const high = scaleY(candle.high);
          const low = scaleY(candle.low);
          const isUp = close >= open;
          const wickColor = isUp ? "#22c55e" : "#ef4444";
          const bodyFill = isUp ? "url(#candleUpGrad)" : "url(#candleDownGrad)";

          return (
            <g key={`${candle.timestamp_ms}-${candle.symbol}-${index}`}>
              <line stroke={wickColor} strokeOpacity="0.85" strokeWidth="1.4" x1={x} x2={x} y1={high} y2={low} />
              <rect fill={bodyFill} height={Math.max(2, bodyBottom - bodyTop)} rx="1.5" width="8" x={x - 4} y={bodyTop} />
            </g>
          );
        })}

        {/* Trade markers */}
        {tradeMarkers.map((marker, markerIndex) => {
          const entryX = scaleX(marker.entryCandleIndex);
          const exitX = scaleX(marker.exitCandleIndex);
          const exitY = scaleY(marker.trade.exit_price);
          const entryY = scaleY(marker.trade.entry_price);
          const positive = marker.trade.realized_pnl >= 0;
          const markerColor = positive ? "#22c55e" : "#ef4444";
          const labelY = Math.max(14, exitY - 12 - (markerIndex % 3) * 14);

          return (
            <g key={`trade-marker-${marker.trade.id}`}>
              <line stroke="rgba(148,163,184,0.45)" strokeDasharray="4 4" strokeWidth="1" x1={entryX} x2={exitX} y1={entryY} y2={exitY} />
              <circle cx={entryX} cy={entryY} fill="rgba(11,17,26,0.95)" r="4.5" stroke="#e2e8f0" strokeWidth="1.6" />
              <circle cx={exitX} cy={exitY} fill={markerColor} r="5.5" stroke="#0b111a" strokeWidth="2" />
              <rect fill="rgba(11,17,26,0.88)" height="16" rx="8" stroke={markerColor} strokeWidth="1" width="54" x={exitX - 27} y={labelY - 12} />
              <text fill="#e2e8f0" fontSize="9" textAnchor="middle" x={exitX} y={labelY - 1}>{positive ? "EXIT +" : "EXIT -"}</text>
            </g>
          );
        })}

        {/* EMA lines */}
        <polyline fill="none" points={polylinePoints(emaFast, scaleX, scaleY)} stroke="#38bdf8" strokeWidth="2.4" />
        <polyline fill="none" points={polylinePoints(emaSlow, scaleX, scaleY)} stroke="#f59e0b" strokeWidth="2.2" />
      </svg>
      <div className="flex flex-wrap items-center gap-4 border-t border-[var(--n-line)] px-5 py-4 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
        <span className="flex items-center gap-2"><span className="size-2 bg-[#38bdf8]" />EMA Fast</span>
        <span className="flex items-center gap-2"><span className="size-2 bg-[#f59e0b]" />EMA Slow</span>
        <span className="flex items-center gap-2"><span className="size-2 bg-[#22c55e]" />Bullish candle</span>
        <span className="flex items-center gap-2"><span className="size-2 bg-[#ef4444]" />Bearish candle</span>
        <span className="flex items-center gap-2"><span className="size-2 border border-border bg-transparent" />Entry marker</span>
        <span className="flex items-center gap-2"><span className="size-2 bg-[#22c55e]" />Exit marker</span>
        <span className="flex items-center gap-2"><span className="size-2 bg-muted-foreground" />{candles.length > 0 ? "OHLC candles" : "Derived candles"}</span>
      </div>
    </div>
  );
}

function VolumePane({
  candles,
  points,
  hoverIndex,
  onHoverIndex,
}: {
  candles: RuntimeCandlePoint[];
  points: RuntimeIndicatorPoint[];
  hoverIndex: number;
  onHoverIndex: (index: number) => void;
}) {
  const width = 900;
  const height = 130;
  const padding = 18;
  const normalizedVolumes = candles.length === points.length
    ? candles.map((candle) => candle.volume)
    : points.map((point, index) => Math.abs(point.macd_histogram) * 1000 + Math.abs(point.signal_consensus) * 100 + index);
  const maxVolume = Math.max(...normalizedVolumes, 1);
  const scaleX = createIndexScale(normalizedVolumes.length, padding, width - padding);
  const scaleY = createScale(0, maxVolume, height - padding, padding);
  const crosshairX = scaleX(Math.min(hoverIndex, Math.max(normalizedVolumes.length - 1, 0)));

  function updateHoverIndex(clientX: number, left: number, widthPx: number) {
    if (normalizedVolumes.length === 0) {
      return;
    }

    const ratio = Math.max(0, Math.min(1, (clientX - left) / Math.max(widthPx, 1)));
    const nextIndex = Math.round(ratio * (normalizedVolumes.length - 1));
    onHoverIndex(nextIndex);
  }

  return (
    <div className="overflow-hidden border border-[var(--n-line)] bg-[var(--muted)]">
      <div className="border-b border-[var(--n-line)] px-5 py-4 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Volume</div>
      <svg
        className="h-32.5 w-full"
        onMouseLeave={() => onHoverIndex(Math.max(normalizedVolumes.length - 1, 0))}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          updateHoverIndex(event.clientX, rect.left, rect.width);
        }}
        preserveAspectRatio="none"
        viewBox={`0 0 ${width} ${height}`}
      >
        <ChartGrid height={height} width={width} />
        <line stroke="rgba(100,116,139,0.35)" strokeDasharray="5 6" strokeWidth="1" x1={crosshairX} x2={crosshairX} y1="0" y2={height} />
        {normalizedVolumes.map((value, index) => {
          const x = scaleX(index);
          const y = scaleY(value);
          const heightValue = Math.max(3, height - padding - y);
          const candle = candles[index];
          const isUp = candle ? candle.close >= candle.open : (points[index]?.price ?? 0) >= (points[index - 1]?.price ?? points[index]?.price ?? 0);

          return (
            <rect
              fill={isUp ? "rgba(34,197,94,0.65)" : "rgba(239,68,68,0.65)"}
              height={heightValue}
              key={`volume-${index}`}
              rx="1.4"
              width="9"
              x={x - 4.5}
              y={y}
            />
          );
        })}
      </svg>
    </div>
  );
}

function SegmentedControl({
  activeValue,
  label,
  options,
  onSelect,
}: {
  activeValue: string;
  label: string;
  options: { label: string; value: string }[];
  onSelect: (value: string) => void;
}) {
  return (
    <div className="n-seg">
      {options.map((option) => (
        <button
          key={option.value}
          className={cn("n-seg-item", activeValue === option.value && "active")}
          onClick={() => onSelect(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
        preserveAspectRatio="none"
        viewBox={`0 0 ${width} ${height}`}
      >
        <defs>
          <linearGradient gradientUnits="userSpaceOnUse" id={`indGrad-${label}`} x1="0" x2="0" y1={padding} y2={height}>
            <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
          </linearGradient>
        </defs>
        <ChartGrid height={height} width={width} />
        <line stroke="rgba(100,116,139,0.35)" strokeDasharray="5 6" strokeWidth="1" x1={crosshairX} x2={crosshairX} y1="0" y2={height} />
        {typeof positiveThreshold === "number" ? <line stroke="rgba(100,116,139,0.5)" strokeDasharray="5 6" strokeWidth="1" x1="0" x2={width} y1={scaleY(positiveThreshold)} y2={scaleY(positiveThreshold)} /> : null}
        {typeof negativeThreshold === "number" ? <line stroke="rgba(100,116,139,0.5)" strokeDasharray="5 6" strokeWidth="1" x1="0" x2={width} y1={scaleY(negativeThreshold)} y2={scaleY(negativeThreshold)} /> : null}
        {areaPoints && <polygon fill={`url(#indGrad-${label})`} points={areaPoints} />}
        <polyline fill="none" points={polylinePoints(series, scaleX, scaleY)} stroke="#22d3ee" strokeWidth="2.2" />
        {lastValue !== undefined && lastY !== null && (
          <text fill="#22d3ee" fontSize="9" textAnchor="end" x={width - 2} y={Math.max(10, lastY - 3)}>
            {lastValue.toFixed(2)}
          </text>
        )}
      </svg>
    </div>
  );
}

function HistogramPane({
  label,
  series,
  hoverIndex,
  onHoverIndex,
}: {
  label: string;
  series: number[];
  hoverIndex: number;
  onHoverIndex: (index: number) => void;
}) {
  const width = 420;
  const height = 170;
  const padding = 18;
  const minValue = Math.min(0, ...series);
  const maxValue = Math.max(0, ...series);
  const scaleX = createIndexScale(series.length, padding, width - padding);
  const scaleY = createScale(minValue, maxValue, height - padding, padding);
  const baselineY = scaleY(0);
  const crosshairX = scaleX(Math.min(hoverIndex, Math.max(series.length - 1, 0)));

  function updateHoverIndex(clientX: number, left: number, widthPx: number) {
    if (series.length === 0) {
      return;
    }

    const ratio = Math.max(0, Math.min(1, (clientX - left) / Math.max(widthPx, 1)));
    const nextIndex = Math.round(ratio * (series.length - 1));
    onHoverIndex(nextIndex);
  }

  return (
    <div className="overflow-hidden border border-[var(--n-line)] bg-[var(--muted)]">
      <div className="border-b border-[var(--n-line)] px-5 py-4 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
      <svg
        className="h-42.5 w-full"
        onMouseLeave={() => onHoverIndex(Math.max(series.length - 1, 0))}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          updateHoverIndex(event.clientX, rect.left, rect.width);
        }}
        preserveAspectRatio="none"
        viewBox={`0 0 ${width} ${height}`}
      >
        <ChartGrid height={height} width={width} />
        <line stroke="rgba(100,116,139,0.35)" strokeDasharray="5 6" strokeWidth="1" x1={crosshairX} x2={crosshairX} y1="0" y2={height} />
        <line stroke="#334155" strokeWidth="1" x1="0" x2={width} y1={baselineY} y2={baselineY} />
        {series.map((value, index) => {
          const x = scaleX(index);
          const y = scaleY(value);
          const barHeight = Math.max(2, Math.abs(baselineY - y));

          return (
            <rect
              fill={value >= 0 ? "#22c55e" : "#ef4444"}
              height={barHeight}
              key={`${label}-${index}`}
              rx="1.2"
              width="6"
              x={x - 3}
              y={value >= 0 ? y : baselineY}
            />
          );
        })}
      </svg>
    </div>
  );
}

function EquityCurve({
  points,
  selectedTrade = null,
}: {
  points: Array<{ timestamp_ms: number; cumulativePnl: number; tradeId: number; visibleIndex: number }>;
  selectedTrade?: { label: string; realizedPnl: number; timestampMs: number; visibleIndex: number } | null;
}) {
  if (points.length < 2) {
    return <EmptyState message="Not enough realized trade history to draw the equity curve." />;
  }

  const width = 860;
  const height = 280;
  const padding = 24;
  const labelWidth = 52;
  const series = points.map((point) => point.cumulativePnl);
  const minValue = Math.min(...series);
  const maxValue = Math.max(...series);
  const scaleX = createIndexScale(series.length, padding + labelWidth, width - padding);
  const scaleY = createScale(minValue, maxValue, height - padding, padding);
  const selectedPoint = selectedTrade === null ? null : points[selectedTrade.visibleIndex] ?? null;
  const selectedX = selectedPoint ? scaleX(selectedTrade!.visibleIndex) : null;
  const selectedY = selectedPoint ? scaleY(selectedPoint.cumulativePnl) : null;
  const isPositive = (maxValue + minValue) / 2 >= 0;
  const lineColor = isPositive ? "#14b8a6" : "#f43f5e";
  const gradColor = isPositive ? "#14b8a6" : "#f43f5e";

  // Area path
  const areaPath = series.length > 1
    ? `M ${scaleX(0)},${scaleY(series[0]!)} ` +
      series.slice(1).map((v, i) => `L ${scaleX(i + 1)},${scaleY(v)}`).join(" ") +
      ` L ${scaleX(series.length - 1)},${height - padding} L ${scaleX(0)},${height - padding} Z`
    : "";

  // Y-axis labels: 5 levels
  const yLabelCount = 5;
  const yLabels = Array.from({ length: yLabelCount }, (_, i) => {
    const value = minValue + (maxValue - minValue) * (i / (yLabelCount - 1));
    const y = scaleY(value);
    return { value, y };
  });

  return (
    <div className="overflow-hidden border border-[var(--n-line)] bg-[var(--muted)]">
      <svg className="h-70 w-full" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
        <defs>
          <linearGradient gradientUnits="userSpaceOnUse" id="equityGrad" x1="0" x2="0" y1={padding} y2={height - padding}>
            <stop offset="0%" stopColor={gradColor} stopOpacity="0.28" />
            <stop offset="100%" stopColor={gradColor} stopOpacity="0" />
          </linearGradient>
        </defs>
        <ChartGrid height={height} width={width} />

        {/* Y-axis labels */}
        {yLabels.map(({ value, y }, i) => (
          <text key={`eqlabel-${i}`} fill="rgba(148,163,184,0.75)" fontSize="9" textAnchor="start" x="4" y={Math.max(10, Math.min(y - 2, height - 6))}>
            {value >= 0 ? `+${value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toFixed(0)}` : value <= -1000 ? `${(value / 1000).toFixed(1)}k` : value.toFixed(0)}
          </text>
        ))}

        {/* Zero baseline */}
        {minValue < 0 && maxValue > 0 && (
          <line stroke="rgba(148,163,184,0.3)" strokeWidth="1" x1={padding + labelWidth} x2={width - padding} y1={scaleY(0)} y2={scaleY(0)} />
        )}

        {/* Area fill */}
        {areaPath && <path d={areaPath} fill="url(#equityGrad)" />}

        {/* Curve line */}
        <polyline fill="none" points={polylinePoints(series, scaleX, scaleY)} stroke={lineColor} strokeWidth="2.5" />

        {/* Selected trade marker */}
        {selectedPoint && selectedX !== null && selectedY !== null ? (
          <>
            <line stroke={lineColor} strokeDasharray="4 6" strokeWidth="1.5" x1={selectedX} x2={selectedX} y1={padding} y2={height - padding} />
            {/* Glow ring */}
            <circle cx={selectedX} cy={selectedY} fill="none" r="12" stroke={lineColor} strokeOpacity="0.25" strokeWidth="8" />
            <circle cx={selectedX} cy={selectedY} fill="#f8fafc" r="6" stroke={lineColor} strokeWidth="3" />
            <g transform={`translate(${Math.min(Math.max(selectedX + 14, padding + labelWidth), width - 188)}, ${Math.max(selectedY - 46, padding + 4)})`}>
              <rect fill="rgba(248,250,252,0.97)" height="38" rx="10" stroke={`${lineColor}55`} strokeWidth="1" width="176" />
              <text fill="#0f172a" fontSize="11" fontWeight="600" x="10" y="15">{selectedTrade?.label}</text>
              <text fill="#475569" fontSize="10" x="10" y="29">{formatTimestampMs(selectedTrade!.timestampMs)} · {formatSignedUsd(selectedTrade!.realizedPnl)}</text>
            </g>
          </>
        ) : null}
      </svg>
    </div>
  );
}

function BalanceCalendar({ days, emptyMessage }: { days: AuditBalanceCalendarDay[]; emptyMessage?: string }) {
  if (days.length === 0) {
    return <EmptyState message={emptyMessage ?? "No daily balance closes are available yet."} />;
  }

  const maxAbsDelta = Math.max(...days.map((d) => Math.abs(d.delta ?? 0)), 1);

  return (
    <div className="grid grid-cols-5 gap-2 sm:grid-cols-7">
      {days.map((day) => {
        const pct = day.delta !== null ? Math.min(100, (Math.abs(day.delta) / maxAbsDelta) * 100) : 0;
        const isGreen = day.tone === "green";
        const isRed = day.tone === "red";
        return (
          <div
            className={cn("relative overflow-hidden rounded-[18px] border px-3 py-3 text-xs", balanceToneClasses(day.tone))}
            key={day.day}
          >
            <div className="relative z-10 font-semibold">{formatCalendarDay(day.day)}</div>
            <div className="relative z-10 mt-1 text-[11px] opacity-80">{day.closeBalance !== null ? formatUsd(day.closeBalance, 0) : "No close"}</div>
            <div className="relative z-10 mt-1 text-[11px] font-medium opacity-90">{day.delta !== null ? formatSignedUsd(day.delta, 0) : "—"}</div>
            {(isGreen || isRed) && pct > 0 && (
              <div
                className="absolute bottom-0 left-0 h-[3px] opacity-60 transition-all duration-500"
                style={{
                  width: `${pct}%`,
                  background: isGreen ? "var(--cal-green-text)" : "var(--cal-red-text)",
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function ActionButton({
  children,
  disabled,
  onClick,
  tone = "neutral",
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  tone?: "positive" | "negative" | "neutral";
}) {
  const cls = tone === "negative"
    ? "n-btn" + " border"
    : "n-btn n-btn-ghost";
  const style = tone === "negative"
    ? {background:"var(--n-red-dim)",borderColor:"var(--n-red-border)",color:"var(--n-red)"}
    : {};
  return (
    <button className={cls} style={style} disabled={disabled} onClick={onClick} type="button">
      {children}
    </button>
  );
}>
      <Icon className={cn("size-3 mr-1.5", pendingOperatorAction === action && "animate-spin")} />
      {label}
    </Button>
  );
}

function StrategyNote({ title, body }: { title: string; body: string }) {
  return (
    <div className="n-card px-4 py-3.5" style={{borderLeft:"3px solid var(--n-blue)"}}>
      <div className="text-[12px] font-semibold mb-1" style={{color:"var(--n-blue)"}}>{title}</div>
      <div className="text-[11px] leading-5" style={{color:"var(--muted-foreground)"}}>{body}</div>
    </div>
  );
}>
      <div className="text-xs font-bold uppercase tracking-[0.08em]" style={{color:"var(--n-blue)"}}>{title}</div>
      <div className="mt-1 text-xs leading-5" style={{color:"var(--muted-foreground)"}}>{detail}</div>
    </div>
  );
}

function WatchMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="n-card px-3 py-2.5">
      <div className="n-label mb-1">{label}</div>
      <div className="text-[12px] font-medium truncate" style={{color:"var(--foreground)",fontFamily:"var(--font-mono)"}}>{value}</div>
    </div>
  );
}>
      <div className="text-[9px] font-bold uppercase tracking-[0.12em]" style={{color:"var(--muted-foreground)"}}>{label}</div>
      <div className="mt-1 wrap-break-word text-xs font-semibold" style={{color:"var(--foreground)"}}>{value}</div>
    </div>
  );
}

function TerminalStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border px-2.5 py-2" >
      <div className="text-[9px] font-bold uppercase tracking-[0.12em]" style={{color:"var(--muted-foreground)"}}>{label}</div>
      <div className="mt-0.5 wrap-break-word text-xs font-semibold" style={{color:"var(--foreground)"}}>{value}</div>
    </div>
  );
}

function BotHealthBadge({ health, prominent = false }: { health: BotHealthReport; prominent?: boolean }) {
  const cls = health.level === "healthy" ? "n-pill n-pill-green" : health.level === "degraded" ? "n-pill n-pill-yellow" : "n-pill n-pill-red";
  const dotCls = health.level === "healthy" ? "n-dot n-dot-green" : health.level === "degraded" ? "n-dot n-dot-yellow" : "n-dot n-dot-red";
  return (
    <span className={cls}>
      <span className={cn(dotCls, health.level === "healthy" && "n-blink")} />
      {health.label}
    </span>
  );
}

function ProvenExecutionCard({
  label,
  timestampMs,
  body,
  tone,
}: {
  label: string;
  timestampMs: number | null;
  body: string;
  tone: "positive" | "negative" | "neutral";
}) {
  const pColor = tone === 'positive' ? 'var(--n-green)' : tone === 'negative' ? 'var(--n-red)' : 'var(--muted-foreground)';
  const pBorder = tone === 'positive' ? 'var(--n-green-border)' : tone === 'negative' ? 'var(--n-red-border)' : 'var(--n-line)';
  return (
    <div className="n-card p-3.5" style={{borderColor:pBorder}}>
      <div className="n-label mb-2">{label}</div>
      <div className="text-sm font-semibold tabular-nums" style={{color:pColor,fontFamily:"var(--font-mono)"}}>{timestampMs === null ? "Not proven yet" : formatTimestampMs(timestampMs)}</div>
      <div className="text-[11px] mt-0.5" style={{color:"var(--muted-foreground)"}}>{timestampMs === null ? "—" : formatRelativeDuration(timestampMs)}</div>
      <div className="mt-2 text-[12px] leading-5" style={{color:"var(--foreground)"}}>{body}</div>
    </div>
  );
}

function MetricCard({ label, value, tone, compact = false }: { label: string; value: string; tone: "positive" | "negative" | "neutral"; compact?: boolean }) {
  const [flashKey, setFlashKey] = useState(0);
  const prevValue = useRef(value);
  useEffect(() => {
    if (prevValue.current !== value) {
      prevValue.current = value;
      setFlashKey((k) => k + 1);
    }
  }, [value]);
  const valueColor = tone === "positive" ? "var(--n-green)" : tone === "negative" ? "var(--n-red)" : "var(--foreground)";
  const glowColor = tone === "positive" ? "rgba(16,185,129,0.08)" : tone === "negative" ? "rgba(244,63,94,0.08)" : "rgba(59,130,246,0.05)";
  const bColor = tone === "positive" ? "var(--n-green-border)" : tone === "negative" ? "var(--n-red-border)" : "var(--n-line)";
  return (
    <div className="n-metric" style={{borderColor:bColor,background:`linear-gradient(135deg, ${glowColor} 0%, rgba(255,255,255,0.01) 100%)`}}>
      <div className="n-label mb-2">{label}</div>
      <div key={flashKey} className={cn("n-flash tabular-nums font-semibold tracking-[-0.02em]", compact ? "text-base" : "text-xl")} style={{color:valueColor,fontFamily:"var(--font-mono)"}}>{value}</div>
    </div>
  );
}

function MetricBlock({ label, value, tone = "neutral", compact = false }: { label: string; value: string; tone?: "positive" | "negative" | "neutral"; compact?: boolean }) {
  const valueColor = tone === "positive" ? "var(--n-green)" : tone === "negative" ? "var(--n-red)" : "var(--foreground)";
  return (
    <div className="min-w-0 n-card px-3 py-2.5">
      <div className="n-label mb-1.5">{label}</div>
      <div className={cn("wrap-break-word font-medium leading-5 tabular-nums", compact ? "text-xs" : "text-sm")} style={{color:valueColor,fontFamily:"var(--font-mono)"}}>{value}</div>
    </div>
  );
}

function RetentionBar({ label, percent, detail }: { label: string; percent: number; detail: string }) {
  const barColor = percent >= 90 ? "var(--n-red)" : percent >= 70 ? "var(--n-yellow)" : "var(--n-green)";
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] font-medium" style={{color:"var(--foreground)"}}>{label}</span>
        <span className="text-[11px] tabular-nums" style={{color:"var(--muted-foreground)",fontFamily:"var(--font-mono)"}}>{detail}</span>
      </div>
      <div className="n-bar">
        <div className="n-bar-fill" style={{width:`${percent}%`,background:barColor}} />
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="n-card px-5 py-10 text-center">
      <div className="text-2xl mb-3" style={{opacity:0.2}}>◌</div>
      <div className="text-[13px]" style={{color:"var(--muted-foreground)"}}>{message}</div>
    </div>
  );
}

function buildMistakes(snapshot: RuntimeSnapshot, operator: DashboardOperatorData) {
  const mistakes = [
    {
      title: "Do not force a trade when the queue is weak",
      why: snapshot.opportunities.length === 0
        ? "There is no candidate queue at all. Forcing a trade in this state turns inactivity into discretionary loss."
        : `Top queue action is ${snapshot.opportunities[0]?.action ?? "unknown"}. If it is not a clear approval, overriding the queue usually means taking lower-quality structure.` ,
    },
    {
      title: "Do not trust a headline win rate without exact fills",
      why: operator.audit.tradeSummary.exactCoverageRate !== null && operator.audit.tradeSummary.exactCoverageRate < 0.6
        ? `Only ${formatPercent(operator.audit.tradeSummary.exactCoverageRate, 0)} of closures are exact right now. Estimated trade outcomes should not drive sizing changes.`
        : "Exact trade coverage is acceptable, but sizing should still follow expectancy and profit factor, not a single headline metric.",
    },
    {
      title: "Do not skip overlay validation before promotion",
      why: operator.overlayCompare
        ? `${operator.overlayCompare.changed_candidates} comparator changes are currently recorded. Promotions should stay scoped and measured before they influence live approvals.`
        : "Without a comparator run, promoted indicators can alter approvals without a measured effect profile.",
    },
  ];

  if (snapshot.news_sentiment.risk_off) {
    mistakes.push({
      title: "Do not ignore the risk-off news flag",
      why: "Risk-off sentiment is active. Expanding exposure into adverse macro tone is a classic way to turn technical setups into low-quality fills.",
    });
  }

  return mistakes.slice(0, 4);
}

const ALL_MONITORED_SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT",
];

function strategySymbols(snapshot: RuntimeSnapshot) {
  const symbols = new Set<string>();

  snapshot.candle_points.forEach((point) => symbols.add(point.symbol));
  snapshot.indicator_points.forEach((point) => symbols.add(point.symbol));
  snapshot.opportunities.forEach((item) => symbols.add(item.symbol));
  snapshot.positions.forEach((position) => symbols.add(position.symbol));
  snapshot.research_models.forEach((model) => {
    if (model.symbol !== "All") {
      symbols.add(model.symbol);
    }
  });

  // If the supervisor hasn't populated multi-symbol data yet (early boot),
  // fall back to the full configured symbol list so the watchlist is never blank.
  if (symbols.size <= 1) {
    ALL_MONITORED_SYMBOLS.forEach((s) => symbols.add(s));
  }

  // Return in canonical order
  return ALL_MONITORED_SYMBOLS.filter((s) => symbols.has(s)).concat(
    Array.from(symbols).filter((s) => !ALL_MONITORED_SYMBOLS.includes(s)),
  );
}

function filterSnapshotForStrategy(snapshot: RuntimeSnapshot, selectedSymbol: string, selectedWindow: number) {
  const effectiveSymbol = selectedSymbol === "All" ? strategySymbols(snapshot)[0] ?? "All" : selectedSymbol;
  const candlePoints = snapshot.candle_points
    .filter((point) => effectiveSymbol === "All" || point.symbol === effectiveSymbol)
    .slice(-selectedWindow);
  const indicatorPoints = snapshot.indicator_points
    .filter((point) => effectiveSymbol === "All" || point.symbol === effectiveSymbol)
    .slice(-selectedWindow);
  const opportunities = snapshot.opportunities.filter((item) => effectiveSymbol === "All" || item.symbol === effectiveSymbol);
  const researchModels = snapshot.research_models.filter((model) => model.symbol === "All" || effectiveSymbol === "All" || model.symbol === effectiveSymbol);

  return {
    candle_points: candlePoints,
    indicator_points: indicatorPoints,
    opportunities,
    research_models: researchModels,
  };
}

function filterTradesForStrategy(trades: AuditClosedTrade[], selectedSymbol: string) {
  if (selectedSymbol === "All") {
    return trades;
  }

  return trades.filter((trade) => trade.symbol === selectedSymbol);
}

type TradeMarker = {
  entryCandleIndex: number;
  exitCandleIndex: number;
  trade: AuditClosedTrade;
};

function buildTradeMarkers(candles: RuntimeCandlePoint[], trades: AuditClosedTrade[]) {
  if (candles.length === 0 || trades.length === 0) {
    return [] as TradeMarker[];
  }

  const sortedTrades = [...trades].sort((left, right) => left.timestamp_ms - right.timestamp_ms);

  return sortedTrades.map((trade) => {
    return {
      entryCandleIndex: nearestCandleIndex(candles, trade.entry_timestamp_ms ?? trade.timestamp_ms),
      exitCandleIndex: nearestCandleIndex(candles, trade.timestamp_ms),
      trade,
    };
  });
}

function nearestCandleIndex(candles: RuntimeCandlePoint[], timestampMs: number) {
  let nearestIndex = 0;
  let nearestDelta = Number.POSITIVE_INFINITY;

  candles.forEach((candle, index) => {
    const delta = Math.abs(candle.timestamp_ms - timestampMs);
    if (delta < nearestDelta) {
      nearestDelta = delta;
      nearestIndex = index;
    }
  });

  return nearestIndex;
}

function headlineForPage(page: DashboardPage) {
  switch (page) {
    case "overview":   return "Overview";
    case "positions":  return "Positions";
    case "markets":    return "Markets";
    case "risk":       return "Risk";
    case "execution":  return "Execution";
    case "review":     return "Review";
    case "settings":   return "Settings";
  }
}

function descriptionForPage(page: DashboardPage) {
  switch (page) {
    case "overview":
      return "The landing page is now intentionally small: profit and loss, current position, top setup, and the mistakes to avoid next.";
    case "positions":
      return "Use this page when you need the live book, balance calendar, and recent closes without extra strategy noise.";
    case "markets":
      return "This is the chart page. It keeps market structure, indicators, queued candidates, and model ranking together like a trading workstation.";
    case "risk":
      return "Risk notes, audit pressure, incidents, and promoted-indicator validation live here instead of leaking into every screen.";
    case "execution":
      return "All operator actions are isolated here so restart, export, comparator, and mode changes do not compete with market analysis.";
    case "review":
      return "Review keeps history, equity curve, and mistakes in one place so performance analysis stays disciplined.";
    case "settings":
      return "This page explains launch posture, shell behavior, overlay state, and why the interface now stays visually restrained.";
  }
}

function labelForPage(page: DashboardPage) {
  return navItems.find((item) => item.page === page)?.label ?? "Dashboard";
}

function metricCardClasses(tone: "positive" | "negative" | "neutral") {
  switch (tone) {
    case "positive":
      return "border-(--success-border) bg-(--success-surface) text-(--success-foreground)";
    case "negative":
      return "border-(--danger-border) bg-(--danger-surface) text-(--danger-foreground)";
    default:
      return "border-[var(--n-line)] bg-[var(--muted)] text-foreground";
  }
}

function balanceToneClasses(tone: AuditBalanceCalendarDay["tone"]) {
  switch (tone) {
    case "green":
      return "border-[color:var(--cal-green-border)] bg-[color:var(--cal-green-surface)] text-[color:var(--cal-green-text)]";
    case "red":
      return "border-[color:var(--cal-red-border)] bg-[color:var(--cal-red-surface)] text-[color:var(--cal-red-text)]";
    case "flat":
      return "border-[var(--n-line)] bg-muted/50 text-foreground/80";
    default:
      return "border-[var(--n-line)] bg-background text-muted-foreground";
  }
}

function toneClasses(tone: string) {
  switch (tone) {
    case "risk":
      return "border-(--danger-border) bg-(--danger-surface) text-(--danger-foreground)";
    case "warn":
      return "border-(--warning-border) bg-(--warning-surface) text-(--warning-foreground)";
    default:
      return "border-(--success-border) bg-(--success-surface) text-(--success-foreground)";
  }
}

function formatStrategyFamily(family: string): string {
  const labels: Record<string, string> = {
    TrendPullbackContinuation: "Trend Pullback",
    BreakoutConfirmation: "Breakout",
    MeanReversion: "Mean Reversion",
    VolatilityCompressionBreakout: "Vol Compression",
    LiquiditySweepReversal: "Liq Sweep",
    MomentumContinuation: "Momentum",
    VwapReversion: "VWAP Reversion",
    SessionSetup: "Session Setup",
    GridTrading: "Grid Trading",
    DeltaNeutral: "Delta Neutral",
    BollingerBandSqueeze: "BB Squeeze",
    NoCandidate: "No Signal",
  };
  return labels[family] ?? family;
}

function actionBadgeClasses(action: string) {
  switch (action.toLowerCase()) {
    case "reject":
      return "border-(--danger-border) bg-(--danger-surface) text-(--danger-foreground)";
    case "watch":
      return "border-(--warning-border) bg-(--warning-surface) text-(--warning-foreground)";
    default:
      return "border-(--success-border) bg-(--success-surface) text-(--success-foreground)";
  }
}

function botHealthBadgeClasses(level: BotHealthReport["level"]) {
  switch (level) {
    case "healthy":
      return "border-(--success-border) bg-(--success-surface) text-(--success-foreground)";
    case "watching":
      return "border-(--warning-border) bg-(--warning-surface) text-(--warning-foreground)";
    case "degraded":
      return "border-(--danger-border) bg-(--danger-surface) text-(--danger-foreground)";
    default:
      return "border-[var(--n-line)] bg-[var(--muted)] text-foreground";
  }
}

function signedValueTextClass(value: number) {
  return value >= 0 ? "text-(--success-foreground)" : "text-(--danger-foreground)";
}

function formatHealthTimestamp(timestampMs: number | null) {
  if (timestampMs === null) {
    return "No data";
  }

  return `${formatTimestampMs(timestampMs)} · ${formatRelativeDuration(timestampMs)}`;
}

function percentUsed(currentCount: number, limit: number) {
  if (limit <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, (currentCount / limit) * 100));
}

function formatUsd(value: number | null, maximumFractionDigits = 2): string {
  if (value === null || !Number.isFinite(value)) {
    return "No data";
  }

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: maximumFractionDigits,
    maximumFractionDigits,
  }).format(value);
}

function formatSignedUsd(value: number | null, maximumFractionDigits = 2): string {
  if (value === null || !Number.isFinite(value)) {
    return "No data";
  }

  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatUsd(Math.abs(value), maximumFractionDigits)}`;
}

function formatNumber(value: number | null, maximumFractionDigits = 2) {
  if (value === null || !Number.isFinite(value)) {
    return "No data";
  }

  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(value);
}

function formatSignedNumber(value: number | null, maximumFractionDigits = 3) {
  if (value === null || !Number.isFinite(value)) {
    return "No data";
  }

  return `${value >= 0 ? "+" : ""}${formatNumber(value, maximumFractionDigits)}`;
}

function formatPercent(value: number | null, maximumFractionDigits = 1): string {
  if (value === null || !Number.isFinite(value)) {
    return "No data";
  }

  return new Intl.NumberFormat(undefined, {
    style: "percent",
    minimumFractionDigits: maximumFractionDigits,
    maximumFractionDigits,
  }).format(value);
}

function formatPercentDelta(value: number | null, maximumFractionDigits = 1): string {
  if (value === null || !Number.isFinite(value)) {
    return "No data";
  }

  return `${value >= 0 ? "+" : ""}${new Intl.NumberFormat(undefined, {
    style: "percent",
    minimumFractionDigits: maximumFractionDigits,
    maximumFractionDigits,
  }).format(value)}`;
}

function formatOperatorTimestamp(timestamp: string) {
  const parsed = new Date(timestamp);

  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function formatTimestampMs(timestampMs: number) {
  return formatOperatorTimestamp(new Date(timestampMs).toISOString());
}

function formatRelativeDuration(timestampMs: number) {
  const deltaMs = Date.now() - timestampMs;
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    return "Just now";
  }

  const minutes = Math.floor(deltaMs / (60 * 1000));
  if (minutes < 60) {
    return `${minutes}m open`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h open`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d open`;
}

function formatDurationMs(durationMs: number | null) {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
    return "No data";
  }

  const minutes = Math.floor(durationMs / (60 * 1000));
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 48) {
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

function formatDurationDelta(sliceDurationMs: number | null, overallDurationMs: number | null) {
  if (sliceDurationMs === null || overallDurationMs === null || !Number.isFinite(sliceDurationMs) || !Number.isFinite(overallDurationMs)) {
    return "No data";
  }

  const deltaMs = sliceDurationMs - overallDurationMs;
  const formatted = formatDurationMs(Math.abs(deltaMs));
  if (formatted === "No data") {
    return formatted;
  }

  return `${deltaMs >= 0 ? "+" : "-"}${formatted}`;
}

function resolveHoldDeltaTone(sliceDurationMs: number | null, overallDurationMs: number | null): "positive" | "negative" | "neutral" {
  if (sliceDurationMs === null || overallDurationMs === null || !Number.isFinite(sliceDurationMs) || !Number.isFinite(overallDurationMs)) {
    return "neutral";
  }

  const deltaMs = sliceDurationMs - overallDurationMs;
  if (Math.abs(deltaMs) < 60 * 1000) {
    return "neutral";
  }

  return deltaMs < 0 ? "positive" : "negative";
}

function formatOldestHold(entryTimestampsMs: Array<number | null>) {
  const oldestTimestampMs = entryTimestampsMs
    .filter((value): value is number => value !== null)
    .reduce<number | null>((oldest, value) => (oldest === null || value < oldest ? value : oldest), null);

  return oldestTimestampMs === null ? "No data" : formatRelativeDuration(oldestTimestampMs);
}

function summarizeReviewTrades(trades: AuditClosedTrade[]) {
  const closedTrades = trades.length;
  const wins = trades.filter((trade) => trade.realized_pnl > 1e-8).length;
  const losses = trades.filter((trade) => trade.realized_pnl < -1e-8).length;
  const realizedPnlTotal = trades.reduce((total, trade) => total + trade.realized_pnl, 0);
  const grossProfit = trades
    .filter((trade) => trade.realized_pnl > 1e-8)
    .reduce((total, trade) => total + trade.realized_pnl, 0);
  const grossLossAbs = trades
    .filter((trade) => trade.realized_pnl < -1e-8)
    .reduce((total, trade) => total + Math.abs(trade.realized_pnl), 0);
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

function formatReviewDateRangeSummary(
  reviewDateRange: { startMs: number | null; endMs: number | null },
  filteredTrades: AuditClosedTrade[],
) {
  if (filteredTrades.length === 0) {
    return "No slice";
  }

  const firstTrade = [...filteredTrades].sort((left, right) => left.timestamp_ms - right.timestamp_ms)[0] ?? null;
  const lastTrade = [...filteredTrades].sort((left, right) => right.timestamp_ms - left.timestamp_ms)[0] ?? null;

  if (reviewDateRange.startMs === null && reviewDateRange.endMs === null) {
    return firstTrade && lastTrade
      ? `${formatTimestampMs(firstTrade.timestamp_ms)} -> ${formatTimestampMs(lastTrade.timestamp_ms)}`
      : "Full history";
  }

  const startLabel = reviewDateRange.startMs !== null ? formatTimestampMs(reviewDateRange.startMs) : "Start";
  const endLabel = reviewDateRange.endMs !== null ? formatTimestampMs(reviewDateRange.endMs) : (lastTrade ? formatTimestampMs(lastTrade.timestamp_ms) : "Now");
  return `${startLabel} -> ${endLabel}`;
}

function formatCalendarDay(day: string) {
  const parsed = new Date(`${day}T00:00:00.000Z`);

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(parsed);
}

function createIndexScale(length: number, start: number, end: number) {
  const safeLength = Math.max(length - 1, 1);
  return (index: number) => start + (index / safeLength) * (end - start);
}

function createScale(minValue: number, maxValue: number, start: number, end: number) {
  const spread = maxValue - minValue;
  const safeSpread = spread === 0 ? 1 : spread;

  return (value: number) => start - ((value - minValue) / safeSpread) * (start - end);
}

function polylinePoints(values: number[], scaleX: (index: number) => number, scaleY: (value: number) => number) {
  return values.map((value, index) => `${scaleX(index)},${scaleY(value)}`).join(" ");
}

function ChartGrid({ width, height }: { width: number; height: number }) {
  const stroke = "rgba(128, 140, 160, 0.14)";

  return (
    <g>
      {Array.from({ length: 6 }).map((_, index) => {
        const y = (height / 5) * index;
        return <line key={`y-${index}`} stroke={stroke} strokeWidth="1" x1="0" x2={width} y1={y} y2={y} />;
      })}
      {Array.from({ length: 6 }).map((_, index) => {
        const x = (width / 5) * index;
        return <line key={`x-${index}`} stroke={stroke} strokeWidth="1" x1={x} x2={x} y1="0" y2={height} />;
      })}
    </g>
  );
}