/**
 * Layer-driven wall takeoff: turn a layer-tagged vector scan into traced
 * wall polylines, scoped to the construction-plan view.
 *
 * A sheet often carries several plan views (construction plan + demolition
 * plan side by side) plus wall-type detail keys — all drawn on the same
 * wall layers. Views are separated by clustering wall segments spatially
 * and picking the cluster with the most NEW-wall length (new walls only
 * appear on the construction view; detail keys are small clusters far from
 * the plan body).
 */

import { buildWallGraph } from "./wall-graph";
import { autoTraceWalls, type TracedPolyline } from "./wall-autotrace";
import type { LayerScanResult, LayerSegment } from "./layer-scan";
import { classifyLayerName, type LayerRole } from "./layer-classify";

/**
 * Max gap (pt) between wall-segment bounding boxes that still counts as
 * the same plan view. Measured on the Beaver Tails fit-out: intra-view
 * component gaps run ≤ ~100 pt, view-to-view and view-to-detail-key gaps
 * run ≥ ~325 pt.
 */
export const VIEW_CLUSTER_GAP_PT = 150;

/**
 * CAD walls are drawn as two parallel faces. Tracing both doubles the
 * linear footage, so before graph-building we keep only one face per
 * wall: the longest segments win, and any parallel segment mostly
 * shadowed within wall-thickness distance of a kept one is dropped.
 * Thickness ceiling: 1.1 ft (covers 4"–12" partitions/shells) when the
 * scale is known, else a 14 pt fallback (~9" at 1/4" scale).
 */
export const WALL_FACE_MAX_THICKNESS_FT = 1.1;
export const WALL_FACE_MAX_THICKNESS_PT_FALLBACK = 14;
/** A segment is a duplicate face when ≥ this fraction of it shadows a kept segment. */
export const WALL_FACE_OVERLAP_FRAC = 0.6;

/** Deterministic provenance → high confidence, but still "proposed". */
export const LAYER_TRACE_CONFIDENCE = 0.9;

/**
 * Default height for walls traced from half-wall layers (HWALL — knee
 * walls, counters, partial partitions; typically 42–48"). Full-height
 * walls default to the project ceiling height. Both are review-stage
 * defaults the contractor can edit per wall.
 */
export const HALF_WALL_DEFAULT_HEIGHT_FT = 4;

/** Half-height wall layers: "FP-N-HWALL", "FP-E-HWALL", … */
export function isHalfWallLayer(layerName: string): boolean {
  return /HWALL/i.test(layerName);
}

export interface LayerPolyline extends TracedPolyline {
  sourceLayer: string;
}

export interface LayerTakeoffResult {
  /** False when the page has no usable wall layers — caller falls back. */
  ok: boolean;
  polylines: LayerPolyline[];
  wallLayersUsed: string[];
  /** Chosen plan-view bounds (pt), for diagnostics/UI. */
  viewBounds: { x0: number; y0: number; x1: number; y1: number } | null;
}

