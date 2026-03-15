import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const KEYCHAIN_SERVICE = "sthyra.binance";
const WINCRED_TARGET = "sthyra.binance"; // cmdkey target name
const API_KEY_ACCOUNT = "api-key";
const API_SECRET_ACCOUNT = "api-secret";

export type BinanceEnvironmentSetting = "testnet" | "mainnet";

export type TradingAutomationSettings = {
  autoStartRuntimeOnOpen: boolean;
  autoRunOverlayCompareOnOpen: boolean;
  supervisorIntervalMs: number;
  researchRefreshIntervalMinutes: number;
  indicatorPruneMinFitness: number;
  indicatorRetentionLimit: number;
};

export type TradingSettings = {
  binanceEnvironment: BinanceEnvironmentSetting;
  transportEnabled: boolean;
  streamEnabled: boolean;
  tradingEnabled: boolean;
  hasApiKey: boolean;
  hasApiSecret: boolean;
  credentialsReady: boolean;
  credentialsValidated: boolean | null;
  credentialsValidationMessage: string | null;
  detectedCredentialEnvironment: BinanceEnvironmentSetting | null;
  paperTradingConfigured: boolean;
  paperTradingReady: boolean;
  keychainAvailable: boolean;
  credentialBackend: "keychain" | "wincred" | "env" | "none";
} & TradingAutomationSettings;

type RuntimeEnvConfig = {
  binanceEnvironment: BinanceEnvironmentSetting;
  transportEnabled: boolean;
  streamEnabled: boolean;
  tradingEnabled: boolean;
} & TradingAutomationSettings;

type TradingSettingsInput = {
  binanceEnvironment: BinanceEnvironmentSetting;
  transportEnabled: boolean;
  streamEnabled: boolean;
  tradingEnabled: boolean;
  autoStartRuntimeOnOpen: boolean;
  autoRunOverlayCompareOnOpen: boolean;
  supervisorIntervalMs: number;
  researchRefreshIntervalMinutes: number;
  indicatorPruneMinFitness: number;
  indicatorRetentionLimit: number;
  apiKey?: string;
  apiSecret?: string;
};

// ─── Platform detection ───────────────────────────────────────────────────────

const IS_WINDOWS = process.platform === "win32";

function workspaceRoot() {
  return path.resolve(process.cwd(), "..", "..");
}

function stateDir() {
  if (IS_WINDOWS) {
    const appData = process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? "C:\\Users\\Default", "AppData", "Roaming");
    return path.join(appData, "Sthyra");
  }
  return path.join(workspaceRoot(), ".sthyra");
}

function runtimeEnvPath() {
  return path.join(stateDir(), IS_WINDOWS ? "runtime-env.bat" : "runtime-env.sh");
}

// ─── macOS Keychain ───────────────────────────────────────────────────────────

async function hasSecurityCli() {
  if (IS_WINDOWS) return false;
  try {
    await execFileAsync("/usr/bin/security", ["-h"]);
    return true;
  } catch {
    return false;
  }
}

async function readKeychainSecret(account: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", [
      "find-generic-password",
      "-s", KEYCHAIN_SERVICE,
      "-a", account,
      "-w",
    ]);
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function storeKeychainSecret(account: string, secret: string) {
  await execFileAsync("/usr/bin/security", [
    "add-generic-password",
    "-U",
    "-s", KEYCHAIN_SERVICE,
    "-a", account,
    "-w", secret,
  ]);
}

// ─── Windows Credential Manager ──────────────────────────────────────────────

