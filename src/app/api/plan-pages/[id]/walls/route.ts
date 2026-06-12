import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { scanVectorPaths } from "@/lib/extract/page-extract";
import {
  buildWallGraph,
  wallGraphSegments,
  type RawSegment,
} from "@/lib/extract/wall-graph";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Bump when the cached payload format/coordinate convention changes. */
const WALLS_PAYLOAD_VERSION = 2;

interface WallsPayloadSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface WallsPayload {
  planPageId: string;
  pageNumber: number;
  /**
   * Cache-format version. v2 = unflipped y (scan space is already
   * y-down); v1 caches hold mirrored segments and must be rebuilt.
   */
  version?: number;
  /** Normalized (0..1, y-down). The snap engine on the client uses these. */
  segments: WallsPayloadSegment[];
  /** PDF pt per real foot, mirrored from PlanPage.scaleRatio for convenience. */
  ptPerFoot: number | null;
  pageWidthPt: number;
  pageHeightPt: number;
  /** Diagnostics — number of raw vs. cleaned segments. */
  rawCount: number;
  cleanedCount: number;
  /**
   * "cache" if served from PlanPage.wallsJson, "fresh" if extracted on
   * this request. Useful for debugging cache invalidation.
   */
  source: "cache" | "fresh";
}

/**
 * GET the cleaned wall network for a plan page, normalized to 0..1
 * y-down. First request runs the extractor + wall-graph and persists
 * the result to PlanPage.wallsJson. Subsequent requests serve from
 * cache. Returns null `ptPerFoot` when scale hasn't been established
 * yet — the client should still receive the segments so the user can
 * preview the geometry; measurements just can't convert to feet.
 */
export async function GET(
  _req: Request,
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

  if (page.wallsJson) {
    try {
      const cached = JSON.parse(page.wallsJson) as WallsPayload;
      // v1 caches hold mirrored-y segments — rebuild those.
      if (cached.version === WALLS_PAYLOAD_VERSION) {
        // Always refresh ptPerFoot from the row (scale can change after
        // walls were cached) — keeps the client honest without
        // re-extracting geometry.
        const fresh: WallsPayload = {
          ...cached,
          planPageId: id,
          pageNumber: page.pageNumber,
          ptPerFoot: page.scaleRatio ?? null,
          source: "cache",
        };
        return NextResponse.json(fresh);
      }
    } catch {
      // Corrupted cache — fall through and rebuild.
    }
  }

  const buf = await readFile(path.join(UPLOADS_DIR, page.plan.filePath));
  const { scan, pageWidthPt, pageHeightPt } = await scanVectorPaths(
    buf,
    page.pageNumber,
  );
  const raw: RawSegment[] = [...scan.walls, ...scan.diagonalWalls];
  const graph = buildWallGraph(raw);
  const cleanedPt = wallGraphSegments(graph);

  // Normalize to 0..1 y-down. The mupdf walk device emits top-left-origin
  // y-down coordinates already (verified by overlaying raw scan segments
  // on the rendered raster), so y passes through unflipped — the old
  // `1 - y` published every snap segment vertically mirrored.
  const segments: WallsPayloadSegment[] = cleanedPt.map((s) => ({
    x1: s.x1 / pageWidthPt,
    y1: s.y1 / pageHeightPt,
    x2: s.x2 / pageWidthPt,
    y2: s.y2 / pageHeightPt,
  }));

  const payload: WallsPayload = {
    planPageId: id,
    pageNumber: page.pageNumber,
    version: WALLS_PAYLOAD_VERSION,
    segments,
    ptPerFoot: page.scaleRatio ?? null,
    pageWidthPt,
    pageHeightPt,
    rawCount: raw.length,
    cleanedCount: segments.length,
    source: "fresh",
  };

  // Persist the cache. Strip the run-specific source field so the next
  // load can re-stamp it as "cache".
  const toCache: WallsPayload = { ...payload, source: "cache" };
  await db.planPage.update({
    where: { id },
    data: { wallsJson: JSON.stringify(toCache) },
  });

  return NextResponse.json(payload);
}
