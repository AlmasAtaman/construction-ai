/**
 * Seeded room segmentation — split OPEN-CONNECTED space into individual
 * rooms, which planar-graph face detection can't (it over-merges across
 * openings into one giant region).
 *
 * Recipe (deterministic, no training data; validated on the Beaver Tails
 * commercial plan): rasterize the correct wall segments into a barrier
 * grid, drop a seed at each room-tag position, flood every free cell to
 * its nearest seed by multi-source BFS. The cut between two rooms lands
 * naturally where the two flood fronts collide at the opening. Each
 * region's boundary is then traced into a polygon; the part of that
 * boundary touching walls is the paintable wall perimeter (the opening
 * cuts are not walls and don't count).
 *
 * Backed by US11227083B2 (gap-close then group), Ahmed & Liwicki 2012
 * (in-room text labels as the per-room signal), and the FARO patent
 * US20220051459A1 (close openings before segmenting).
 */

import type { RoomSeed } from "./room-seeds";

export interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface SeededRoom {
  label: string | null;
  /** Boundary polygon, PDF pt (y-down). */
  polygonPt: { x: number; y: number }[];
  /** Wall-adjacent perimeter (paintable), feet. Excludes opening cuts. */
  wallPerimeterFt: number;
  /** Full boundary perimeter incl. opening cuts, feet. */
  totalPerimeterFt: number;
  areaSqft: number;
}

export interface SeededRoomsResult {
  rooms: SeededRoom[];
  /** Chosen plan-view bbox (pt) the rooms were segmented within. */
  viewBounds: { x0: number; y0: number; x1: number; y1: number };
}

/** Grid resolution: pt per pixel. 2pt ≈ 0.11ft — fine enough for wall
 *  outlines, cheap enough for full-sheet BFS. */
const GRID_PT = 2;
/** Max gap (pt) between wall-segment bboxes counted as the same view. */
const VIEW_GAP_PT = 150;

function segLenPt(s: Seg): number {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
}

