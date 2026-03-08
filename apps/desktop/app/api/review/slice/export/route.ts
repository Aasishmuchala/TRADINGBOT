import { NextRequest, NextResponse } from "next/server";

import { exportReviewSliceData } from "@/lib/review-server";

export async function GET(request: NextRequest) {
  const payload = await exportReviewSliceData(request.nextUrl.searchParams);
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}