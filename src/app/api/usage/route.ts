import { NextResponse } from "next/server";
import { getDailySpend, getDailySpendPercent } from "@/lib/rate-limit";
import { DAILY_SPEND_CEILING_USD } from "@/lib/constants";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [spend, percent] = await Promise.all([
      getDailySpend(),
      getDailySpendPercent(),
    ]);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const byEndpoint = await db.apiUsage.groupBy({
      by: ["endpoint"],
      where: { createdAt: { gte: today } },
      _sum: { estimatedCost: true, inputTokens: true, outputTokens: true },
      _count: true,
    });

    return NextResponse.json({
      spend,
      ceiling: DAILY_SPEND_CEILING_USD,
      percent,
      breakdown: byEndpoint.map((row) => ({
        endpoint: row.endpoint,
        cost: row._sum.estimatedCost ?? 0,
        inputTokens: row._sum.inputTokens ?? 0,
        outputTokens: row._sum.outputTokens ?? 0,
        calls: row._count,
      })),
    });
  } catch {
    return NextResponse.json(
      {
        spend: 0,
        ceiling: DAILY_SPEND_CEILING_USD,
        percent: 0,
        breakdown: [],
      },
      { status: 200 },
    );
  }
}