interface Cluster {
  segs: Seg[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  len: number;
}

/** Agglomerative bbox clustering → pick the plan view with most wall. */
function bestView(walls: Seg[]): Cluster | null {
  let clusters: Cluster[] = walls.map((s) => ({
    segs: [s],
    x0: Math.min(s.x1, s.x2),
    y0: Math.min(s.y1, s.y2),
    x1: Math.max(s.x1, s.x2),
    y1: Math.max(s.y1, s.y2),
    len: segLenPt(s),
  }));
  const touch = (a: Cluster, b: Cluster) =>
    a.x0 - VIEW_GAP_PT <= b.x1 &&
    b.x0 - VIEW_GAP_PT <= a.x1 &&
    a.y0 - VIEW_GAP_PT <= b.y1 &&
    b.y0 - VIEW_GAP_PT <= a.y1;
  let merged = true;
  while (merged) {
    merged = false;
    const next: Cluster[] = [];
    for (const c of clusters) {
      const host = next.find((n) => touch(n, c));
      if (host) {
        host.segs.push(...c.segs);
        host.x0 = Math.min(host.x0, c.x0);
        host.y0 = Math.min(host.y0, c.y0);
        host.x1 = Math.max(host.x1, c.x1);
        host.y1 = Math.max(host.y1, c.y1);
        host.len += c.len;
        merged = true;
      } else {
        next.push({ ...c, segs: [...c.segs] });
      }
    }
    clusters = next;
  }
  return clusters.sort((a, b) => b.len - a.len)[0] ?? null;
}

/**
 * Segment rooms from wall segments + room-tag seeds.
 * Returns [] when there aren't ≥2 usable seeds (caller falls back).
 */
export function segmentRoomsBySeeds(
  walls: Seg[],
  seeds: RoomSeed[],
  opts: { ptPerFoot: number; pageWidthPt: number; pageHeightPt: number },
): SeededRoomsResult | null {
  if (walls.length === 0) return null;
  const view = bestView(walls);
  if (!view) return null;

  // Seeds belonging to this plan view: inside the wall bbox, or just
  // outside it (room tags like a washroom can sit slightly past the main
  // wall cluster). 70pt ≈ 4ft of slack.
  const SEED_SLACK = 70;
  const nearView = (x: number, y: number) =>
    x >= view.x0 - SEED_SLACK &&
    x <= view.x1 + SEED_SLACK &&
    y >= view.y0 - SEED_SLACK &&
    y <= view.y1 + SEED_SLACK;
  const viewSeeds = seeds.filter((s) => nearView(s.x, s.y));
  if (viewSeeds.length < 2) return null;

  // Grid bbox = wall view ∪ seed positions, so a room whose tag sits past
  // the wall bbox still gets covered (else its region can't form).
  let bx0 = view.x0;
  let by0 = view.y0;
  let bx1 = view.x1;
  let by1 = view.y1;
  for (const s of viewSeeds) {
    bx0 = Math.min(bx0, s.x);
    by0 = Math.min(by0, s.y);
    bx1 = Math.max(bx1, s.x);
    by1 = Math.max(by1, s.y);
  }
  // Use every wall segment that touches the grid bbox as a barrier (not
  // just the cluster's), so washroom/perimeter walls block correctly.
  const pad = 10;
  const X0 = bx0 - pad;
  const Y0 = by0 - pad;
  const X1 = bx1 + pad;
  const Y1 = by1 + pad;
  const viewWalls = walls.filter(
    (s) =>
      Math.max(s.x1, s.x2) >= X0 &&
      Math.min(s.x1, s.x2) <= X1 &&
      Math.max(s.y1, s.y2) >= Y0 &&
      Math.min(s.y1, s.y2) <= Y1,
  );
  const W = Math.ceil((X1 - X0) / GRID_PT);
  const H = Math.ceil((Y1 - Y0) / GRID_PT);
  const cx = (x: number) => Math.round((x - X0) / GRID_PT);
  const cy = (y: number) => Math.round((y - Y0) / GRID_PT);

  const WALL = new Uint8Array(W * H); // 1 = barrier
  const plot = (c: number, r: number) => {
    // dilate 1px so thin/hairline walls form continuous barriers
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const a = c + dx;
        const b = r + dy;
        if (a >= 0 && a < W && b >= 0 && b < H) WALL[b * W + a] = 1;
      }
  };
  for (const s of viewWalls) {
    // Bresenham
    let c0 = cx(s.x1);
    let r0 = cy(s.y1);
    const c1 = cx(s.x2);
    const r1 = cy(s.y2);
    const dc = Math.abs(c1 - c0);
    const dr = Math.abs(r1 - r0);
    const sc = c0 < c1 ? 1 : -1;
    const sr = r0 < r1 ? 1 : -1;
    let e = dc - dr;
    for (;;) {
      plot(c0, r0);
      if (c0 === c1 && r0 === r1) break;
      const e2 = 2 * e;
      if (e2 > -dr) {
        e -= dr;
        c0 += sc;
      }
      if (e2 < dc) {
        e += dc;
        r0 += sr;
      }
    }
  }

  // --- multi-source BFS: each free cell → nearest seed ---
  const owner = new Int16Array(W * H).fill(-1);
  const queue: number[] = [];
  const placed: number[] = []; // seed index → -1 if unplaceable
  viewSeeds.forEach((s, i) => {
    let c = cx(s.x);
    let r = cy(s.y);
    if (WALL[r * W + c]) {
      // seed landed on a wall — spiral out to nearest free cell
      let found = false;
      for (let R = 1; R <= 12 && !found; R++) {
        for (let dy = -R; dy <= R && !found; dy++)
          for (let dx = -R; dx <= R && !found; dx++) {
            const a = c + dx;
            const b = r + dy;
            if (a >= 0 && a < W && b >= 0 && b < H && !WALL[b * W + a]) {
              c = a;
              r = b;
              found = true;
            }
          }
      }
      if (!found) {
        placed.push(-1);
        return;
      }
    }
    placed.push(i);
    if (owner[r * W + c] === -1) {
      owner[r * W + c] = i;
      queue.push(r * W + c);
    }
  });

