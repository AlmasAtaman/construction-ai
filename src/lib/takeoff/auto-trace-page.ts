/**
 * Per-page auto-takeoff core, shared by:
 *   POST /api/plan-pages/[id]/auto-trace  (single page, toolbar button)
 *   POST /api/plans/[id]/takeoff          (whole plan, one click)
 *
 * Preferred path: CAD layers (PDF optional content) → deterministic wall
 * trace. Fallback: full-sheet geometry + AI region scoping for flattened
 * PDFs. Persists each traced run as a proposed `wall-path` Surface.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pdf } from "pdf-to-img";
import sharp from "sharp";
import { db } from "@/lib/db";
import { scanVectorPaths, detectPageScale } from "@/lib/extract/page-extract";
import { buildWallGraph, type RawSegment } from "@/lib/extract/wall-graph";
import {
  autoTraceWalls,
  filterStrayPolylines,
  type TracedPolyline,
} from "@/lib/extract/wall-autotrace";
import { detectWallRegions, type WallRegion } from "@/lib/ai/wall-region";
import { hasApiKey } from "@/lib/anthropic";
import { scanSegmentsByLayer } from "@/lib/extract/layer-scan";
import { classifyLayers, type LayerRole } from "@/lib/extract/layer-classify";
import {
  traceWallsFromLayers,
  LAYER_TRACE_CONFIDENCE,
  HALF_WALL_DEFAULT_HEIGHT_FT,
  isHalfWallLayer,
  type LayerPolyline,
} from "@/lib/extract/layer-takeoff";
import { classifyLayerNamesWithAi } from "@/lib/ai/layer-names";
import type { PathPoint } from "@/types/surface";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

// Margin (fraction of page) added around an AI region box so walls right on
// the footprint edge aren't clipped.
const REGION_MARGIN = 0.02;

/**
 * Auto-persist thresholds for detected scales — mirrors the scale route
 * (src/app/api/plan-pages/[id]/scale/route.ts). A printed scale notation
 * is the architect's own declaration → lower bar; geometry-only
 * detection needs the higher bar.
 */
const SCALE_MIN_CONFIDENCE_TEXT = 0.45;
const SCALE_MIN_CONFIDENCE_OTHER = 0.6;

export interface AutoTraceOptions {
  /** Wipe ALL wall-paths (manual included) before re-tracing. */
  reset?: boolean;
  /** Drop low-confidence geometry-path runs; no-op on the layer path. */
  autoClean?: boolean;
  /** Explicit CAD-layer selection; null/undefined = classified default. */
  wallLayers?: string[] | null;
}

export interface LayerSummaryEntry {
  name: string;
  role: LayerRole;
  segments: number;
}

export interface AutoTraceResult {
  surfaces: unknown[];
  count: number;
  cleanedOut: number;
  /** Re-traced walls identical to already-kept surfaces (not re-proposed). */
  skippedExisting: number;
  regionUsed: boolean;
  hasScale: boolean;
  method: "layers" | "geometry";
  wallLayersUsed: string[];
  layers: LayerSummaryEntry[];
}

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
          .resize({
            width: 1400,
            height: 1400,
            fit: "inside",
            withoutEnlargement: true,
          })
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
 * Make sure the page has a scale before measuring: returns the stored
 * scale, or runs detection and persists a confident hit (same thresholds
 * as the scale banner). Returns null when the page genuinely needs manual
 * calibration.
 */
export async function ensurePageScale(page: {
  id: string;
  pageNumber: number;
  scaleRatio: number | null;
  plan: { filePath: string };
}): Promise<number | null> {
  if (page.scaleRatio != null && page.scaleRatio > 0) return page.scaleRatio;
  try {
    const buf = await readFile(path.join(UPLOADS_DIR, page.plan.filePath));
    const detected = await detectPageScale(buf, page.pageNumber);
    const minConf =
      detected?.method === "text-notation"
        ? SCALE_MIN_CONFIDENCE_TEXT
        : SCALE_MIN_CONFIDENCE_OTHER;
    if (detected && detected.confidence >= minConf) {
      await db.planPage.update({
        where: { id: page.id },
        data: {
          scaleRatio: detected.ptPerFoot,
          scaleMethod: detected.method,
          scaleLabel: detected.label,
        },
      });
      return detected.ptPerFoot;
    }
  } catch {
    /* detection failed */
  }
  return null;
}

