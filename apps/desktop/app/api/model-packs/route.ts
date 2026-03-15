import { NextResponse } from "next/server";

import { getModelPacksData } from "@/lib/dashboard-server";

export async function GET() {
  const payload = await getModelPacksData();
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}