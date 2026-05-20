/**
 * Automatic wall-path proposal — a path cover of the wall-graph.
 *
 * A floor plan's walls are a connected network, not a single line, so
 * "the wall run" is really a SET of polylines that together cover every
 * wall edge exactly once. We walk the half-edge graph greedily,
 * preferring the straightest continuation at each junction so each
 * emitted polyline reads as a natural continuous wall run rather than a
 * zig-zag. The contractor reviews the proposal; their total linear
 * footage is the sum across polylines, so the path-cover decomposition
 * doesn't change the measured total.
 *
 * Consumes the WallGraph from wall-graph.ts (already snapped, merged,
 * T-split, with angle-sorted vertices). Produces polylines in the same
 * PDF-pt space the graph uses; the caller normalizes + measures.
 */

import type { WallGraph } from "./wall-graph";

export interface TracedPolyline {
  /** Vertices in order, PDF pt (y-up, same space as the graph). */
  points: { x: number; y: number }[];
  /** Sum of segment lengths in PDF pt. */
  lengthPt: number;
}

export interface AutoTraceOpts {
  /** Drop polylines shorter than this (PDF pt). Defaults to ~1 ft at a
   *  typical 1/8"–1/4" scale; the caller can pass a scale-derived value
   *  for precision. */
  minPolylineLengthPt?: number;
}

const DEFAULT_MIN_POLYLINE_PT = 12;

interface Adj {
  edgeId: number;
  to: number;
}

function unitDir(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const n = Math.hypot(dx, dy);
  return n === 0 ? { x: 0, y: 0 } : { x: dx / n, y: dy / n };
}

