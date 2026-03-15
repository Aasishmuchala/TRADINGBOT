import { NextResponse } from "next/server";

import { getReviewTradeInspectData } from "@/lib/review-server";

type RouteContext = {
  params: Promise<{
    tradeId: string;
  }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { tradeId } = await context.params;
  const parsedTradeId = Number.parseInt(tradeId, 10);

  if (!Number.isFinite(parsedTradeId)) {
    return NextResponse.json({ error: "invalid trade id" }, { status: 400 });
  }

  const payload = await getReviewTradeInspectData(parsedTradeId);
  if (!payload) {
    return NextResponse.json({ error: "trade not found" }, { status: 404 });
  }

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}