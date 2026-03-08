import { NextRequest, NextResponse } from "next/server";

import { readTradingSettings, saveTradingSettings } from "@/lib/trading-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await readTradingSettings(), {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    binanceEnvironment?: "testnet" | "mainnet";
    transportEnabled?: boolean;
    streamEnabled?: boolean;
    tradingEnabled?: boolean;
    autoStartRuntimeOnOpen?: boolean;
    autoRunOverlayCompareOnOpen?: boolean;
    supervisorIntervalMs?: number;
    researchRefreshIntervalMinutes?: number;
    indicatorPruneMinFitness?: number;
    indicatorRetentionLimit?: number;
    apiKey?: string;
    apiSecret?: string;
  } | null;

  if (!body) {
    return NextResponse.json({ message: "Missing trading settings payload." }, { status: 400 });
  }

  try {
    const settings = await saveTradingSettings({
      binanceEnvironment: body.binanceEnvironment === "mainnet" ? "mainnet" : "testnet",
      transportEnabled: Boolean(body.transportEnabled),
      streamEnabled: Boolean(body.streamEnabled),
      tradingEnabled: Boolean(body.tradingEnabled),
      autoStartRuntimeOnOpen: body.autoStartRuntimeOnOpen !== false,
      autoRunOverlayCompareOnOpen: body.autoRunOverlayCompareOnOpen !== false,
      supervisorIntervalMs: Number.isFinite(body.supervisorIntervalMs) ? Number(body.supervisorIntervalMs) : 500,
      researchRefreshIntervalMinutes: Number.isFinite(body.researchRefreshIntervalMinutes) ? Number(body.researchRefreshIntervalMinutes) : 30,
      indicatorPruneMinFitness: Number.isFinite(body.indicatorPruneMinFitness) ? Number(body.indicatorPruneMinFitness) : 0.05,
      indicatorRetentionLimit: Number.isFinite(body.indicatorRetentionLimit) ? Number(body.indicatorRetentionLimit) : 6,
      apiKey: body.apiKey,
      apiSecret: body.apiSecret,
    });

    return NextResponse.json(settings, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        message: error instanceof Error ? error.message : "Failed to save trading settings.",
      },
      { status: 400 },
    );
  }
}