import { NextRequest, NextResponse } from "next/server";

import { getReviewRankedSlicesData } from "@/lib/review-server";

export async function GET(request: NextRequest) {
  const payload = await getReviewRankedSlicesData(request.nextUrl.searchParams);
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}