import { NextRequest, NextResponse } from "next/server";

import { getReviewSliceQueryData } from "@/lib/review-server";

export async function GET(request: NextRequest) {
  const payload = await getReviewSliceQueryData(request.nextUrl.searchParams);
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}