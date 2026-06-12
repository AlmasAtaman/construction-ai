import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pdf } from "pdf-to-img";
import sharp from "sharp";
import { db } from "@/lib/db";
import { scanVectorPaths } from "@/lib/extract/page-extract";
import { buildWallGraph, type RawSegment } from "@/lib/extract/wall-graph";
import {
  autoTraceWalls,
  filterStrayPolylines,
  type TracedPolyline,
} from "@/lib/extract/wall-autotrace";
import { detectWallRegions, type WallRegion } from "@/lib/ai/wall-region";
import { hasApiKey } from "@/lib/anthropic";
import { scanSegmentsByLayer } from "@/lib/extract/layer-scan";
import {
  classifyLayers,
  type LayerRole,
} from "@/lib/extract/layer-classify";
import {
  traceWallsFromLayers,
  LAYER_TRACE_CONFIDENCE,
  type LayerPolyline,
} from "@/lib/extract/layer-takeoff";
import { classifyLayerNamesWithAi } from "@/lib/ai/layer-names";
import type { PathPoint } from "@/types/surface";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Margin (fraction of page) added around an AI region box so walls right on
// the footprint edge aren't clipped.
const REGION_MARGIN = 0.02;

/** Render one page to a small JPEG for the vision region detector. */
async function renderPageJpeg(
  buf: Buffer,
  pageNumber: number,
): Promise<string | null> {
  try {
    const doc = await pdf(buf, { scale: 1.5 });
    let n = 0;
    for await (const img of doc) {
      n += 1;
      if (n === pageNumber) {
        const jpeg = await sharp(img)
          .resize({ width: 1400, height: 1400, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toBuffer();
        return jpeg.toString("base64");
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Keep only traced polylines inside the SINGLE best floor-plan region (the
 * one holding the most wall-length). This drops the duplicate stacked plan,
 * schedules/notes, and margin dimension strings that the raw vector trace
 * otherwise grabs. Falls back to all polylines if no region clearly wins.
 */
function filterToBestRegion(
  polylines: TracedPolyline[],
  regions: WallRegion[],
  pageWidthPt: number,
  pageHeightPt: number,
): { polylines: TracedPolyline[]; region: WallRegion | null } {
  const midNorm = (pl: TracedPolyline): { x: number; y: number } => {
    let sx = 0;
    let sy = 0;
    for (const p of pl.points) {
      sx += p.x;
      sy += p.y;
    }
    const cx = sx / pl.points.length / pageWidthPt;
    const cy = 1 - sy / pl.points.length / pageHeightPt; // pt y-up → norm y-down
    return { x: cx, y: cy };
  };
  const inside = (r: WallRegion, x: number, y: number): boolean =>
    x >= r.x0 - REGION_MARGIN &&
    x <= r.x1 + REGION_MARGIN &&
    y >= r.y0 - REGION_MARGIN &&
    y <= r.y1 + REGION_MARGIN;

  let best: WallRegion | null = null;
  let bestLen = 0;
  for (const r of regions) {
    let len = 0;
    for (const pl of polylines) {
      const m = midNorm(pl);
      if (inside(r, m.x, m.y)) len += pl.lengthPt;
    }
    if (len > bestLen) {
      bestLen = len;
      best = r;
    }
  }
  if (!best || bestLen === 0) return { polylines, region: null };
  const region = best;
  return {
    polylines: polylines.filter((pl) => {
      const m = midNorm(pl);
      return inside(region, m.x, m.y);
    }),
    region,
  };
}

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
  // autoClean (used by one-click "AI Takeoff") drops low-confidence noise at
  // creation so the user lands on a clean set instead of hundreds of stray
  // fragments to reject by hand.
  let autoClean = false;
  // Explicit CAD-layer selection from the layers panel; null = use the
  // classified default (wall-new + wall-existing layers).
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

  // ---- Preferred path: CAD layers (PDF optional content). When the PDF
  // preserves the architect's layer structure, walls vs dimensions vs
  // hatching is a metadata lookup — deterministic, exact, and free. Any
  // failure here falls through to the geometry+AI path unchanged.
  let layerPolylines: LayerPolyline[] | null = null;
  let layerSummary: Array<{
    name: string;
    role: LayerRole;
    segments: number;
  }> = [];
  let wallLayersUsed: string[] = [];
  let pageWidthPt = 0;
  let pageHeightPt = 0;
  try {
    const layerScan = await scanSegmentsByLayer(buf, page.pageNumber);
    pageWidthPt = layerScan.pageWidthPt;
    pageHeightPt = layerScan.pageHeightPt;
    if (layerScan.layerNames.length > 0) {
      const present = Object.keys(layerScan.segmentsPerLayer);
      const classified = classifyLayers(present);
      const roleFor: Record<string, LayerRole> = Object.fromEntries(
        classified.map((c) => [c.name, c.role]),
      );
      const hasWallLayer = classified.some(
        (c) => c.role === "wall-new" || c.role === "wall-existing",
      );
      if (!hasWallLayer && hasApiKey()) {
        // Exotic/foreign naming the regex doesn't know — one cached,
        // text-only Haiku call over the unmatched names.
        const aiRoles = await classifyLayerNamesWithAi(
          classified.filter((c) => c.role === "other").map((c) => c.name),
        );
        Object.assign(roleFor, aiRoles);
      }
      layerSummary = present.map((name) => ({
        name,
        role: roleFor[name] ?? "other",
        segments: layerScan.segmentsPerLayer[name],
      }));
      const result = traceWallsFromLayers(layerScan, roleFor, {
        wallLayers: wallLayers ?? undefined,
        ptPerFoot,
      });
      if (result.ok) {
        layerPolylines = result.polylines;
        wallLayersUsed = result.wallLayersUsed;
      }
    }
    // Cache the layer summary for the layers panel (cheap to rebuild, but
    // this saves a full vector scan per panel open).
    await db.planPage.update({
      where: { id },
      data: { layersJson: JSON.stringify({ layers: layerSummary }) },
    });
  } catch (err) {
    console.error("[auto-trace] layer path failed, using geometry:", err);
  }

  // ---- Fallback path: full-sheet geometry + AI region scoping (flattened
  // PDFs with no layer metadata).
  let regionScoped: TracedPolyline[] = [];
  let regionUsed = false;
  if (!layerPolylines) {
    const { scan, pageWidthPt: w, pageHeightPt: h } = await scanVectorPaths(
      buf,
      page.pageNumber,
    );
    pageWidthPt = w;
    pageHeightPt = h;
    const raw: RawSegment[] = [...scan.walls, ...scan.diagonalWalls];
    const graph = buildWallGraph(raw);
    const allPolylines = autoTraceWalls(graph, {
      // Drop sub-foot stubs when a scale is known; else fall back to pt.
      minPolylineLengthPt: ptPerFoot ? ptPerFoot : 12,
    });
    const { kept } = filterStrayPolylines(graph, allPolylines);

    // AI region filter (one-click AI Takeoff): keep only walls inside the
    // single best floor-plan footprint, dropping the duplicate stacked plan,
    // schedules, and margin dimension strings.
    regionScoped = kept;
    if (autoClean && hasApiKey()) {
      const imageBase64 = await renderPageJpeg(buf, page.pageNumber);
      if (imageBase64) {
        try {
          const { regions } = await detectWallRegions({
            imageBase64,
            imageMediaType: "image/jpeg",
          });
          if (regions.length > 0) {
            const { polylines: scoped } = filterToBestRegion(
              kept,
              regions,
              pageWidthPt,
              pageHeightPt,
            );
            if (scoped.length > 0) {
              // Region scoping drops the duplicate plan + schedules. (A 2nd
              // vision-classification pass was tried and removed: at the
              // density of dimension/tile noise on commercial plans the model
              // can't separate walls from dimensions, so it didn't filter.)
              regionScoped = scoped;
              regionUsed = true;
            }
          }
        } catch {
          /* fall back to the unfiltered set */
        }
      }
    }
  }

  // Clear prior wall-paths so re-running is clean. reset=true wipes the
  // whole set (back-to-AI); otherwise only the prior AI proposals.
  await db.surface.deleteMany({
    where: reset
      ? { planPageId: id, type: "wall-path" }
      : { planPageId: id, type: "wall-path", source: "ai", status: "proposed" },
  });

  // Per-polyline confidence so the review queue's high/medium/low coding
  // is meaningful. Geometry-derived runs scale with length (longer
  // connected runs are far more likely to be real walls); layer-derived
  // runs carry deterministic provenance and get a flat high confidence.
  const maxLenPt = regionScoped.reduce((m, pl) => Math.max(m, pl.lengthPt), 0);
  const confidenceFor = (lengthPt: number): number => {
    if (maxLenPt <= 0) return 0.6;
    const score = lengthPt / maxLenPt; // 0..1
    return Math.min(0.95, Math.max(0.55, 0.55 + 0.4 * score));
  };

  const toPersist: Array<{
    points: { x: number; y: number }[];
    lengthPt: number;
    sourceLayer: string | null;
    confidence: number;
  }> = layerPolylines
    ? layerPolylines.map((pl) => ({
        points: pl.points,
        lengthPt: pl.lengthPt,
        sourceLayer: pl.sourceLayer,
        confidence: LAYER_TRACE_CONFIDENCE,
      }))
    : regionScoped.map((pl) => ({
        points: pl.points,
        lengthPt: pl.lengthPt,
        sourceLayer: null,
        confidence: confidenceFor(pl.lengthPt),
      }));

  const created = [];
  let cleanedOut = 0;
  for (const pl of toPersist) {
    // One-click AI Takeoff on the geometry path: skip low-confidence
    // (short / stray) runs so the review starts clean. Layer-derived runs
    // are already clean — nothing to drop.
    if (autoClean && !layerPolylines && pl.confidence < 0.6) {
      cleanedOut += 1;
      continue;
    }
    // Normalize to 0..1. The mupdf walk device emits TOP-LEFT-origin
    // y-DOWN coordinates (verified by overlaying raw scan segments on the
    // rendered raster — they align pixel-perfectly), and the editor's
    // normToPx applies no flip, so the normalized y passes through
    // unflipped. The previous `1 - y` here drew every AI trace
    // vertically mirrored onto empty sheet space.
    const pathPoints: PathPoint[] = pl.points.map((p) => ({
      x: p.x / pageWidthPt,
      y: p.y / pageHeightPt,
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
        confidence: pl.confidence,
        status: "proposed",
        source: "ai",
        derivation: "traced",
        sourceLayer: pl.sourceLayer,
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
      action: `Auto-traced ${created.length} wall path${created.length === 1 ? "" : "s"} on page ${page.pageNumber}${layerPolylines ? " from CAD layers" : ""}.`,
      source: "ai",
    },
  });

  return NextResponse.json({
    surfaces: created,
    count: created.length,
    cleanedOut,
    regionUsed,
    hasScale: ptPerFoot != null,
    // "layers" = deterministic CAD-layer takeoff; "geometry" = full-sheet
    // vector trace + AI region scoping (flattened PDFs).
    method: layerPolylines ? "layers" : "geometry",
    wallLayersUsed,
    layers: layerSummary,
  });
}