  let head = 0;
  while (head < queue.length) {
    const p = queue[head++];
    const r = (p / W) | 0;
    const c = p % W;
    const o = owner[p];
    const nb = [
      [c + 1, r],
      [c - 1, r],
      [c, r + 1],
      [c, r - 1],
    ];
    for (const [a, b] of nb) {
      if (a < 0 || a >= W || b < 0 || b >= H) continue;
      const np = b * W + a;
      if (WALL[np] || owner[np] !== -1) continue;
      owner[np] = o;
      queue.push(np);
    }
  }

  // --- trace each region's boundary into a polygon ---
  const ptPerFoot = opts.ptPerFoot;
  const cellFt2 = (GRID_PT / ptPerFoot) ** 2;
  const rooms: SeededRoom[] = [];
  viewSeeds.forEach((seed, id) => {
    const trace = traceRegion(owner, WALL, W, H, id);
    if (!trace) return;
    const areaSqft = trace.area * cellFt2;
    if (areaSqft < 12) return; // discard slivers
    const rawPoly = trace.loop.map((pt) => ({
      x: X0 + pt.c * GRID_PT,
      y: Y0 + pt.r * GRID_PT,
    }));
    // Smooth the pixel staircase along opening cuts (wall edges are already
    // axis-clean). ~4pt ≈ 0.22ft tolerance.
    const polygonPt = simplifyClosed(rawPoly, 4);
    rooms.push({
      label: seed.label,
      polygonPt,
      wallPerimeterFt: (trace.wallEdgeLen * GRID_PT) / ptPerFoot,
      totalPerimeterFt: (trace.totalEdgeLen * GRID_PT) / ptPerFoot,
      areaSqft,
    });
  });

  return {
    rooms,
    viewBounds: { x0: view.x0, y0: view.y0, x1: view.x1, y1: view.y1 },
  };
}

