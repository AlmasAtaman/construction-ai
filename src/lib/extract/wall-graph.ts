/**
 * Wall-tracer's own graph pipeline. Parallel to (and intentionally
 * disjoint from) `planar-graph.ts`, which is hard-coded to axis-aligned
 * geometry and must stay that way to keep room detection working.
 *
 * Inputs: raw `{x1,y1,x2,y2}` segments in PDF points — typically the
 * union of `scan.walls` (H/V) and `scan.diagonalWalls` (long non-axis)
 * from `page-extract.ts`.
 *
 * Output: a half-edge graph whose vertices are snapped wall corners,
 * whose edges are merged collinear runs, and whose outgoing edges at
 * each vertex are sorted CCW by angle. Designed for two consumers:
 *
 *   1. The auto-trace path-cover walker (Day 5) — enumerates connected
 *      polylines that cover every edge.
 *
 *   2. The manual-trace snap engine (Day 4) — exposes the cleaned
 *      segment list so the editor can project the cursor onto real
 *      wall geometry.
 *
 * Coordinate space is PDF points throughout (y-up, as MuPDF emits).
 * The walls API layer is responsible for any normalization to 0..1
 * before sending to the client.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RawSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface WallVertex {
  x: number;
  y: number;
  /** Outgoing half-edge indices, sorted CCW by direction angle. */
  outgoing: number[];
}

export interface WallHalfEdge {
  origin: number;
  target: number;
  twin: number;
  /** CCW next half-edge for face traversal. -1 if not linked. */
  next: number;
  /** Undirected edge index. */
  edgeId: number;
}

export interface WallEdge {
  /** Indexes into vertices[]. */
  p1: number;
  p2: number;
  /** Cached length in PDF pt for quick lookups (= |p2-p1|). */
  lengthPt: number;
  /** Forward (p1→p2) half-edge index. */
  he12: number;
  /** Reverse (p2→p1) half-edge index. */
  he21: number;
}

export interface WallGraph {
  vertices: WallVertex[];
  halfEdges: WallHalfEdge[];
  edges: WallEdge[];
}

export interface BuildWallGraphOpts {
  /** Endpoints within this distance (pt) cluster into one vertex. */
  snapPt?: number;
  /** Max angular difference (radians) for two segments to be collinear. */
  collinearAngleTol?: number;
  /** Max perpendicular offset (pt) for two parallel segments to be collinear. */
  collinearOffsetPt?: number;
  /** Bridge collinear segments separated by gaps up to this distance (pt). */
  doorGapPt?: number;
  /** Drop connected components whose total edge length is less than
   *  this fraction of the largest component. Hatch / detail noise is
   *  typically isolated, so it falls into tiny components. */
  componentMinSizeRatio?: number;
  /** Drop degree-1 segments shorter than this (pt). Cleans up stubs
   *  left by T-splits and short isolated strays. */
  stubLessThanPt?: number;
}

const DEFAULT_OPTS: Required<BuildWallGraphOpts> = {
  snapPt: 1.5,
  collinearAngleTol: 0.02, // ~1.15°
  collinearOffsetPt: 1.5,
  doorGapPt: 45,
  componentMinSizeRatio: 0.04,
  stubLessThanPt: 8,
};

// ---------------------------------------------------------------------------
// Small geometric helpers
// ---------------------------------------------------------------------------

interface Vec {
  x: number;
  y: number;
}

function sub(a: Vec, b: Vec): Vec {
  return { x: a.x - b.x, y: a.y - b.y };
}

function dot(a: Vec, b: Vec): number {
  return a.x * b.x + a.y * b.y;
}

function cross2(a: Vec, b: Vec): number {
  return a.x * b.y - a.y * b.x;
}

function norm(a: Vec): number {
  return Math.hypot(a.x, a.y);
}

function unit(a: Vec): Vec {
  const n = norm(a);
  return n === 0 ? { x: 0, y: 0 } : { x: a.x / n, y: a.y / n };
}

/**
 * Unoriented angle of a direction vector, in [0, π). Two segments
 * pointing opposite ways share the same line orientation, so we fold
 * by π.
 */
