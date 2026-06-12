import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { classifyPlanPages } from "@/lib/ai/classify-plan";
import {
  ensurePageScale,
  runAutoTraceForPage,
} from "@/lib/takeoff/auto-trace-page";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageTakeoffSummary {
  planPageId: string;
  pageNumber: number;
  pageType: string | null;
  status: "traced" | "needs-scale" | "no-walls" | "up-to-date" | "error";
  method: "layers" | "geometry" | null;
  count: number;
  /** Walls already kept from a previous run (identical geometry). */
  skippedExisting: number;
  linearFt: number | null;
  hasScale: boolean;
}

/**
 * POST — one-click takeoff for the WHOLE plan: classify every sheet
 * (cached Haiku), auto-establish each floor plan's scale from its printed
 * notation, then run the wall takeoff (CAD-layer path with geometry
 * fallback) on every visible floor-plan page. Each page's walls land in
 * the review queue as proposals.
 *
 * Heads-up encoded in the response rather than hidden: the same walls
 * often appear on several sheets (construction plan, finish plan, RCP
 * key…). Proposals stay per-page; the contractor accepts the sheet(s)
 * they're actually bidding from, so accepting two sheets of the same
 * floor double-counts.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const plan = await db.plan.findUnique({ where: { id } });
  if (!plan) {
    return NextResponse.json({ error: "Plan not found." }, { status: 404 });
  }

  // 1. Make sure every page is classified (resumable — already-classified
  // pages are returned as-is, so this is free after the first run).
  try {
    await classifyPlanPages(id);
  } catch (err) {
    console.error("[plan-takeoff] classification failed, continuing:", err);
  }

  // 2. Take off every visible floor plan.
  const pages = await db.planPage.findMany({
    where: { planId: id, hidden: false, pageType: "floor_plan" },
    orderBy: { pageNumber: "asc" },
    include: { plan: true },
  });

  const results: PageTakeoffSummary[] = [];
  for (const page of pages) {
    const base = {
      planPageId: page.id,
      pageNumber: page.pageNumber,
      pageType: page.pageType,
    };
    try {
      const ptPerFoot = await ensurePageScale(page);
      const r = await runAutoTraceForPage(page.id, { autoClean: true });
      const linearFt = ptPerFoot
        ? (r.surfaces as Array<{ linearFootage: number | null }>).reduce(
            (t, s) => t + (s.linearFootage ?? 0),
            0,
          )
        : null;
      results.push({
        ...base,
        status:
          r.count === 0
            ? r.skippedExisting > 0
              ? "up-to-date"
              : "no-walls"
            : ptPerFoot
              ? "traced"
              : "needs-scale",
        method: r.method,
        count: r.count,
        skippedExisting: r.skippedExisting,
        linearFt,
        hasScale: ptPerFoot != null,
      });
    } catch (err) {
      console.error(
        `[plan-takeoff] page ${page.pageNumber} failed:`,
        err,
      );
      results.push({
        ...base,
        status: "error",
        method: null,
        count: 0,
        skippedExisting: 0,
        linearFt: null,
        hasScale: page.scaleRatio != null,
      });
    }
  }

  return NextResponse.json({
    planId: id,
    pages: results,
    tracedPages: results.filter((r) => r.status === "traced").length,
    totalWalls: results.reduce((t, r) => t + r.count, 0),
  });
}