/**
 * Run the auto-takeoff for one page and persist the proposed wall-paths.
 * Throws if the page doesn't exist.
 */
export async function runAutoTraceForPage(
  planPageId: string,
  opts: AutoTraceOptions = {},
): Promise<AutoTraceResult> {
  const { reset = false, autoClean = false } = opts;
  const wallLayers = opts.wallLayers ?? null;

  const page = await db.planPage.findUnique({
    where: { id: planPageId },
    include: { plan: { include: { project: true } } },
  });
  if (!page) throw new Error("Page not found");
  const project = page.plan.project;
  const ptPerFoot = page.scaleRatio;
  const ceilingHeightFt = project.ceilingHeightFt;

  const buf = await readFile(path.join(UPLOADS_DIR, page.plan.filePath));

  // ---- Preferred path: CAD layers (PDF optional content). When the PDF
  // preserves the architect's layer structure, walls vs dimensions vs
  // hatching is a metadata lookup — deterministic, exact, and free. Any
  // failure here falls through to the geometry+AI path unchanged.
  let layerPolylines: LayerPolyline[] | null = null;
  let layerSummary: LayerSummaryEntry[] = [];
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
      where: { id: planPageId },
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
      ? { planPageId, type: "wall-path" }
      : {
          planPageId,
          type: "wall-path",
          source: "ai",
          status: "proposed",
        },
  });

  // Surviving wall-paths (accepted / manual) — a re-run must not duplicate
  // them. The layer path is deterministic, so an unchanged wall re-traces
  // to byte-identical pathPoints; matching geometry is skipped instead of
  // re-proposed. (Without this, accept-then-rerun double-counts the page.)
  const surviving = await db.surface.findMany({
    where: { planPageId, type: "wall-path" },
    select: { pathPoints: true },
  });
  const survivingGeometry = new Set(
    surviving.map((s) => s.pathPoints).filter((p): p is string => p != null),
  );

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
  let skippedExisting = 0;
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
    // unflipped.
    const pathPoints: PathPoint[] = pl.points.map((p) => ({
      x: p.x / pageWidthPt,
      y: p.y / pageHeightPt,
      // Auto-trace vertices are real wall-graph vertices → endpoint snap.
      snap: "endpoint",
    }));
    const pathPointsJson = JSON.stringify(pathPoints);
    if (survivingGeometry.has(pathPointsJson)) {
      // Already kept (accepted earlier or traced manually) — don't
      // re-propose the identical wall.
      skippedExisting += 1;
      continue;
    }
    // Half-wall layers (HWALL) get a knee-wall default height; everything
    // else defaults to the project ceiling height. Both editable per wall.
    const isHalfWall =
      pl.sourceLayer != null && isHalfWallLayer(pl.sourceLayer);
    const wallHeightFt = isHalfWall
      ? HALF_WALL_DEFAULT_HEIGHT_FT
      : ceilingHeightFt;
    const linearFootage = ptPerFoot ? pl.lengthPt / ptPerFoot : null;
    const squareFootage =
      linearFootage != null ? linearFootage * wallHeightFt : null;
    const polygon = pathPoints.map((p) => ({ x: p.x, y: p.y }));
    const surface = await db.surface.create({
      data: {
        projectId: project.id,
        planPageId,
        type: "wall-path",
        polygon: JSON.stringify(polygon),
        pathPoints: pathPointsJson,
        linearFootage,
        squareFootage,
        // Default every traced wall to Paint; the user reclassifies
        // finish/height in review and the area updates.
        finishType: "paint",
        // "custom" = the height came from somewhere other than the
        // ceiling/deck presets — here, the HWALL knee-wall default.
        heightBasis: isHalfWall ? "custom" : "ceiling",
        wallHeightFt,
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

  return {
    surfaces: created,
    count: created.length,
    cleanedOut,
    skippedExisting,
    regionUsed,
    hasScale: ptPerFoot != null,
    method: layerPolylines ? "layers" : "geometry",
    wallLayersUsed,
    layers: layerSummary,
  };
}