/** Returns true if cmdkey.exe is reachable (it ships with every Windows since Vista). */
async function hasCredentialManager(): Promise<boolean> {
  if (!IS_WINDOWS) return false;
  try {
    await execFileAsync("cmdkey", ["/list"], { shell: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a secret stored under target "sthyra.binance/<account>" via PowerShell.
 * Requires the CredentialManager module (built-in on Windows 10+).
 *
 * Credential layout:
 *   Target  : sthyra.binance/api-key   (or /api-secret)
 *   Username: account name (same as Target)
 *   Password: the secret value
 */
async function readWinCredential(account: string): Promise<string | null> {
  const target = `${WINCRED_TARGET}/${account}`;
  const script = [
    `$c = Get-StoredCredential -Target '${target}' -ErrorAction SilentlyContinue`,
    `if ($c) { $c.GetNetworkCredential().Password } else { '' }`,
  ].join("; ");

  try {
    const { stdout } = await execFileAsync("powershell", [
      "-NoProfile", "-NonInteractive", "-Command", script,
    ]);
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Store a secret in Windows Credential Manager using cmdkey.
 * cmdkey /add:<target> /user:<account> /pass:<secret>
 */
async function storeWinCredential(account: string, secret: string): Promise<void> {
  const target = `${WINCRED_TARGET}/${account}`;
  await execFileAsync("cmdkey", [
    `/add:${target}`,
    `/user:${account}`,
    `/pass:${secret}`,
  ], { shell: true });
}

// ─── Unified credential layer ─────────────────────────────────────────────────

type CredentialBackend = "keychain" | "wincred" | "env" | "none";

async function detectCredentialBackend(): Promise<CredentialBackend> {
  if (!IS_WINDOWS && (await hasSecurityCli())) return "keychain";
  if (IS_WINDOWS && (await hasCredentialManager())) return "wincred";
  return "none";
}

async function readSecret(account: string, backend: CredentialBackend): Promise<string | null> {
  if (backend === "keychain") return readKeychainSecret(account);
  if (backend === "wincred") return readWinCredential(account);
  return null;
}

async function storeSecret(account: string, secret: string, backend: CredentialBackend): Promise<void> {
  if (backend === "keychain") return storeKeychainSecret(account, secret);
  if (backend === "wincred") return storeWinCredential(account, secret);
  throw new Error("No secure credential store is available on this machine.");
}

// ─── Runtime env file ─────────────────────────────────────────────────────────

function parseEnabledValue(raw: string | undefined, fallback = false) {
  if (!raw) return fallback;
  return raw.trim() === "1";
}

function parseEnvironmentValue(raw: string | undefined): BinanceEnvironmentSetting {
  return raw?.trim() === "0" ? "mainnet" : "testnet";
}

function parseIntegerValue(raw: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function parseFloatValue(raw: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseFloat(raw ?? "");
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function serializeRuntimeEnv(settings: RuntimeEnvConfig): string {
  if (IS_WINDOWS) {
    // Windows .bat format
    return [
      "@echo off",
      "REM Managed by the desktop Settings page.",
      `set STHYRA_BINANCE_USE_TESTNET=${settings.binanceEnvironment === "testnet" ? "1" : "0"}`,
      `set STHYRA_ENABLE_BINANCE_HTTP=${settings.transportEnabled ? "1" : "0"}`,
      `set STHYRA_ENABLE_BINANCE_STREAM=${settings.streamEnabled ? "1" : "0"}`,
      `set STHYRA_ENABLE_BINANCE_TRADING=${settings.tradingEnabled ? "1" : "0"}`,
      `set STHYRA_AUTOSTART_RUNTIME_ON_OPEN=${settings.autoStartRuntimeOnOpen ? "1" : "0"}`,
      `set STHYRA_AUTO_OVERLAY_COMPARE_ON_OPEN=${settings.autoRunOverlayCompareOnOpen ? "1" : "0"}`,
      `set STHYRA_SUPERVISOR_INTERVAL_MS=${settings.supervisorIntervalMs}`,
      `set STHYRA_RESEARCH_REFRESH_INTERVAL_MS=${settings.researchRefreshIntervalMinutes * 60_000}`,
      `set STHYRA_INDICATOR_PRUNE_MIN_FITNESS=${settings.indicatorPruneMinFitness.toFixed(3)}`,
      `set STHYRA_INDICATOR_RETENTION_LIMIT=${settings.indicatorRetentionLimit}`,
      "",
    ].join("\r\n");
  }
  // macOS / Linux .sh format
  return [
    "#!/usr/bin/env zsh",
    "# Managed by the desktop Settings page.",
    `export STHYRA_BINANCE_USE_TESTNET=${settings.binanceEnvironment === "testnet" ? "1" : "0"}`,
    `export STHYRA_ENABLE_BINANCE_HTTP=${settings.transportEnabled ? "1" : "0"}`,
    `export STHYRA_ENABLE_BINANCE_STREAM=${settings.streamEnabled ? "1" : "0"}`,
    `export STHYRA_ENABLE_BINANCE_TRADING=${settings.tradingEnabled ? "1" : "0"}`,
    `export STHYRA_AUTOSTART_RUNTIME_ON_OPEN=${settings.autoStartRuntimeOnOpen ? "1" : "0"}`,
    `export STHYRA_AUTO_OVERLAY_COMPARE_ON_OPEN=${settings.autoRunOverlayCompareOnOpen ? "1" : "0"}`,
    `export STHYRA_SUPERVISOR_INTERVAL_MS=${settings.supervisorIntervalMs}`,
    `export STHYRA_RESEARCH_REFRESH_INTERVAL_MS=${settings.researchRefreshIntervalMinutes * 60_000}`,
    `export STHYRA_INDICATOR_PRUNE_MIN_FITNESS=${settings.indicatorPruneMinFitness.toFixed(3)}`,
    `export STHYRA_INDICATOR_RETENTION_LIMIT=${settings.indicatorRetentionLimit}`,
    "",
  ].join("\n");
}

async function readRuntimeEnvConfig(): Promise<RuntimeEnvConfig> {
  try {
    const raw = await readFile(runtimeEnvPath(), "utf8");
    const values = new Map<string, string>();

    for (const line of raw.split(/\r?\n/)) {
      // Handles both "export KEY=VALUE" (sh) and "set KEY=VALUE" (bat)
      const match = line.match(/^\s*(?:export\s+|set\s+)?([A-Z0-9_]+)=(.+)\s*$/);
      if (!match) continue;
      const [, key, value] = match;
      values.set(key, value.replace(/^['"]|['"]$/g, ""));
    }

    return {
      binanceEnvironment: parseEnvironmentValue(values.get("STHYRA_BINANCE_USE_TESTNET")),
      transportEnabled: parseEnabledValue(values.get("STHYRA_ENABLE_BINANCE_HTTP"), false),
      streamEnabled: parseEnabledValue(values.get("STHYRA_ENABLE_BINANCE_STREAM"), false),
      tradingEnabled: parseEnabledValue(values.get("STHYRA_ENABLE_BINANCE_TRADING"), false),
      autoStartRuntimeOnOpen: parseEnabledValue(values.get("STHYRA_AUTOSTART_RUNTIME_ON_OPEN"), true),
      autoRunOverlayCompareOnOpen: parseEnabledValue(values.get("STHYRA_AUTO_OVERLAY_COMPARE_ON_OPEN"), true),
      supervisorIntervalMs: parseIntegerValue(values.get("STHYRA_SUPERVISOR_INTERVAL_MS"), 500, 100, 5_000),
      researchRefreshIntervalMinutes: Math.round(
        parseIntegerValue(values.get("STHYRA_RESEARCH_REFRESH_INTERVAL_MS"), 30 * 60_000, 60_000, 24 * 60 * 60 * 1000) / 60_000,
      ),
      indicatorPruneMinFitness: parseFloatValue(values.get("STHYRA_INDICATOR_PRUNE_MIN_FITNESS"), 0.05, -0.5, 1),
      indicatorRetentionLimit: parseIntegerValue(values.get("STHYRA_INDICATOR_RETENTION_LIMIT"), 6, 1, 32),
    };
  } catch {
    return {
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
    };
  }
}

export async function readTradingAutomationSettings(): Promise<TradingAutomationSettings> {
  const runtimeConfig = await readRuntimeEnvConfig();
  return {
    autoStartRuntimeOnOpen: runtimeConfig.autoStartRuntimeOnOpen,
    autoRunOverlayCompareOnOpen: runtimeConfig.autoRunOverlayCompareOnOpen,
    supervisorIntervalMs: runtimeConfig.supervisorIntervalMs,
    researchRefreshIntervalMinutes: runtimeConfig.researchRefreshIntervalMinutes,
    indicatorPruneMinFitness: runtimeConfig.indicatorPruneMinFitness,
    indicatorRetentionLimit: runtimeConfig.indicatorRetentionLimit,
  };
}

// ─── Binance credential validation ────────────────────────────────────────────

function restBaseUrl(environment: BinanceEnvironmentSetting) {
  return environment === "testnet" ? "https://testnet.binancefuture.com" : "https://fapi.binance.com";
}

function environmentLabel(environment: BinanceEnvironmentSetting) {
  return environment === "testnet" ? "Binance Futures testnet" : "Binance Futures mainnet";
}

async function validateBinanceCredentials(
  apiKey: string,
  apiSecret: string,
  environment: BinanceEnvironmentSetting,
) {
  const timestamp = Date.now().toString();
  const query = `timestamp=${timestamp}`;
  const signature = createHmac("sha256", apiSecret).update(query).digest("hex");

  try {
    const response = await fetch(`${restBaseUrl(environment)}/fapi/v2/account?${query}&signature=${signature}`, {
      method: "GET",
      headers: { "X-MBX-APIKEY": apiKey },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });

    const payload = (await response.json().catch(() => null)) as { code?: number; msg?: string } | null;
    if (response.ok) {
      return { credentialsValidated: true, credentialsValidationMessage: null };
    }
    return {
      credentialsValidated: false,
      credentialsValidationMessage: payload?.msg ?? `${environmentLabel(environment)} returned HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      credentialsValidated: false,
      credentialsValidationMessage: error instanceof Error ? error.message : "Credential validation failed.",
    };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function readTradingSettings(): Promise<TradingSettings> {
  const runtimeConfig = await readRuntimeEnvConfig();
  const backend = await detectCredentialBackend();
  const keychainAvailable = backend === "keychain" || backend === "wincred";

  const [storedApiKey, storedApiSecret] = keychainAvailable
    ? await Promise.all([readSecret(API_KEY_ACCOUNT, backend), readSecret(API_SECRET_ACCOUNT, backend)])
    : [null, null];

  const envApiKey = process.env.STHYRA_BINANCE_API_KEY?.trim() || null;
  const envApiSecret = process.env.STHYRA_BINANCE_API_SECRET?.trim() || null;

  const apiKey = storedApiKey || envApiKey;
  const apiSecret = storedApiSecret || envApiSecret;
  const hasApiKey = Boolean(apiKey);
  const hasApiSecret = Boolean(apiSecret);
  const credentialsReady = hasApiKey && hasApiSecret;

  const selectedEnvironment: BinanceEnvironmentSetting = runtimeConfig.binanceEnvironment;
  const alternateEnvironment: BinanceEnvironmentSetting = selectedEnvironment === "testnet" ? "mainnet" : "testnet";

  const validation =
    credentialsReady && apiKey && apiSecret
      ? await validateBinanceCredentials(apiKey, apiSecret, selectedEnvironment)
      : { credentialsValidated: null as null, credentialsValidationMessage: null };

  const alternateValidation =
    credentialsReady && apiKey && apiSecret && validation.credentialsValidated === false
      ? await validateBinanceCredentials(apiKey, apiSecret, alternateEnvironment)
      : { credentialsValidated: null as null, credentialsValidationMessage: null };

  const detectedCredentialEnvironment = alternateValidation.credentialsValidated
    ? alternateEnvironment
    : validation.credentialsValidated
      ? selectedEnvironment
      : null;

  const paperTradingConfigured =
    runtimeConfig.transportEnabled && runtimeConfig.streamEnabled && !runtimeConfig.tradingEnabled && credentialsReady;

  let credentialsValidationMessage = validation.credentialsValidationMessage;
  if (validation.credentialsValidated === false && alternateValidation.credentialsValidated === true) {
    credentialsValidationMessage = `Credentials are valid for ${environmentLabel(alternateEnvironment)}, but the app is configured for ${environmentLabel(selectedEnvironment)}.`;
  }

  const credentialBackend: CredentialBackend =
    storedApiKey || storedApiSecret ? backend : envApiKey || envApiSecret ? "env" : "none";

  return {
    ...runtimeConfig,
    hasApiKey,
    hasApiSecret,
    credentialsReady,
    credentialsValidated: validation.credentialsValidated,
    credentialsValidationMessage,
    detectedCredentialEnvironment,
    paperTradingConfigured,
    paperTradingReady: paperTradingConfigured && validation.credentialsValidated === true,
    keychainAvailable,
    credentialBackend,
  };
}

export async function saveTradingSettings(input: TradingSettingsInput): Promise<TradingSettings> {
  const backend = await detectCredentialBackend();
  if (backend === "none") {
    throw new Error(
      IS_WINDOWS
        ? "Windows Credential Manager is unavailable. Ensure cmdkey.exe and PowerShell CredentialManager module are accessible."
        : "macOS Keychain CLI is unavailable on this machine.",
    );
  }

  const apiKey = input.apiKey?.trim();
  const apiSecret = input.apiSecret?.trim();

  if (apiKey) await storeSecret(API_KEY_ACCOUNT, apiKey, backend);
  if (apiSecret) await storeSecret(API_SECRET_ACCOUNT, apiSecret, backend);

  const persistedApiKey = (await readSecret(API_KEY_ACCOUNT, backend)) !== null;
  const persistedApiSecret = (await readSecret(API_SECRET_ACCOUNT, backend)) !== null;

  if (input.transportEnabled && (!persistedApiKey || !persistedApiSecret)) {
    throw new Error("Binance paper transport requires both an API key and API secret.");
  }

  await mkdir(stateDir(), { recursive: true });
  await writeFile(
    runtimeEnvPath(),
    serializeRuntimeEnv({
      binanceEnvironment: input.binanceEnvironment,
      transportEnabled: input.transportEnabled,
      streamEnabled: input.streamEnabled,
      tradingEnabled: input.tradingEnabled,
      autoStartRuntimeOnOpen: input.autoStartRuntimeOnOpen,
      autoRunOverlayCompareOnOpen: input.autoRunOverlayCompareOnOpen,
      supervisorIntervalMs: parseIntegerValue(String(input.supervisorIntervalMs), 500, 100, 5_000),
      researchRefreshIntervalMinutes: parseIntegerValue(String(input.researchRefreshIntervalMinutes), 30, 1, 1_440),
      indicatorPruneMinFitness: parseFloatValue(String(input.indicatorPruneMinFitness), 0.05, -0.5, 1),
      indicatorRetentionLimit: parseIntegerValue(String(input.indicatorRetentionLimit), 6, 1, 32),
    }),
    "utf8",
  );

  return readTradingSettings();
}