/** Perpendicular distance from p to segment a-b. */
function perpDist(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/** Douglas-Peucker on an open polyline. */
function dp(
  pts: { x: number; y: number }[],
  eps: number,
): { x: number; y: number }[] {
  if (pts.length < 3) return pts;
  let maxD = 0;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  const left = dp(pts.slice(0, idx + 1), eps);
  const right = dp(pts.slice(idx), eps);
  return [...left.slice(0, -1), ...right];
}

/** Douglas-Peucker on a closed ring (anchored at two extreme vertices). */
function simplifyClosed(
  ring: { x: number; y: number }[],
  eps: number,
): { x: number; y: number }[] {
  if (ring.length < 4) return ring;
  // Anchor at the two farthest-apart-ish vertices: min-x and max-x.
  let lo = 0;
  let hi = 0;
  for (let i = 1; i < ring.length; i++) {
    if (ring[i].x < ring[lo].x) lo = i;
    if (ring[i].x > ring[hi].x) hi = i;
  }
  if (lo === hi) return ring;
  const a = lo < hi ? lo : hi;
  const b = lo < hi ? hi : lo;
  const arc1 = ring.slice(a, b + 1);
  const arc2 = [...ring.slice(b), ...ring.slice(0, a + 1)];
  const s1 = dp(arc1, eps);
  const s2 = dp(arc2, eps);
  // Stitch, dropping shared endpoints.
  const out = [...s1.slice(0, -1), ...s2.slice(0, -1)];
  return out.length >= 3 ? out : ring;
}

interface TraceResult {
  loop: { c: number; r: number }[]; // grid-corner polygon (simplified)
  area: number; // cells owned
  wallEdgeLen: number; // boundary edge units adjacent to wall/outside
  totalEdgeLen: number; // all boundary edge units
}

/**
 * Edge-based boundary trace of one region. Collects unit boundary edges
 * (region cell ↔ non-region neighbor), chains them into the outer loop,
 * and merges collinear runs. Each edge is tagged wall-adjacent or not so
 * the paintable perimeter excludes opening cuts.
 */
function traceRegion(
  owner: Int16Array,
  WALL: Uint8Array,
  W: number,
  H: number,
  id: number,
): TraceResult | null {
  // corner grid is (W+1) x (H+1); key = r*(W+1)+c
  const CW = W + 1;
  const key = (c: number, r: number) => r * CW + c;
  // adjacency: corner → [{to, wall}]
  const adj = new Map<number, { to: number; wall: boolean }[]>();
  const addEdge = (
    c1: number,
    r1: number,
    c2: number,
    r2: number,
    wall: boolean,
  ) => {
    const a = key(c1, r1);
    const b = key(c2, r2);
    (adj.get(a) ?? adj.set(a, []).get(a)!).push({ to: b, wall });
    (adj.get(b) ?? adj.set(b, []).get(b)!).push({ to: a, wall });
  };

  let area = 0;
  let wallEdgeLen = 0;
  let totalEdgeLen = 0;
  let startCorner = -1;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (owner[r * W + c] !== id) continue;
      area++;
      // For each side, if the neighbor isn't this region, it's a boundary
      // edge. wall = neighbor is a barrier or outside the grid.
      // top
      const top = r === 0 ? "out" : owner[(r - 1) * W + c];
      if (top !== id) {
        const wall = top === "out" || WALL[(r - 1) * W + c] === 1;
        addEdge(c, r, c + 1, r, wall);
        totalEdgeLen++;
        if (wall) wallEdgeLen++;
        if (startCorner < 0) startCorner = key(c, r);
      }
      // bottom
      const bot = r === H - 1 ? "out" : owner[(r + 1) * W + c];
      if (bot !== id) {
        const wall = bot === "out" || WALL[(r + 1) * W + c] === 1;
        addEdge(c, r + 1, c + 1, r + 1, wall);
        totalEdgeLen++;
        if (wall) wallEdgeLen++;
      }
      // left
      const left = c === 0 ? "out" : owner[r * W + (c - 1)];
      if (left !== id) {
        const wall = left === "out" || WALL[r * W + (c - 1)] === 1;
        addEdge(c, r, c, r + 1, wall);
        totalEdgeLen++;
        if (wall) wallEdgeLen++;
      }
      // right
      const right = c === W - 1 ? "out" : owner[r * W + (c + 1)];
      if (right !== id) {
        const wall = right === "out" || WALL[r * W + (c + 1)] === 1;
        addEdge(c + 1, r, c + 1, r + 1, wall);
        totalEdgeLen++;
        if (wall) wallEdgeLen++;
      }
    }
  }
  if (area === 0 || startCorner < 0) return null;

  // Walk the boundary from startCorner, always taking an unused edge, to
  // form the longest loop (the outer boundary).
  const used = new Set<string>();
  const edgeId = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const cornerOf = (k: number) => ({ c: k % CW, r: (k / CW) | 0 });

  let best: { c: number; r: number }[] = [];
  // try to walk a single loop from start
  let cur = startCorner;
  const loop: number[] = [cur];
  while (true) {
    const edges = adj.get(cur) ?? [];
    let nextEdge: { to: number; wall: boolean } | null = null;
    for (const e of edges) {
      if (!used.has(edgeId(cur, e.to))) {
        nextEdge = e;
        break;
      }
    }
    if (!nextEdge) break;
    used.add(edgeId(cur, nextEdge.to));
    cur = nextEdge.to;
    if (cur === startCorner) break;
    loop.push(cur);
  }
  best = loop.map(cornerOf);

  // Collinear simplification: drop a vertex if its two neighbors are
  // colinear (same row or same column run).
  const simplified: { c: number; r: number }[] = [];
  const n = best.length;
  for (let i = 0; i < n; i++) {
    const p0 = best[(i - 1 + n) % n];
    const p1 = best[i];
    const p2 = best[(i + 1) % n];
    const colinear =
      (p0.c === p1.c && p1.c === p2.c) || (p0.r === p1.r && p1.r === p2.r);
    if (!colinear) simplified.push(p1);
  }

  return {
    loop: simplified.length >= 3 ? simplified : best,
    area,
    wallEdgeLen,
    totalEdgeLen,
  };
}