function lineAngle(dir: Vec): number {
  let a = Math.atan2(dir.y, dir.x);
  if (a < 0) a += Math.PI;
  if (a >= Math.PI) a -= Math.PI;
  return a;
}

function angleDelta(a: number, b: number): number {
  let d = Math.abs(a - b);
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

// ---------------------------------------------------------------------------
// Pipeline step 1: snap endpoints (cluster-merge)
// ---------------------------------------------------------------------------

/**
 * Cluster endpoints within `snap` pt of each other and replace them
 * all with the cluster centroid. Identical strategy to
 * planar-graph.ts:snapSegments but operates on arbitrary-orientation
 * segments — the geometry is direction-agnostic.
 */
function snapEndpoints(segs: RawSegment[], snap: number): RawSegment[] {
  if (segs.length === 0) return [];
  interface Pt {
    x: number;
    y: number;
    cluster: number;
  }
  const microGrid = snap / 10;
  const ptKey = (x: number, y: number): string =>
    `${Math.round(x / microGrid)}|${Math.round(y / microGrid)}`;
  const ptMap = new Map<string, Pt>();
  const ptList: Pt[] = [];
  const addPt = (x: number, y: number): void => {
    const k = ptKey(x, y);
    if (ptMap.has(k)) return;
    const e: Pt = { x, y, cluster: ptList.length };
    ptMap.set(k, e);
    ptList.push(e);
  };
  for (const s of segs) {
    addPt(s.x1, s.y1);
    addPt(s.x2, s.y2);
  }

  const parent = ptList.map((_, i) => i);
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

  const bucketKey = (x: number, y: number): string =>
    `${Math.floor(x / snap)}|${Math.floor(y / snap)}`;
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < ptList.length; i++) {
    const p = ptList[i];
    const k = bucketKey(p.x, p.y);
    const arr = buckets.get(k);
    if (arr) arr.push(i);
    else buckets.set(k, [i]);
  }
  const snapSq = snap * snap;
  for (let i = 0; i < ptList.length; i++) {
    const p = ptList[i];
    const bx = Math.floor(p.x / snap);
    const by = Math.floor(p.y / snap);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = buckets.get(`${bx + dx}|${by + dy}`);
        if (!arr) continue;
        for (const j of arr) {
          if (j <= i) continue;
          const q = ptList[j];
          const ddx = p.x - q.x;
          const ddy = p.y - q.y;
          if (ddx * ddx + ddy * ddy <= snapSq) union(i, j);
        }
      }
    }
  }

  const sums = new Map<number, { sx: number; sy: number; n: number }>();
  for (let i = 0; i < ptList.length; i++) {
    const r = find(i);
    const cur = sums.get(r) ?? { sx: 0, sy: 0, n: 0 };
    cur.sx += ptList[i].x;
    cur.sy += ptList[i].y;
    cur.n += 1;
    sums.set(r, cur);
  }
  const centroid = new Map<number, Vec>();
  for (const [r, { sx, sy, n }] of sums) {
    centroid.set(r, { x: sx / n, y: sy / n });
  }
  const lookup = (x: number, y: number): Vec => {
    const k = ptKey(x, y);
    const e = ptMap.get(k);
    if (!e) return { x, y };
    return centroid.get(find(e.cluster)) ?? { x, y };
  };
  const out: RawSegment[] = [];
  for (const s of segs) {
    const a = lookup(s.x1, s.y1);
    const b = lookup(s.x2, s.y2);
    if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) continue;
    out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pipeline step 2 + 3: dedup and merge collinear overlapping segments
// ---------------------------------------------------------------------------

/**
 * Group segments by "shared infinite line" (collinear within tolerance)
 * and merge any whose 1-D projection ranges overlap or touch. Returns
 * one segment per merged interval. Exact duplicates collapse trivially
 * since their intervals are identical.
 */
