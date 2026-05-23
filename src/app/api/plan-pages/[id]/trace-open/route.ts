import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { db } from "@/lib/db";
import { traceOpenRoomAt } from "@/lib/extract/page-extract";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  // Click point in overlay space: normalized 0..1, y-down.
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

/**
 * POST — trace an open-plan room around a click. The click-a-room wand
 * calls this only when the click landed in no enclosed wall face. We run
 * the virtual-partition engine for that one point and return a boundary
 * polygon (normalized 0..1, y-down, matching the overlay) plus the
 * room's label and measured dimensions. Returns `{ room: null }` when the
 * open zone can't be bounded confidently — the wand then asks the user to
 * draw it manually rather than inventing a boundary.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Send a click point { x, y } in normalized 0..1 coords." },
      { status: 400 },
    );
  }

  const page = await db.planPage.findUnique({
    where: { id },
    include: { plan: true },
  });
  if (!page) {
    return NextResponse.json({ error: "Page not found." }, { status: 404 });
  }
  if (page.scaleRatio == null || page.scaleRatio <= 0) {
    return NextResponse.json(
      {
        error:
          "Set the page scale first — open-room tracing needs a scale to measure against.",
        needsScale: true,
      },
      { status: 409 },
    );
  }

  const buf = await readFile(path.join(UPLOADS_DIR, page.plan.filePath));
  const trace = await traceOpenRoomAt(
    buf,
    page.pageNumber,
    { x: parsed.data.x, y: parsed.data.y },
    page.scaleRatio,
  );

  if (!trace) {
    return NextResponse.json({ room: null });
  }

  // PDF pt (y-up) → normalized 0..1 (y-down), matching SurfaceOverlay.
  const points = trace.polygonPt.map((p) => ({
    x: p.x / trace.pageWidthPt,
    y: 1 - p.y / trace.pageHeightPt,
  }));

  return NextResponse.json({
    room: {
      points,
      label: trace.label,
      widthFt: trace.widthFt,
      heightFt: trace.heightFt,
      areaSqft: trace.areaSqft,
      warning: trace.warning,
    },
    ptPerFoot: page.scaleRatio,
    pageWidthPt: trace.pageWidthPt,
    pageHeightPt: trace.pageHeightPt,
  });
}
