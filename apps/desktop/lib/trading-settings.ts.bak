import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const KEYCHAIN_SERVICE = "sthyra.binance";
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

function workspaceRoot() {
  return path.resolve(process.cwd(), "..", "..");
}

function stateDir() {
  return path.join(workspaceRoot(), ".sthyra");
}

function runtimeEnvPath() {
  return path.join(stateDir(), "runtime-env.sh");
}

function parseEnabledValue(raw: string | undefined, fallback = false) {
  if (!raw) {
    return fallback;
  }

  return raw.trim() === "1";
}

function parseEnvironmentValue(raw: string | undefined): BinanceEnvironmentSetting {
  return raw?.trim() === "0" ? "mainnet" : "testnet";
}

function parseIntegerValue(raw: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}

function parseFloatValue(raw: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseFloat(raw ?? "");
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}

function serializeRuntimeEnv(settings: RuntimeEnvConfig) {
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
      const match = line.match(/^\s*export\s+([A-Z0-9_]+)=(.+)\s*$/);
      if (!match) {
        continue;
      }

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

async function hasSecurityCli() {
  try {
    await execFileAsync("/usr/bin/security", ["-h"]);
    return true;
  } catch {
    return false;
  }
}

async function readKeychainSecret(account: string) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      account,
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
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    account,
    "-w",
    secret,
  ]);
}

function restBaseUrl(environment: BinanceEnvironmentSetting) {
  return environment === "testnet" ? "https://testnet.binancefuture.com" : "https://fapi.binance.com";
}

function environmentLabel(environment: BinanceEnvironmentSetting) {
  return environment === "testnet" ? "Binance Futures testnet" : "Binance Futures mainnet";
}

async function validateBinanceCredentials(apiKey: string, apiSecret: string, environment: BinanceEnvironmentSetting) {
  const timestamp = Date.now().toString();
  const query = `timestamp=${timestamp}`;
  const signature = createHmac("sha256", apiSecret).update(query).digest("hex");

  try {
    const response = await fetch(`${restBaseUrl(environment)}/fapi/v2/account?${query}&signature=${signature}`, {
      method: "GET",
      headers: {
        "X-MBX-APIKEY": apiKey,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });

    const payload = (await response.json().catch(() => null)) as { code?: number; msg?: string } | null;
    if (response.ok) {
      return {
        credentialsValidated: true,
        credentialsValidationMessage: null,
      };
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

export async function readTradingSettings(): Promise<TradingSettings> {
  const runtimeConfig = await readRuntimeEnvConfig();
  const keychainAvailable = await hasSecurityCli();
  const [apiKey, apiSecret] = keychainAvailable
    ? await Promise.all([readKeychainSecret(API_KEY_ACCOUNT), readKeychainSecret(API_SECRET_ACCOUNT)])
    : [null, null];

  const envApiKey = process.env.STHYRA_BINANCE_API_KEY?.trim() || null;
  const envApiSecret = process.env.STHYRA_BINANCE_API_SECRET?.trim() || null;

  const hasApiKey = Boolean(apiKey || envApiKey);
  const hasApiSecret = Boolean(apiSecret || envApiSecret);
  const credentialsReady = hasApiKey && hasApiSecret;
  const credentialSource = {
    apiKey: apiKey || envApiKey,
    apiSecret: apiSecret || envApiSecret,
  };
  const selectedEnvironment: BinanceEnvironmentSetting = runtimeConfig.binanceEnvironment;
  const alternateEnvironment: BinanceEnvironmentSetting = selectedEnvironment === "testnet" ? "mainnet" : "testnet";
  const validation = credentialsReady && credentialSource.apiKey && credentialSource.apiSecret
    ? await validateBinanceCredentials(credentialSource.apiKey, credentialSource.apiSecret, selectedEnvironment)
    : { credentialsValidated: null, credentialsValidationMessage: null };
  const alternateValidation = credentialsReady && credentialSource.apiKey && credentialSource.apiSecret && validation.credentialsValidated === false
    ? await validateBinanceCredentials(credentialSource.apiKey, credentialSource.apiSecret, alternateEnvironment)
    : { credentialsValidated: null, credentialsValidationMessage: null };
  const detectedCredentialEnvironment = alternateValidation.credentialsValidated ? alternateEnvironment : validation.credentialsValidated ? selectedEnvironment : null;
  const paperTradingConfigured =
    runtimeConfig.transportEnabled && runtimeConfig.streamEnabled && !runtimeConfig.tradingEnabled && credentialsReady;

  let credentialsValidationMessage = validation.credentialsValidationMessage;
  if (validation.credentialsValidated === false && alternateValidation.credentialsValidated === true) {
    credentialsValidationMessage = `Credentials are valid for ${environmentLabel(alternateEnvironment)}, but the app is configured for ${environmentLabel(selectedEnvironment)}.`;
  }

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
  };
}

export async function saveTradingSettings(input: TradingSettingsInput): Promise<TradingSettings> {
  const keychainAvailable = await hasSecurityCli();
  if (!keychainAvailable) {
    throw new Error("macOS keychain access is unavailable on this machine.");
  }

  const apiKey = input.apiKey?.trim();
  const apiSecret = input.apiSecret?.trim();

  if (apiKey) {
    await storeKeychainSecret(API_KEY_ACCOUNT, apiKey);
  }

  if (apiSecret) {
    await storeKeychainSecret(API_SECRET_ACCOUNT, apiSecret);
  }

  const persistedApiKey = (await readKeychainSecret(API_KEY_ACCOUNT)) !== null;
  const persistedApiSecret = (await readKeychainSecret(API_SECRET_ACCOUNT)) !== null;

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