import { NextRequest, NextResponse } from "next/server";

import { getIncidentsData } from "@/lib/dashboard-server";

export async function GET(request: NextRequest) {
  const limitParam = request.nextUrl.searchParams.get("limit");
  const parsedLimit = Number.parseInt(limitParam ?? "20", 10);
  const payload = await getIncidentsData(Number.isFinite(parsedLimit) ? parsedLimit : 20);
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}