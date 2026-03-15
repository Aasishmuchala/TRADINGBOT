import { NextResponse } from "next/server";

import { getPositionsData } from "@/lib/dashboard-server";

export const dynamic = "force-dynamic";

export async function GET() {
  const payload = await getPositionsData();

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
