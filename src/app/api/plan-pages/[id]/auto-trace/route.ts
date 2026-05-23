import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { scanVectorPaths } from "@/lib/extract/page-extract";
import { buildWallGraph, type RawSegment } from "@/lib/extract/wall-graph";
import {
  autoTraceWalls,
  filterStrayPolylines,
} from "@/lib/extract/wall-autotrace";
import type { PathPoint } from "@/types/surface";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST — produce a proposed wall-path trace for a page and persist each
 * connected run as a `wall-path` Surface (status "proposed", source
 * "ai", derivation "traced"). The contractor reviews/edits/deletes
 * them; this is the "95% AI, minimal review" entry point.
 *
 * Idempotency: deletes any existing AI-proposed wall-path surfaces for
 * the page before re-tracing, so re-running doesn't pile up duplicates.
 * Manually-traced or accepted wall-paths are left untouched.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // reset=true → "go back to AI walls": wipe ALL wall-paths on the page
  // (manual + accepted + proposed) and regenerate the AI baseline. Default
  // (false) only clears prior AI proposals, preserving the user's own work.
  let reset = false;
  try {
    const body = await req.json();
    reset = body?.reset === true;
  } catch {
    /* no body */
  }
  const page = await db.planPage.findUnique({
    where: { id },
    include: { plan: { include: { project: true } } },
  });
  if (!page) {
    return NextResponse.json({ error: "Page not found." }, { status: 404 });
  }
  const project = page.plan.project;
  const ptPerFoot = page.scaleRatio;
  const ceilingHeightFt = project.ceilingHeightFt;

  const buf = await readFile(path.join(UPLOADS_DIR, page.plan.filePath));
  const { scan, pageWidthPt, pageHeightPt } = await scanVectorPaths(
    buf,
    page.pageNumber,
  );
  const raw: RawSegment[] = [...scan.walls, ...scan.diagonalWalls];
  const graph = buildWallGraph(raw);
  const allPolylines = autoTraceWalls(graph, {
    // Drop sub-foot stubs when a scale is known; else fall back to pt.
    minPolylineLengthPt: ptPerFoot ? ptPerFoot : 12,
  });
  const { kept } = filterStrayPolylines(graph, allPolylines);

  // Clear prior wall-paths so re-running is clean. reset=true wipes the
  // whole set (back-to-AI); otherwise only the prior AI proposals.
  await db.surface.deleteMany({
    where: reset
      ? { planPageId: id, type: "wall-path" }
      : { planPageId: id, type: "wall-path", source: "ai", status: "proposed" },
  });

  // Per-polyline confidence so the review queue's high/medium/low coding
  // is meaningful: longer connected runs are far more likely to be real
  // walls than short fragments. Scaled against the longest run on the page.
  const maxLenPt = kept.reduce((m, pl) => Math.max(m, pl.lengthPt), 0);
  const confidenceFor = (lengthPt: number): number => {
    if (maxLenPt <= 0) return 0.6;
    const score = lengthPt / maxLenPt; // 0..1
    return Math.min(0.95, Math.max(0.55, 0.55 + 0.4 * score));
  };

  const created = [];
  for (const pl of kept) {
    // Normalize to 0..1, y-down (matches the overlay + walls API).
    const pathPoints: PathPoint[] = pl.points.map((p) => ({
      x: p.x / pageWidthPt,
      y: 1 - p.y / pageHeightPt,
      // Auto-trace vertices are real wall-graph vertices → endpoint snap.
      snap: "endpoint",
    }));
    const linearFootage = ptPerFoot ? pl.lengthPt / ptPerFoot : null;
    const squareFootage =
      linearFootage != null ? linearFootage * ceilingHeightFt : null;
    const polygon = pathPoints.map((p) => ({ x: p.x, y: p.y }));
    const surface = await db.surface.create({
      data: {
        projectId: project.id,
        planPageId: id,
        type: "wall-path",
        polygon: JSON.stringify(polygon),
        pathPoints: JSON.stringify(pathPoints),
        linearFootage,
        squareFootage,
        // Default every traced wall to Paint at the project ceiling height;
        // the user reclassifies finish/height in review and the area updates.
        finishType: "paint",
        heightBasis: "ceiling",
        wallHeightFt: ceilingHeightFt,
        confidence: confidenceFor(pl.lengthPt),
        status: "proposed",
        source: "ai",
        derivation: "traced",
      },
    });
    created.push({
      ...surface,
      polygon: JSON.parse(surface.polygon),
      pathPoints: JSON.parse(surface.pathPoints!),
    });
  }

  await db.auditEntry.create({
    data: {
      projectId: project.id,
      action: `Auto-traced ${created.length} wall path${created.length === 1 ? "" : "s"} on page ${page.pageNumber}.`,
      source: "ai",
    },
  });

  return NextResponse.json({
    surfaces: created,
    count: created.length,
    hasScale: ptPerFoot != null,
  });
}
