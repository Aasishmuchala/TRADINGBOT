import { NextResponse } from "next/server";

import { getExecutionPostureData } from "@/lib/dashboard-server";

export async function GET() {
  const payload = await getExecutionPostureData();
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}