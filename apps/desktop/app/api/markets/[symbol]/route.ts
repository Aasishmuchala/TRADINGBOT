import { NextResponse } from "next/server";

import { getMarketsData } from "@/lib/dashboard-server";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ symbol: string }> },
) {
  const params = await context.params;
  const payload = await getMarketsData(decodeURIComponent(params.symbol));

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