interface Cluster {
  segs: LayerSegment[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function segLen(s: LayerSegment): number {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
}

function clustersTouch(a: Cluster, b: Cluster, gap: number): boolean {
  return (
    a.x0 - gap <= b.x1 &&
    b.x0 - gap <= a.x1 &&
    a.y0 - gap <= b.y1 &&
    b.y0 - gap <= a.y1
  );
}

function mergeInto(a: Cluster, b: Cluster): void {
  a.segs.push(...b.segs);
  a.x0 = Math.min(a.x0, b.x0);
  a.y0 = Math.min(a.y0, b.y0);
  a.x1 = Math.max(a.x1, b.x1);
  a.y1 = Math.max(a.y1, b.y1);
}

/**
 * Drop duplicate wall faces: sort by length (longest first); a segment is
 * dropped when it runs parallel within wall-thickness distance of an
 * already-kept segment and most of it shadows that segment. Perpendicular
 * geometry (corners, jamb returns) is never affected.
 */
export function dedupeParallelFaces<T extends LayerSegment>(
  segs: T[],
  maxGapPt: number,
): T[] {
  const sorted = [...segs].sort((a, b) => segLen(b) - segLen(a));
  const kept: T[] = [];
  for (const s of sorted) {
    const len = segLen(s);
    if (len === 0) continue;
    const ux = (s.x2 - s.x1) / len;
    const uy = (s.y2 - s.y1) / len;
    let shadowed = false;
    for (const k of kept) {
      const kLen = segLen(k);
      const kux = (k.x2 - k.x1) / kLen;
      const kuy = (k.y2 - k.y1) / kLen;
      // Parallel test (unit cross product, ignoring direction).
      if (Math.abs(ux * kuy - uy * kux) > 0.03) continue;
      // Perpendicular offset from k's line to s's start.
      const perp = Math.abs((s.x1 - k.x1) * -kuy + (s.y1 - k.y1) * kux);
      if (perp < 0.5 || perp > maxGapPt) continue;
      // Overlap of s projected onto k's axis.
      const p1 = (s.x1 - k.x1) * kux + (s.y1 - k.y1) * kuy;
      const p2 = (s.x2 - k.x1) * kux + (s.y2 - k.y1) * kuy;
      const lo = Math.max(Math.min(p1, p2), 0);
      const hi = Math.min(Math.max(p1, p2), kLen);
      if (hi - lo >= WALL_FACE_OVERLAP_FRAC * len) {
        shadowed = true;
        break;
      }
    }
    if (!shadowed) kept.push(s);
  }
  return kept;
}

/** Agglomerative bbox clustering — fine at wall-segment counts (~500). */
function clusterSegments(segs: LayerSegment[], gap: number): Cluster[] {
  let clusters: Cluster[] = segs.map((s) => ({
    segs: [s],
    x0: Math.min(s.x1, s.x2),
    y0: Math.min(s.y1, s.y2),
    x1: Math.max(s.x1, s.x2),
    y1: Math.max(s.y1, s.y2),
  }));
  let merged = true;
  while (merged) {
    merged = false;
    const next: Cluster[] = [];
    for (const c of clusters) {
      const host = next.find((n) => clustersTouch(n, c, gap));
      if (host) {
        mergeInto(host, c);
        merged = true;
      } else {
        next.push(c);
      }
    }
    clusters = next;
  }
  return clusters;
}

/**
 * Trace wall polylines from a layer-tagged scan.
 *
 * `roleFor` maps each layer name to its role (regex result, optionally
 * patched by the Haiku fallback). `wallLayers` overrides which layers
 * count as walls (UI selection); when omitted, all wall-new/wall-existing
 * layers with segments on the page are used (demo excluded).
 */
export function traceWallsFromLayers(
  scan: LayerScanResult,
  roleFor: Record<string, LayerRole>,
  opts: { wallLayers?: string[]; ptPerFoot: number | null },
): LayerTakeoffResult {
  const role = (name: string): LayerRole =>
    roleFor[name] ?? classifyLayerName(name);

  const wallLayerSet = new Set(
    opts.wallLayers ??
      Object.keys(scan.segmentsPerLayer).filter((name) => {
        const r = role(name);
        return r === "wall-new" || r === "wall-existing";
      }),
  );
  if (wallLayerSet.size === 0) {
    return { ok: false, polylines: [], wallLayersUsed: [], viewBounds: null };
  }

  const wallSegs = scan.segments.filter(
    (s) => s.layer != null && wallLayerSet.has(s.layer),
  );
  if (wallSegs.length === 0) {
    return { ok: false, polylines: [], wallLayersUsed: [], viewBounds: null };
  }

  // Pick the construction-plan view: most new-wall length, then most total.
  const clusters = clusterSegments(wallSegs, VIEW_CLUSTER_GAP_PT);
  let best: Cluster | null = null;
  let bestNew = -1;
  let bestTotal = -1;
  for (const c of clusters) {
    let newLf = 0;
    let total = 0;
    for (const s of c.segs) {
      const len = segLen(s);
      total += len;
      if (role(s.layer!) === "wall-new") newLf += len;
    }
    if (newLf > bestNew || (newLf === bestNew && total > bestTotal)) {
      best = c;
      bestNew = newLf;
      bestTotal = total;
    }
  }
  if (!best) {
    return { ok: false, polylines: [], wallLayersUsed: [], viewBounds: null };
  }

  // Trace per layer so each run keeps clean provenance (and half-height
  // walls stay separate from full-height ones for later height edits).
  const byLayer = new Map<string, LayerSegment[]>();
  for (const s of best.segs) {
    const list = byLayer.get(s.layer!) ?? [];
    list.push(s);
    byLayer.set(s.layer!, list);
  }
  const faceGapPt = opts.ptPerFoot
    ? opts.ptPerFoot * WALL_FACE_MAX_THICKNESS_FT
    : WALL_FACE_MAX_THICKNESS_PT_FALLBACK;
  const polylines: LayerPolyline[] = [];
  for (const [layer, segs] of byLayer) {
    const singleFace = dedupeParallelFaces(segs, faceGapPt);
    const graph = buildWallGraph(singleFace);
    const traced = autoTraceWalls(graph, {
      // Drop sub-foot stubs when a scale is known; else fall back to pt.
      minPolylineLengthPt: opts.ptPerFoot ? opts.ptPerFoot : 12,
    });
    // Input is layer-clean — no stray filter (it was tuned for noisy
    // full-sheet scans and deletes real walls on clean input).
    for (const pl of traced) polylines.push({ ...pl, sourceLayer: layer });
  }

  return {
    ok: polylines.length > 0,
    polylines,
    wallLayersUsed: [...wallLayerSet].filter((l) => byLayer.has(l)),
    viewBounds: { x0: best.x0, y0: best.y0, x1: best.x1, y1: best.y1 },
  };
}
