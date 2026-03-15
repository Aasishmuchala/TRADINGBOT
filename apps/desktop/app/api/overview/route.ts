import { NextResponse } from "next/server";

import { getOverviewData } from "@/lib/dashboard-server";

export const dynamic = "force-dynamic";

export async function GET() {
  const payload = await getOverviewData();

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
