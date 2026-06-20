import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { computeScopedPaintTakeoff } from "@/lib/extract/scoped-takeoff";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET — scoped per-room PAINT takeoff for one page.
 *
 * Runs the deterministic finish-scope pipeline (seeded rooms → finish notes/
 * tags → bind → decide → per-room height) and returns the contractor-style
 * deliverable: each painted room measured (wall perimeter × the right height,
 * to-deck for stockrooms), plus the rooms tracked-but-excluded (tile/FRP/wet).
 *
 * Room polygons are normalized 0..1 (y-down) so the overlay can fill paint
 * rooms blue and excluded rooms muted, matching how a contractor shades the
 * scoped rooms by hand.
 *
 * `?ai=1` enables the Claude-vision advisory pass on low-confidence rooms (off
 * by default — the deterministic path already reproduces the reference scope).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const page = await db.planPage.findUnique({
    where: { id },
    include: { plan: true },
  });
  if (!page) {
    return NextResponse.json({ error: "Page not found." }, { status: 404 });
  }

  const useAi = new URL(req.url).searchParams.get("ai") === "1";
  const buf = await readFile(path.join(UPLOADS_DIR, page.plan.filePath));

  // Page dimensions (pt) for seeded segmentation + polygon normalization.
  const mupdf = await import("mupdf");
  const doc = (
    mupdf as unknown as {
      Document: {
        openDocument: (d: Uint8Array, m: string) => {
          loadPage: (i: number) => { getBounds: () => number[] };
        };
      };
    }
  ).Document.openDocument(new Uint8Array(buf), "application/pdf");
  const b = doc.loadPage(page.pageNumber - 1).getBounds();
  const pageWidthPt = b[2] - b[0];
  const pageHeightPt = b[3] - b[1];

  const ptPerFoot = page.scaleRatio ?? 18;
  let takeoff;
  try {
    takeoff = await computeScopedPaintTakeoff(buf, page.pageNumber, {
      ptPerFoot,
      pageWidthPt,
      pageHeightPt,
      useAi,
    });
  } catch (err) {
    console.error("[paint-scope] failed:", err);
    return NextResponse.json(
      { error: "Paint-scope takeoff failed." },
      { status: 500 },
    );
  }

  if (!takeoff) {
    // No CAD wall layers / too few room seeds — caller falls back to the wand.
    return NextResponse.json({
      planPageId: id,
      pageNumber: page.pageNumber,
      available: false,
      paintRooms: [],
      excludedRooms: [],
      paintLf: 0,
      paintSqft: 0,
    });
  }

  const norm = (r: (typeof takeoff.paintRooms)[number]) => ({
    label: r.label,
    decision: r.decision,
    finishType: r.decision === "paint" ? "paint" : "excluded",
    basis: r.basis,
    confidence: r.confidence,
    needsReview: r.needsReview,
    reason: r.reason,
    wallPerimeterFt: r.wallPerimeterFt,
    heightFt: r.heightFt,
    heightBasis: r.heightBasis,
    paintAreaSqft: r.paintAreaSqft,
    floorAreaSqft: r.floorAreaSqft,
    points: r.polygonPt.map((p) => ({
      x: p.x / pageWidthPt,
      y: p.y / pageHeightPt,
    })),
  });

  return NextResponse.json({
    planPageId: id,
    pageNumber: page.pageNumber,
    available: true,
    paintRooms: takeoff.paintRooms.map(norm),
    excludedRooms: takeoff.excludedRooms.map(norm),
    paintLf: takeoff.paintLf,
    paintSqft: takeoff.paintSqft,
    ceilingHeightFt: takeoff.ceilingHeightFt,
    ptPerFoot,
    pageWidthPt,
    pageHeightPt,
  });
}
