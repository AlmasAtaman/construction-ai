import { NextResponse } from "next/server";
import { runAutoTraceForPage } from "@/lib/takeoff/auto-trace-page";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST — produce a proposed wall-path trace for one page and persist each
 * connected run as a `wall-path` Surface (status "proposed", source
 * "ai", derivation "traced"). The contractor reviews/edits/deletes
 * them; this is the "95% AI, minimal review" entry point.
 *
 * The actual work lives in src/lib/takeoff/auto-trace-page.ts, shared
 * with the whole-plan takeoff (POST /api/plans/[id]/takeoff).
 *
 * Idempotency: deletes any existing AI-proposed wall-path surfaces for
 * the page before re-tracing, so re-running doesn't pile up duplicates.
 * Manually-traced or accepted wall-paths are left untouched unless
 * `reset` is sent.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let reset = false;
  let autoClean = false;
  let wallLayers: string[] | null = null;
  try {
    const body = await req.json();
    reset = body?.reset === true;
    autoClean = body?.autoClean === true;
    if (
      Array.isArray(body?.wallLayers) &&
      body.wallLayers.every((l: unknown) => typeof l === "string")
    ) {
      wallLayers = body.wallLayers;
    }
  } catch {
    /* no body */
  }

  try {
    const result = await runAutoTraceForPage(id, {
      reset,
      autoClean,
      wallLayers,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof Error && err.message === "Page not found") {
      return NextResponse.json({ error: "Page not found." }, { status: 404 });
    }
    throw err;
  }
}
