import { NextRequest, NextResponse } from "next/server";

import { applyReviewSlice } from "@/lib/review-server";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { slice_key?: string } | null;
  const sliceKey = body?.slice_key?.trim();

  if (!sliceKey) {
    return NextResponse.json({ error: "slice_key is required" }, { status: 400 });
  }

  return NextResponse.json(applyReviewSlice(sliceKey), {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}