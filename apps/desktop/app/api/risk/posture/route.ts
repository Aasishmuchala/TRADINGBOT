import { NextResponse } from "next/server";

import { getRiskPostureData } from "@/lib/dashboard-server";

export async function GET() {
  const payload = await getRiskPostureData();
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}