export function autoTraceWalls(
  graph: WallGraph,
  opts: AutoTraceOpts = {},
): TracedPolyline[] {
  const minLen = opts.minPolylineLengthPt ?? DEFAULT_MIN_POLYLINE_PT;
  const { vertices, edges } = graph;
  if (edges.length === 0) return [];

  // Adjacency: vertex → incident edges.
  const adj: Adj[][] = vertices.map(() => []);
  for (let e = 0; e < edges.length; e++) {
    adj[edges[e].p1].push({ edgeId: e, to: edges[e].p2 });
    adj[edges[e].p2].push({ edgeId: e, to: edges[e].p1 });
  }
  const usedEdge = new Uint8Array(edges.length);

  // Count remaining (unused) degree per vertex; refreshed lazily.
  const remainingDegree = (v: number): number => {
    let n = 0;
    for (const a of adj[v]) if (!usedEdge[a.edgeId]) n++;
    return n;
  };

  // Pick the next edge from `current`, given the direction we arrived
  // by. Prefer the straightest continuation (largest dot product of
  // unit directions) so a run follows the wall through a junction
  // instead of turning. With no incoming direction (start of a run),
  // take the longest available edge — it's most likely a primary wall.
  const pickNext = (
    current: number,
    incoming: { x: number; y: number } | null,
  ): Adj | null => {
    let best: Adj | null = null;
    let bestScore = -Infinity;
    for (const a of adj[current]) {
      if (usedEdge[a.edgeId]) continue;
      const dir = unitDir(vertices[current], vertices[a.to]);
      let score: number;
      if (incoming === null) {
        score = edges[a.edgeId].lengthPt;
      } else {
        // Straightest continuation: dot product near 1 ⇒ same heading.
        score = incoming.x * dir.x + incoming.y * dir.y;
      }
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
    return best;
  };

  const polylines: TracedPolyline[] = [];

  // Walk a single run starting from `start`, consuming unused edges.
  const walkFrom = (start: number): void => {
    let current = start;
    let incoming: { x: number; y: number } | null = null;
    const pts: { x: number; y: number }[] = [
      { x: vertices[start].x, y: vertices[start].y },
    ];
    let lengthPt = 0;
    for (;;) {
      const next = pickNext(current, incoming);
      if (!next) break;
      usedEdge[next.edgeId] = 1;
      lengthPt += edges[next.edgeId].lengthPt;
      incoming = unitDir(vertices[current], vertices[next.to]);
      pts.push({ x: vertices[next.to].x, y: vertices[next.to].y });
      current = next.to;
    }
    if (pts.length >= 2 && lengthPt >= minLen) {
      polylines.push({ points: pts, lengthPt });
    }
  };

  // First pass: start runs at odd-degree vertices (open ends / spurs),
  // which guarantees those dangling edges get consumed as part of a
  // longer run rather than orphaned.
  for (let v = 0; v < vertices.length; v++) {
    while (remainingDegree(v) % 2 === 1 && remainingDegree(v) > 0) {
      walkFrom(v);
    }
  }
  // Second pass: any remaining edges form cycles (even-degree
  // components). Start a run at any vertex that still has unused edges.
  for (let v = 0; v < vertices.length; v++) {
    while (remainingDegree(v) > 0) {
      walkFrom(v);
    }
  }

  return polylines;
}

// ---------------------------------------------------------------------------
// Lightweight stray-trace filter
// ---------------------------------------------------------------------------

export interface StrayFilterOpts {
  /** Plan region = main component bbox grown by this fraction of its
   *  larger dimension. */
  marginFrac?: number;
  /** Keep polylines whose component's total length is at least this
   *  fraction of the largest component's. Drops sheet borders, isolated
   *  matchlines, and small detail-block fragments. */
  minComponentFrac?: number;
  /** A polyline is "in region" if at least this fraction of its
   *  vertices fall inside the plan region. */
  minRegionFrac?: number;
}

export interface StrayFilterResult {
  kept: TracedPolyline[];
  dropped: TracedPolyline[];
  planRegion: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * Remove obvious non-wall garbage from an auto-trace before review:
 * schedule tables, detail blocks, title blocks, sheet borders, and
 * matchlines. NOT the full scope filter (paint vs. tile, adjacent
 * tenant) — just enough that the proposed trace reads as the wall plan.
 *
 * Two criteria, both must pass to keep a polyline:
 *   1. Connectivity — its connected component carries a substantial
 *      share of the total wall length (sheet borders / stray lines sit
 *      in tiny components).
 *   2. Region — its vertices lie mostly inside the plan-drawing region,
 *      taken as the largest connected component's bbox + margin (the
 *      densest wall cluster on the sheet).
 */
export function filterStrayPolylines(
  graph: WallGraph,
  polylines: TracedPolyline[],
  opts: StrayFilterOpts = {},
): StrayFilterResult {
  const marginFrac = opts.marginFrac ?? 0.06;
  const minComponentFrac = opts.minComponentFrac ?? 0.1;
  const minRegionFrac = opts.minRegionFrac ?? 0.6;
  const { vertices, edges } = graph;

  if (edges.length === 0) {
    return {
      kept: polylines,
      dropped: [],
      planRegion: { x0: 0, y0: 0, x1: 0, y1: 0 },
    };
  }

  // Connected components via union-find.
  const parent = vertices.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    let j = i;
    while (parent[j] !== r) {
      const n = parent[j];
      parent[j] = r;
      j = n;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (const e of edges) union(e.p1, e.p2);

  // Total wall length per component.
  const compLen = new Map<number, number>();
  for (const e of edges) {
    const r = find(e.p1);
    compLen.set(r, (compLen.get(r) ?? 0) + e.lengthPt);
  }
  let largest = 0;
  let largestComp = -1;
  for (const [c, l] of compLen) {
    if (l > largest) {
      largest = l;
      largestComp = c;
    }
  }

  // Largest component bbox → plan region + margin.
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i < vertices.length; i++) {
    if (find(i) !== largestComp) continue;
    const v = vertices[i];
    if (v.x < x0) x0 = v.x;
    if (v.y < y0) y0 = v.y;
    if (v.x > x1) x1 = v.x;
    if (v.y > y1) y1 = v.y;
  }
  const margin = marginFrac * Math.max(x1 - x0, y1 - y0);
  const planRegion = {
    x0: x0 - margin,
    y0: y0 - margin,
    x1: x1 + margin,
    y1: y1 + margin,
  };

  // Map vertex coords → component (polyline points are exact vertex
  // coordinates from the walk).
  const snap = 1.5;
  const keyOf = (x: number, y: number): string =>
    `${Math.round(x / snap)}|${Math.round(y / snap)}`;
  const compByKey = new Map<string, number>();
  for (let i = 0; i < vertices.length; i++) {
    compByKey.set(keyOf(vertices[i].x, vertices[i].y), find(i));
  }

  const kept: TracedPolyline[] = [];
  const dropped: TracedPolyline[] = [];
  for (const pl of polylines) {
    const comp = compByKey.get(keyOf(pl.points[0].x, pl.points[0].y)) ?? -1;
    const connected = (compLen.get(comp) ?? 0) >= minComponentFrac * largest;
    let inside = 0;
    for (const p of pl.points) {
      if (
        p.x >= planRegion.x0 &&
        p.x <= planRegion.x1 &&
        p.y >= planRegion.y0 &&
        p.y <= planRegion.y1
      ) {
        inside++;
      }
    }
    const inRegion = inside / pl.points.length >= minRegionFrac;
    if (connected && inRegion) kept.push(pl);
    else dropped.push(pl);
  }
  return { kept, dropped, planRegion };
}