function mergeCollinear(
  segs: RawSegment[],
  angleTol: number,
  offsetTol: number,
): RawSegment[] {
  if (segs.length === 0) return [];

  // Bucket by quantized line-angle. Two collinear segments share both
  // the same orientation AND lie on the same line; bucketing by angle
  // narrows the candidates so the inner loop stays cheap.
  const angleBucketSize = Math.max(angleTol, 0.005);
  const angleBuckets = new Map<number, number[]>();
  const angles: number[] = [];
  const dirs: Vec[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const d: Vec = { x: s.x2 - s.x1, y: s.y2 - s.y1 };
    const a = lineAngle(d);
    angles.push(a);
    dirs.push(d);
    const bk = Math.round(a / angleBucketSize);
    const arr = angleBuckets.get(bk);
    if (arr) arr.push(i);
    else angleBuckets.set(bk, [i]);
  }

  const used = new Uint8Array(segs.length);
  const out: RawSegment[] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    const seedAngle = angles[i];
    const bk = Math.round(seedAngle / angleBucketSize);
    const candidates: number[] = [];
    for (let db = -1; db <= 1; db++) {
      const arr = angleBuckets.get(bk + db);
      if (arr) candidates.push(...arr);
    }

    // Build a maximal collinear group starting from seed i. We use a
    // pivot point (the seed's midpoint) and a unit direction; another
    // segment joins the group if (a) its angle matches and (b) its
    // perpendicular distance from the seed's line is below tolerance.
    const seed = segs[i];
    const pivot: Vec = {
      x: (seed.x1 + seed.x2) / 2,
      y: (seed.y1 + seed.y2) / 2,
    };
    const u = unit(dirs[i]);
    // Normal to u
    const nrm: Vec = { x: -u.y, y: u.x };
    const group: number[] = [];
    for (const j of candidates) {
      if (used[j]) continue;
      if (angleDelta(angles[j], seedAngle) > angleTol) continue;
      // Perpendicular distance from segment j's midpoint to seed line.
      // Two parallel lines: if |(midJ - pivot) · n| ≤ offsetTol, they
      // are the same line within tolerance.
      const mj: Vec = {
        x: (segs[j].x1 + segs[j].x2) / 2,
        y: (segs[j].y1 + segs[j].y2) / 2,
      };
      const off = Math.abs(dot(sub(mj, pivot), nrm));
      if (off > offsetTol) continue;
      // Also check the endpoints — a segment whose midpoint is close
      // but whose endpoints stray (very off-axis nearby segment) can
      // sneak through the midpoint test alone.
      const e1: Vec = { x: segs[j].x1, y: segs[j].y1 };
      const e2: Vec = { x: segs[j].x2, y: segs[j].y2 };
      const o1 = Math.abs(dot(sub(e1, pivot), nrm));
      const o2 = Math.abs(dot(sub(e2, pivot), nrm));
      if (o1 > offsetTol || o2 > offsetTol) continue;
      group.push(j);
    }

    // Project all endpoints onto u to get 1-D intervals.
    interface Interval {
      lo: number;
      hi: number;
      loPt: Vec;
      hiPt: Vec;
    }
    const intervals: Interval[] = group.map((j) => {
      const p1: Vec = { x: segs[j].x1, y: segs[j].y1 };
      const p2: Vec = { x: segs[j].x2, y: segs[j].y2 };
      const t1 = dot(sub(p1, pivot), u);
      const t2 = dot(sub(p2, pivot), u);
      return t1 <= t2
        ? { lo: t1, hi: t2, loPt: p1, hiPt: p2 }
        : { lo: t2, hi: t1, loPt: p2, hiPt: p1 };
    });
    intervals.sort((a, b) => a.lo - b.lo);

    // Sweep-merge overlapping/touching intervals. "Touching" uses an
    // epsilon equal to offsetTol (snap tolerance) so adjacent
    // collinear segments that share a vertex collapse into one.
    const eps = offsetTol;
    let cur = intervals[0];
    const merged: Interval[] = [];
    for (let k = 1; k < intervals.length; k++) {
      const it = intervals[k];
      if (it.lo <= cur.hi + eps) {
        if (it.hi > cur.hi) {
          cur = { lo: cur.lo, hi: it.hi, loPt: cur.loPt, hiPt: it.hiPt };
        }
      } else {
        merged.push(cur);
        cur = it;
      }
    }
    merged.push(cur);
    for (const m of merged) {
      out.push({ x1: m.loPt.x, y1: m.loPt.y, x2: m.hiPt.x, y2: m.hiPt.y });
    }
    for (const j of group) used[j] = 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pipeline step 4: T-intersection split at any orientation
// ---------------------------------------------------------------------------

/**
 * For every endpoint V in the segment set, find any segment whose
 * interior passes within `snap` of V and split that segment at V.
 *
 * General — works at any orientation. Uses a spatial grid keyed on
 * endpoint position so the inner loop only inspects nearby segments.
 */
function splitAtIntersections(
  segs: RawSegment[],
  snap: number,
): RawSegment[] {
  if (segs.length === 0) return [];
  // Collect all endpoints (deduped).
  const microGrid = snap / 10;
  const ptKey = (x: number, y: number): string =>
    `${Math.round(x / microGrid)}|${Math.round(y / microGrid)}`;
  const endpointsMap = new Map<string, Vec>();
  for (const s of segs) {
    endpointsMap.set(ptKey(s.x1, s.y1), { x: s.x1, y: s.y1 });
    endpointsMap.set(ptKey(s.x2, s.y2), { x: s.x2, y: s.y2 });
  }
  const endpoints = [...endpointsMap.values()];

  // Bucket endpoints for fast lookup by spatial cell. Cell size = a
  // reasonable wall length so we look at one ring of cells per
  // segment.
  const cellSize = 50;
  const epBuckets = new Map<string, Vec[]>();
  for (const p of endpoints) {
    const k = `${Math.floor(p.x / cellSize)}|${Math.floor(p.y / cellSize)}`;
    const arr = epBuckets.get(k);
    if (arr) arr.push(p);
    else epBuckets.set(k, [p]);
  }

  const out: RawSegment[] = [];
  const eps = snap;
  for (const s of segs) {
    const p1: Vec = { x: s.x1, y: s.y1 };
    const p2: Vec = { x: s.x2, y: s.y2 };
    const d = sub(p2, p1);
    const lenSq = dot(d, d);
    if (lenSq < 1e-12) continue;
    // Bounding box of the segment, expanded by snap, then iterate the
    // buckets it covers.
    const x0 = Math.min(p1.x, p2.x) - snap;
    const y0 = Math.min(p1.y, p2.y) - snap;
    const x1 = Math.max(p1.x, p2.x) + snap;
    const y1 = Math.max(p1.y, p2.y) + snap;
    const bx0 = Math.floor(x0 / cellSize);
    const by0 = Math.floor(y0 / cellSize);
    const bx1 = Math.floor(x1 / cellSize);
    const by1 = Math.floor(y1 / cellSize);
    const cuts: number[] = []; // parametric t-values in [0,1]
    for (let bx = bx0; bx <= bx1; bx++) {
      for (let by = by0; by <= by1; by++) {
        const arr = epBuckets.get(`${bx}|${by}`);
        if (!arr) continue;
        for (const v of arr) {
          // Skip the segment's own endpoints.
          if (Math.abs(v.x - p1.x) < 1e-9 && Math.abs(v.y - p1.y) < 1e-9)
            continue;
          if (Math.abs(v.x - p2.x) < 1e-9 && Math.abs(v.y - p2.y) < 1e-9)
            continue;
          const ap = sub(v, p1);
          const t = dot(ap, d) / lenSq;
          if (t <= eps / Math.sqrt(lenSq)) continue;
          if (t >= 1 - eps / Math.sqrt(lenSq)) continue;
          // Perpendicular distance from v to the line.
          const perp = Math.abs(cross2(ap, d)) / Math.sqrt(lenSq);
          if (perp > eps) continue;
          cuts.push(t);
        }
      }
    }
    if (cuts.length === 0) {
      out.push(s);
      continue;
    }
    cuts.sort((a, b) => a - b);
    let prevT = 0;
    let prev = p1;
    for (const t of cuts) {
      if (t - prevT < 1e-6) continue;
      const cx = p1.x + d.x * t;
      const cy = p1.y + d.y * t;
      out.push({ x1: prev.x, y1: prev.y, x2: cx, y2: cy });
      prev = { x: cx, y: cy };
      prevT = t;
    }
    if (1 - prevT > 1e-6) {
      out.push({ x1: prev.x, y1: prev.y, x2: p2.x, y2: p2.y });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pipeline step 5: door-gap closure across collinear segments at any angle
// ---------------------------------------------------------------------------

/**
 * Bridge two collinear segments separated by a small gap. Mirrors the
 * door-gap closer in planar-graph.ts but generalizes to any angle.
 *
 * For each cluster of collinear segments (using the same angle-bucket
 * idea as `mergeCollinear`), sort by 1-D projection, and for any
 * neighbor pair whose gap is in (snap, maxGap), add a connecting
 * segment. No door-symbol evidence is consulted here — the wall-
 * tracer's downstream component pruning naturally drops bridges that
 * connect to nothing useful.
 */
function closeCollinearGaps(
  segs: RawSegment[],
  maxGap: number,
  angleTol: number,
  offsetTol: number,
): RawSegment[] {
  if (segs.length === 0) return [];
  const angleBucketSize = Math.max(angleTol, 0.005);
  const angleBuckets = new Map<number, number[]>();
  const angles: number[] = [];
  const dirs: Vec[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const d: Vec = { x: s.x2 - s.x1, y: s.y2 - s.y1 };
    angles.push(lineAngle(d));
    dirs.push(d);
    const bk = Math.round(angles[i] / angleBucketSize);
    const arr = angleBuckets.get(bk);
    if (arr) arr.push(i);
    else angleBuckets.set(bk, [i]);
  }
  const used = new Uint8Array(segs.length);
  const out = segs.slice();
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    const bk = Math.round(angles[i] / angleBucketSize);
    const cands: number[] = [];
    for (let db = -1; db <= 1; db++) {
      const arr = angleBuckets.get(bk + db);
      if (arr) cands.push(...arr);
    }
    const seed = segs[i];
    const pivot: Vec = {
      x: (seed.x1 + seed.x2) / 2,
      y: (seed.y1 + seed.y2) / 2,
    };
    const u = unit(dirs[i]);
    const nrm: Vec = { x: -u.y, y: u.x };
    interface Iv {
      lo: number;
      hi: number;
      loPt: Vec;
      hiPt: Vec;
    }
    const ivs: Iv[] = [];
    for (const j of cands) {
      if (used[j]) continue;
      if (angleDelta(angles[j], angles[i]) > angleTol) continue;
      const e1: Vec = { x: segs[j].x1, y: segs[j].y1 };
      const e2: Vec = { x: segs[j].x2, y: segs[j].y2 };
      const o1 = Math.abs(dot(sub(e1, pivot), nrm));
      const o2 = Math.abs(dot(sub(e2, pivot), nrm));
      if (o1 > offsetTol || o2 > offsetTol) continue;
      const t1 = dot(sub(e1, pivot), u);
      const t2 = dot(sub(e2, pivot), u);
      ivs.push(
        t1 <= t2
          ? { lo: t1, hi: t2, loPt: e1, hiPt: e2 }
          : { lo: t2, hi: t1, loPt: e2, hiPt: e1 },
      );
      used[j] = 1;
    }
    if (ivs.length < 2) continue;
    ivs.sort((a, b) => a.lo - b.lo);
    for (let k = 0; k < ivs.length - 1; k++) {
      const gap = ivs[k + 1].lo - ivs[k].hi;
      if (gap <= offsetTol || gap >= maxGap) continue;
      out.push({
        x1: ivs[k].hiPt.x,
        y1: ivs[k].hiPt.y,
        x2: ivs[k + 1].loPt.x,
        y2: ivs[k + 1].loPt.y,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pipeline step 6: build half-edge graph + connectivity-based pruning
// ---------------------------------------------------------------------------

function keyVec(x: number, y: number, snap: number): string {
  return `${Math.round(x / snap)}|${Math.round(y / snap)}`;
}

interface RawGraph {
  vertices: Vec[];
  /** Each edge is (vertexA, vertexB), unordered. */
  edges: { a: number; b: number }[];
}

function buildRawGraph(segs: RawSegment[], snap: number): RawGraph {
  const idByKey = new Map<string, number>();
  const vertices: Vec[] = [];
  const getOrAdd = (x: number, y: number): number => {
    const k = keyVec(x, y, snap);
    const id = idByKey.get(k);
    if (id !== undefined) return id;
    const next = vertices.length;
    vertices.push({ x, y });
    idByKey.set(k, next);
    return next;
  };
  // Dedup edges by ordered (min,max) vertex pair.
  const edgeMap = new Map<string, { a: number; b: number }>();
  for (const s of segs) {
    const a = getOrAdd(s.x1, s.y1);
    const b = getOrAdd(s.x2, s.y2);
    if (a === b) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    edgeMap.set(`${lo}|${hi}`, { a: lo, b: hi });
  }
  return { vertices, edges: [...edgeMap.values()] };
}

function pruneSmallComponents(
  g: RawGraph,
  componentMinSizeRatio: number,
): RawGraph {
  if (g.edges.length === 0) return g;
  const parent = g.vertices.map((_, i) => i);
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
  for (const e of g.edges) union(e.a, e.b);

  // Total edge length per component root.
  const compLen = new Map<number, number>();
  for (const e of g.edges) {
    const r = find(e.a);
    const len = Math.hypot(
      g.vertices[e.a].x - g.vertices[e.b].x,
      g.vertices[e.a].y - g.vertices[e.b].y,
    );
    compLen.set(r, (compLen.get(r) ?? 0) + len);
  }
  let largest = 0;
  for (const l of compLen.values()) if (l > largest) largest = l;
  if (largest === 0) return g;
  const threshold = largest * componentMinSizeRatio;
  const keptEdges = g.edges.filter(
    (e) => (compLen.get(find(e.a)) ?? 0) >= threshold,
  );
  // Compact vertices to only those referenced by kept edges.
  const refKeep = new Set<number>();
  for (const e of keptEdges) {
    refKeep.add(e.a);
    refKeep.add(e.b);
  }
  const remap = new Map<number, number>();
  const newVerts: Vec[] = [];
  for (const oldId of refKeep) {
    remap.set(oldId, newVerts.length);
    newVerts.push(g.vertices[oldId]);
  }
  const newEdges = keptEdges.map((e) => ({
    a: remap.get(e.a)!,
    b: remap.get(e.b)!,
  }));
  return { vertices: newVerts, edges: newEdges };
}

function pruneShortStubs(g: RawGraph, minLen: number): RawGraph {
  if (g.edges.length === 0) return g;
  // Iteratively peel degree-1 short stubs. T-splits often leave tiny
  // dangling spurs where a wall corner was almost-but-not-quite snapped
  // to a neighbor; peeling makes the graph more uniform.
  let edges = g.edges.slice();
  let changed = true;
  const guard = 10; // safety bound on iterations
  for (let pass = 0; pass < guard && changed; pass++) {
    changed = false;
    const degree = new Array(g.vertices.length).fill(0);
    for (const e of edges) {
      degree[e.a]++;
      degree[e.b]++;
    }
    const next: { a: number; b: number }[] = [];
    for (const e of edges) {
      const dA = degree[e.a];
      const dB = degree[e.b];
      const len = Math.hypot(
        g.vertices[e.a].x - g.vertices[e.b].x,
        g.vertices[e.a].y - g.vertices[e.b].y,
      );
      const isStub = (dA === 1 || dB === 1) && len < minLen;
      if (isStub) {
        changed = true;
        continue;
      }
      next.push(e);
    }
    edges = next;
  }
  // Compact vertices.
  const ref = new Set<number>();
  for (const e of edges) {
    ref.add(e.a);
    ref.add(e.b);
  }
  const remap = new Map<number, number>();
  const newVerts: Vec[] = [];
  for (const oldId of ref) {
    remap.set(oldId, newVerts.length);
    newVerts.push(g.vertices[oldId]);
  }
  const newEdges = edges.map((e) => ({
    a: remap.get(e.a)!,
    b: remap.get(e.b)!,
  }));
  return { vertices: newVerts, edges: newEdges };
}

function buildHalfEdges(g: RawGraph): WallGraph {
  const halfEdges: WallHalfEdge[] = [];
  const edges: WallEdge[] = [];
  for (const e of g.edges) {
    const eid = edges.length;
    const he12 = halfEdges.length;
    const he21 = he12 + 1;
    halfEdges.push({
      origin: e.a,
      target: e.b,
      twin: he21,
      next: -1,
      edgeId: eid,
    });
    halfEdges.push({
      origin: e.b,
      target: e.a,
      twin: he12,
      next: -1,
      edgeId: eid,
    });
    const len = Math.hypot(
      g.vertices[e.a].x - g.vertices[e.b].x,
      g.vertices[e.a].y - g.vertices[e.b].y,
    );
    edges.push({ p1: e.a, p2: e.b, lengthPt: len, he12, he21 });
  }
  // Outgoing half-edges per vertex, sorted CCW by direction angle.
  const vertices: WallVertex[] = g.vertices.map((v) => ({
    x: v.x,
    y: v.y,
    outgoing: [],
  }));
  for (let i = 0; i < halfEdges.length; i++) {
    vertices[halfEdges[i].origin].outgoing.push(i);
  }
  for (const v of vertices) {
    v.outgoing.sort((a, b) => {
      const ta = g.vertices[halfEdges[a].target];
      const tb = g.vertices[halfEdges[b].target];
      const av = vertices[halfEdges[a].origin];
      const angA = Math.atan2(ta.y - av.y, ta.x - av.x);
      const angB = Math.atan2(tb.y - av.y, tb.x - av.x);
      return angA - angB;
    });
  }
  // CCW face-walk next pointer: at target, next is the outgoing edge
  // immediately BEFORE twin(h) in CCW order — i.e., the most
  // clockwise outgoing after twin. Same convention as planar-graph.ts
  // so faces are walked consistently if a downstream consumer wants
  // them.
  for (let i = 0; i < halfEdges.length; i++) {
    const h = halfEdges[i];
    const out = vertices[h.target].outgoing;
    const idxTwin = out.indexOf(h.twin);
    const n = out.length;
    h.next = idxTwin < 0 ? h.twin : out[(idxTwin - 1 + n) % n];
  }
  return { vertices, halfEdges, edges };
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function buildWallGraph(
  rawSegments: RawSegment[],
  opts: BuildWallGraphOpts = {},
): WallGraph {
  const o = { ...DEFAULT_OPTS, ...opts };

  // Pre-filter: drop zero-length and obviously-bogus segments.
  const seeded: RawSegment[] = [];
  for (const s of rawSegments) {
    const dx = s.x2 - s.x1;
    const dy = s.y2 - s.y1;
    if (dx * dx + dy * dy < 1) continue;
    seeded.push(s);
  }

  const snapped = snapEndpoints(seeded, o.snapPt);
  const merged = mergeCollinear(snapped, o.collinearAngleTol, o.collinearOffsetPt);
  const split = splitAtIntersections(merged, o.snapPt);
  const resnapped = snapEndpoints(split, o.snapPt);
  const bridged = closeCollinearGaps(
    resnapped,
    o.doorGapPt,
    o.collinearAngleTol,
    o.collinearOffsetPt,
  );
  const reMerged = mergeCollinear(
    bridged,
    o.collinearAngleTol,
    o.collinearOffsetPt,
  );
  const raw = buildRawGraph(reMerged, o.snapPt);
  const noStubs = pruneShortStubs(raw, o.stubLessThanPt);
  const trimmed = pruneSmallComponents(noStubs, o.componentMinSizeRatio);
  return buildHalfEdges(trimmed);
}

// ---------------------------------------------------------------------------
// Helper exposed for diagnostics + the manual-trace snap engine
// ---------------------------------------------------------------------------

/**
 * Return the cleaned undirected edges of a wall graph as point pairs
 * in PDF pt. The walls API serializes these to the client so the
 * editor's snap engine sees the same geometry the auto-trace walks.
 */
export function wallGraphSegments(graph: WallGraph): RawSegment[] {
  return graph.edges.map((e) => ({
    x1: graph.vertices[e.p1].x,
    y1: graph.vertices[e.p1].y,
    x2: graph.vertices[e.p2].x,
    y2: graph.vertices[e.p2].y,
  }));
}

/** Total wall length in PDF pt — used as a diagnostic in tests. */
export function wallGraphTotalLengthPt(graph: WallGraph): number {
  let total = 0;
  for (const e of graph.edges) total += e.lengthPt;
  return total;
}
