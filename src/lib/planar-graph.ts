/**
 * Planar-graph room polygon recovery.
 *
 * Input: a flat list of axis-aligned line segments extracted from the
 * PDF's vector layer (walls + partitions).
 *
 * Output: a list of closed polygons (faces of the planar graph), each
 * representing a room.
 *
 * Algorithm:
 *   1. Snap nearby endpoints to a grid so walls that don't quite meet
 *      become connected.
 *   2. Detect T-intersections: where one segment's endpoint lies on
 *      another segment's interior, split the longer segment at that
 *      point.
 *   3. Detect crossings: where H and V segments cross interior-to-
 *      interior, split both at the crossing.
 *   4. Build a half-edge graph: each segment becomes two directed
 *      half-edges. Twin-link them and sort outgoing edges per vertex
 *      in CCW angular order.
 *   5. For each half-edge h ending at vertex v, set next(h) = the
 *      outgoing edge at v that comes IMMEDIATELY AFTER twin(h) in CCW
 *      order. That walks the face on h's LEFT side.
 *   6. Walk half-edges via next until cycles close — each closed walk
 *      is one face of the planar subdivision.
 *   7. Shoelace each face. Inner faces have positive area (CCW); the
 *      outer face has negative area (CW from outside).
 *   8. Filter by min/max area and aspect ratio.
 *
 * Coordinate system: PDF user space (Y up, origin bottom-left).
 *
 * Complexity: O(n²) on segment count from the T-split + crossing
 * passes. With ~8k segments on a real commercial plan this runs in
 * 1-3 s in plain JS. Swappable for Bentley-Ottmann sweep later.
 */

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface RoomFace {
  /** Closed polygon, in order. polygon[0] != polygon[n-1]. */
  polygon: { x: number; y: number }[];
  /** Signed area (positive for CCW). */
  area: number;
  /** Axis-aligned bounding box. */
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface PlanarGraphOptions {
  /** Snap radius for endpoint coincidence. Default 1.5 PDF points. */
  snapTolerance?: number;
  /**
   * Maximum wall gap to bridge when closing door openings. Architectural
   * walls are interrupted by doors (~27-40 pt at 1/8":1' scale). When two
   * collinear segments at the same Y/X have a gap smaller than this, the
   * algorithm inserts a virtual connecting segment to close the room.
   * Default 45 pt — a bit more than a 3-ft door at 1/8":1'.
   */
  maxDoorGap?: number;
  /**
   * Optional door positions detected from the CAD layer (door swing
   * arcs + door panel lines). When provided, gap closure ONLY bridges
   * gaps that have a door symbol within `doorMatchRadius` pt. Without
   * this evidence, the gap stays open. This is what separates rooms
   * vs. wraparound faces.
   *
   * If omitted, the algorithm falls back to blanket distance-based
   * gap closure (more closures, more wraparound risk).
   */
  doorCandidates?: { x: number; y: number; size: number }[];
  /**
   * Max distance from a wall gap midpoint to the nearest door symbol
   * for the gap to be considered a real door. Default 30 pt.
   */
  doorMatchRadius?: number;
  /** Minimum polygon area to count as a room (page-coord squared). */
  minRoomArea?: number;
  /** Maximum polygon area to count as a room (caps the outer face). */
  maxRoomArea?: number;
  /** Max aspect ratio (long edge / short edge). Drops slivers. */
  maxAspectRatio?: number;
  /**
   * Max polygon vertex count. Real architectural rooms are simple:
   * rectangles (4), L/T-shapes (6-8), complex with notches up to ~14.
   * Faces with 20+ vertices are almost always "wraparound" interior
   * space where one face encloses many disconnected interior features
   * (fixtures, columns, hatched patterns). Default 24 keeps complex
   * but real rooms, drops the wraparounds.
   */
  maxVertices?: number;
}

const DEFAULT_SNAP = 1.5;
const DEFAULT_DOOR_GAP = 45;
const DEFAULT_MIN_AREA = 4000;
const DEFAULT_MAX_AREA = 5_000_000;
const DEFAULT_MAX_ASPECT = 25;
const DEFAULT_MAX_VERTICES = 24;
const DEFAULT_DOOR_MATCH_RADIUS = 30;

export function detectRooms(
  segments: Segment[],
  pageWidthPt: number,
  pageHeightPt: number,
  opts: PlanarGraphOptions = {},
): RoomFace[] {
  const snap = opts.snapTolerance ?? DEFAULT_SNAP;
  const doorGap = opts.maxDoorGap ?? DEFAULT_DOOR_GAP;
  const minArea = opts.minRoomArea ?? DEFAULT_MIN_AREA;
  const maxArea = opts.maxRoomArea ?? DEFAULT_MAX_AREA;
  const maxAspect = opts.maxAspectRatio ?? DEFAULT_MAX_ASPECT;
  const maxVerts = opts.maxVertices ?? DEFAULT_MAX_VERTICES;
  const doorMatchRadius = opts.doorMatchRadius ?? DEFAULT_DOOR_MATCH_RADIUS;

  const snapped = snapSegments(segments, snap);
  // Close door gaps. With doorCandidates: only bridge gaps that have a
  // door symbol nearby (precise, low false-bridge rate). Without:
  // bridge by distance only (more aggressive, higher wraparound risk).
  const closed = closeWallGaps(
    snapped,
    doorGap,
    snap,
    opts.doorCandidates,
    doorMatchRadius,
  );
  const split = splitAtIntersections(closed, snap);
  // Second snap pass: the T-intersection step introduces new vertices
  // (split points). These may need to be merged with nearby original
  // endpoints that were close but not coincident.
  const resnapped = snapSegments(split, snap);
  const deduped = dedupeSegments(resnapped);
  const graph = buildHalfEdgeGraph(deduped);
  const cycles = enumerateFaces(graph);
  const rooms = extractRoomFaces(
    graph,
    cycles,
    minArea,
    maxArea,
    maxAspect,
    maxVerts,
    pageWidthPt,
    pageHeightPt,
  );
  rooms.sort((a, b) => b.area - a.area);
  return rooms;
}

// ── Step 1: snap endpoints (cluster-merge) ────────────────────────────────

/**
 * Cluster endpoints that lie within `snap` of each other and replace
 * them all with their cluster's centroid. Uses a spatial-hash bucket
 * grid for O(n) expected time.
 *
 * Why cluster-merge instead of grid-round: with grid-round, two
 * endpoints 0.3pt apart can land in DIFFERENT grid cells (e.g., one
 * at 0.7 → 0, the other at 1.4 → 1.5). Cluster-merge guarantees that
 * any two points within `snap` of each other end up at the same
 * canonical location.
 */
function snapSegments(segments: Segment[], snap: number): Segment[] {
  // Collect unique-ish endpoints. Use a microscopic grid (snap/10) as
  // the dedup key so identical inputs don't generate duplicate entries.
  const microGrid = snap / 10;
  const pointMap = new Map<string, { x: number; y: number; cluster: number }>();
  const pointList: { x: number; y: number; cluster: number }[] = [];
  const pointKey = (x: number, y: number): string =>
    `${Math.round(x / microGrid)}|${Math.round(y / microGrid)}`;
  const addPoint = (x: number, y: number): void => {
    const k = pointKey(x, y);
    if (pointMap.has(k)) return;
    const entry = { x, y, cluster: pointList.length };
    pointMap.set(k, entry);
    pointList.push(entry);
  };
  for (const s of segments) {
    addPoint(s.x1, s.y1);
    addPoint(s.x2, s.y2);
  }

  // Spatial-hash bucket by `snap`-sized cells, then for each point
  // merge clusters with neighbors within `snap`.
  const parent: number[] = pointList.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) {
      const n = parent[i];
      parent[i] = r;
      i = n;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const buckets = new Map<string, number[]>();
  const bucketKey = (x: number, y: number): string =>
    `${Math.floor(x / snap)}|${Math.floor(y / snap)}`;
  for (let i = 0; i < pointList.length; i++) {
    const p = pointList[i];
    const k = bucketKey(p.x, p.y);
    const list = buckets.get(k) ?? [];
    list.push(i);
    buckets.set(k, list);
  }
  const snapSq = snap * snap;
  for (let i = 0; i < pointList.length; i++) {
    const p = pointList[i];
    const bx = Math.floor(p.x / snap);
    const by = Math.floor(p.y / snap);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const k = `${bx + dx}|${by + dy}`;
        const neighbors = buckets.get(k);
        if (!neighbors) continue;
        for (const j of neighbors) {
          if (j <= i) continue;
          const q = pointList[j];
          const ddx = p.x - q.x;
          const ddy = p.y - q.y;
          if (ddx * ddx + ddy * ddy <= snapSq) union(i, j);
        }
      }
    }
  }

  // Compute centroid per cluster.
  const sums = new Map<number, { sx: number; sy: number; n: number }>();
  for (let i = 0; i < pointList.length; i++) {
    const r = find(i);
    const cur = sums.get(r) ?? { sx: 0, sy: 0, n: 0 };
    cur.sx += pointList[i].x;
    cur.sy += pointList[i].y;
    cur.n += 1;
    sums.set(r, cur);
  }
  const centroid = new Map<number, { x: number; y: number }>();
  for (const [r, { sx, sy, n }] of sums) {
    centroid.set(r, { x: sx / n, y: sy / n });
  }
  const lookup = (x: number, y: number): { x: number; y: number } => {
    const k = pointKey(x, y);
    const entry = pointMap.get(k);
    if (!entry) return { x, y };
    const c = centroid.get(find(entry.cluster));
    return c ?? { x, y };
  };

  const out: Segment[] = [];
  for (const s of segments) {
    const a = lookup(s.x1, s.y1);
    const b = lookup(s.x2, s.y2);
    if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) continue;
    out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }
  return out;
}

// ── Step 1b: close wall gaps from door openings ───────────────────────────

/**
 * Architectural walls are interrupted by door openings — a continuous
 * wall in CAD is drawn as two collinear segments with a 27-40 pt gap
 * (a 3-ft door at 1/8":1' scale). For room recovery, these gaps need
 * to be closed so the face walks around the room without escaping
 * through the door.
 *
 * For each pair of collinear neighbor segments at the same Y (or X),
 * if the gap between them is less than `maxGap`, insert a connecting
 * segment. The connecting segment closes the gap and makes the wall
 * continuous in the planar graph.
 *
 * This DOES bridge gaps that aren't door openings (two walls happen
 * to be near each other), so it can over-merge. The vertex-count
 * filter at the end catches most over-merges as "wraparound" faces.
 */
function closeWallGaps(
  segs: Segment[],
  maxGap: number,
  snap: number,
  doorCandidates?: { x: number; y: number; size: number }[],
  doorMatchRadius: number = 30,
): Segment[] {
  const out = segs.slice();
  const horizontals: Segment[] = [];
  const verticals: Segment[] = [];
  for (const s of segs) {
    if (Math.abs(s.y2 - s.y1) < snap) horizontals.push(s);
    else if (Math.abs(s.x2 - s.x1) < snap) verticals.push(s);
  }

  // If door candidates are provided, only bridge gaps with a door
  // symbol nearby. Build a bucket grid for fast lookup.
  const hasDoorEvidence = !!doorCandidates && doorCandidates.length > 0;
  const doorBucketSize = doorMatchRadius;
  const doorBuckets = new Map<string, { x: number; y: number; size: number }[]>();
  if (hasDoorEvidence) {
    for (const d of doorCandidates!) {
      const k = `${Math.floor(d.x / doorBucketSize)}|${Math.floor(d.y / doorBucketSize)}`;
      const list = doorBuckets.get(k) ?? [];
      list.push(d);
      doorBuckets.set(k, list);
    }
  }
  const doorNear = (x: number, y: number): boolean => {
    if (!hasDoorEvidence) return true;
    const bx = Math.floor(x / doorBucketSize);
    const by = Math.floor(y / doorBucketSize);
    const r2 = doorMatchRadius * doorMatchRadius;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = doorBuckets.get(`${bx + dx}|${by + dy}`);
        if (!list) continue;
        for (const d of list) {
          const ddx = d.x - x;
          const ddy = d.y - y;
          if (ddx * ddx + ddy * ddy <= r2) return true;
        }
      }
    }
    return false;
  };

  // Horizontals: group by Y, sort by xMin, bridge door-evidenced gaps.
  const hByY = new Map<number, Segment[]>();
  for (const s of horizontals) {
    const yKey = Math.round(s.y1 / snap) * snap;
    const list = hByY.get(yKey) ?? [];
    list.push(s);
    hByY.set(yKey, list);
  }
  for (const list of hByY.values()) {
    list.sort((a, b) => Math.min(a.x1, a.x2) - Math.min(b.x1, b.x2));
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i];
      const b = list[i + 1];
      const aMax = Math.max(a.x1, a.x2);
      const bMin = Math.min(b.x1, b.x2);
      const gap = bMin - aMax;
      if (gap <= snap || gap >= maxGap) continue;
      const midX = (aMax + bMin) / 2;
      if (!doorNear(midX, a.y1)) continue;
      out.push({ x1: aMax, y1: a.y1, x2: bMin, y2: a.y1 });
    }
  }

  // Verticals.
  const vByX = new Map<number, Segment[]>();
  for (const s of verticals) {
    const xKey = Math.round(s.x1 / snap) * snap;
    const list = vByX.get(xKey) ?? [];
    list.push(s);
    vByX.set(xKey, list);
  }
  for (const list of vByX.values()) {
    list.sort((a, b) => Math.min(a.y1, a.y2) - Math.min(b.y1, b.y2));
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i];
      const b = list[i + 1];
      const aMax = Math.max(a.y1, a.y2);
      const bMin = Math.min(b.y1, b.y2);
      const gap = bMin - aMax;
      if (gap <= snap || gap >= maxGap) continue;
      const midY = (aMax + bMin) / 2;
      if (!doorNear(a.x1, midY)) continue;
      out.push({ x1: a.x1, y1: aMax, x2: a.x1, y2: bMin });
    }
  }

  return out;
}

// ── Step 2: T-intersection + crossing splitting ───────────────────────────

function splitAtIntersections(segs: Segment[], snap: number): Segment[] {
  const endpoints = new Set<string>();
  for (const s of segs) {
    endpoints.add(keyXY(s.x1, s.y1));
    endpoints.add(keyXY(s.x2, s.y2));
  }
  const endpointList = [...endpoints].map(parseXY);

  // T-intersection pass.
  const tSplit: Segment[] = [];
  for (const s of segs) {
    const horizontal = Math.abs(s.y2 - s.y1) < snap;
    const vertical = Math.abs(s.x2 - s.x1) < snap;
    if (!horizontal && !vertical) {
      tSplit.push(s);
      continue;
    }

    const cuts: number[] = [];
    if (horizontal) {
      const y = s.y1;
      const xMin = Math.min(s.x1, s.x2);
      const xMax = Math.max(s.x1, s.x2);
      for (const [px, py] of endpointList) {
        if (Math.abs(py - y) > snap) continue;
        if (px <= xMin + snap || px >= xMax - snap) continue;
        cuts.push(px);
      }
    } else {
      const x = s.x1;
      const yMin = Math.min(s.y1, s.y2);
      const yMax = Math.max(s.y1, s.y2);
      for (const [px, py] of endpointList) {
        if (Math.abs(px - x) > snap) continue;
        if (py <= yMin + snap || py >= yMax - snap) continue;
        cuts.push(py);
      }
    }

    if (cuts.length === 0) {
      tSplit.push(s);
      continue;
    }
    cuts.sort((a, b) => a - b);
    if (horizontal) {
      let prev = Math.min(s.x1, s.x2);
      const end = Math.max(s.x1, s.x2);
      for (const c of cuts) {
        if (c - prev > snap) tSplit.push({ x1: prev, y1: s.y1, x2: c, y2: s.y1 });
        prev = c;
      }
      if (end - prev > snap) tSplit.push({ x1: prev, y1: s.y1, x2: end, y2: s.y1 });
    } else {
      let prev = Math.min(s.y1, s.y2);
      const end = Math.max(s.y1, s.y2);
      for (const c of cuts) {
        if (c - prev > snap) tSplit.push({ x1: s.x1, y1: prev, x2: s.x1, y2: c });
        prev = c;
      }
      if (end - prev > snap) tSplit.push({ x1: s.x1, y1: prev, x2: s.x1, y2: end });
    }
  }

  // H × V crossing pass.
  const horizontals = tSplit.filter((s) => Math.abs(s.y2 - s.y1) < snap);
  const verticals = tSplit.filter((s) => Math.abs(s.x2 - s.x1) < snap);
  // Bucket verticals by X (50pt buckets) to speed up the inner loop.
  const vBucket = new Map<number, Segment[]>();
  for (const v of verticals) {
    const b = Math.round(v.x1 / 50);
    const list = vBucket.get(b) ?? [];
    list.push(v);
    vBucket.set(b, list);
  }
  const horizCuts = new Map<string, Set<number>>();
  const vertCuts = new Map<string, Set<number>>();
  const segKey = (s: Segment) => `${s.x1}|${s.y1}|${s.x2}|${s.y2}`;
  const addCut = (
    m: Map<string, Set<number>>,
    k: string,
    v: number,
  ): void => {
    let set = m.get(k);
    if (!set) {
      set = new Set();
      m.set(k, set);
    }
    set.add(v);
  };
  for (const h of horizontals) {
    const y = h.y1;
    const hXMin = Math.min(h.x1, h.x2);
    const hXMax = Math.max(h.x1, h.x2);
    const bMin = Math.round(hXMin / 50);
    const bMax = Math.round(hXMax / 50);
    for (let b = bMin - 1; b <= bMax + 1; b++) {
      const vs = vBucket.get(b);
      if (!vs) continue;
      for (const v of vs) {
        if (v.x1 < hXMin + snap || v.x1 > hXMax - snap) continue;
        const vYMin = Math.min(v.y1, v.y2);
        const vYMax = Math.max(v.y1, v.y2);
        if (y < vYMin + snap || y > vYMax - snap) continue;
        addCut(horizCuts, segKey(h), v.x1);
        addCut(vertCuts, segKey(v), y);
      }
    }
  }

  const finalMap = new Map<string, Segment>();
  for (const s of tSplit) {
    const key = segKey(s);
    const hc = horizCuts.get(key);
    const vc = vertCuts.get(key);
    if (!hc && !vc) {
      finalMap.set(key, s);
      continue;
    }
    if (hc) {
      const cuts = [...hc].sort((a, b) => a - b);
      const xMin = Math.min(s.x1, s.x2);
      const xMax = Math.max(s.x1, s.x2);
      let prev = xMin;
      for (const x of cuts) {
        if (x - prev > snap) {
          const seg = { x1: prev, y1: s.y1, x2: x, y2: s.y1 };
          finalMap.set(segKey(seg), seg);
        }
        prev = x;
      }
      if (xMax - prev > snap) {
        const seg = { x1: prev, y1: s.y1, x2: xMax, y2: s.y1 };
        finalMap.set(segKey(seg), seg);
      }
    } else if (vc) {
      const cuts = [...vc].sort((a, b) => a - b);
      const yMin = Math.min(s.y1, s.y2);
      const yMax = Math.max(s.y1, s.y2);
      let prev = yMin;
      for (const y of cuts) {
        if (y - prev > snap) {
          const seg = { x1: s.x1, y1: prev, x2: s.x1, y2: y };
          finalMap.set(segKey(seg), seg);
        }
        prev = y;
      }
      if (yMax - prev > snap) {
        const seg = { x1: s.x1, y1: prev, x2: s.x1, y2: yMax };
        finalMap.set(segKey(seg), seg);
      }
    }
  }
  return [...finalMap.values()];
}

function keyXY(x: number, y: number): string {
  return `${x}|${y}`;
}
function parseXY(k: string): [number, number] {
  const [a, b] = k.split("|");
  return [parseFloat(a), parseFloat(b)];
}

// ── Step 3: dedupe ────────────────────────────────────────────────────────

function dedupeSegments(segs: Segment[]): Segment[] {
  const seen = new Set<string>();
  const out: Segment[] = [];
  for (const s of segs) {
    const swap = s.x1 > s.x2 || (s.x1 === s.x2 && s.y1 > s.y2);
    const norm = swap
      ? { x1: s.x2, y1: s.y2, x2: s.x1, y2: s.y1 }
      : s;
    const key = `${norm.x1}|${norm.y1}|${norm.x2}|${norm.y2}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}

// ── Step 4: half-edge graph ───────────────────────────────────────────────

interface Graph {
  points: { x: number; y: number }[];
  halfEdges: { origin: number; target: number; twin: number; next: number }[];
}

function buildHalfEdgeGraph(segs: Segment[]): Graph {
  const idByKey = new Map<string, number>();
  const points: { x: number; y: number }[] = [];
  const getOrAdd = (x: number, y: number): number => {
    const k = keyXY(x, y);
    const id = idByKey.get(k);
    if (id !== undefined) return id;
    const nextId = points.length;
    points.push({ x, y });
    idByKey.set(k, nextId);
    return nextId;
  };

  const halfEdges: Graph["halfEdges"] = [];
  for (const s of segs) {
    const a = getOrAdd(s.x1, s.y1);
    const b = getOrAdd(s.x2, s.y2);
    if (a === b) continue;
    const ab = halfEdges.length;
    const ba = halfEdges.length + 1;
    halfEdges.push({ origin: a, target: b, twin: ba, next: -1 });
    halfEdges.push({ origin: b, target: a, twin: ab, next: -1 });
  }

  const outgoing: number[][] = points.map(() => []);
  for (let i = 0; i < halfEdges.length; i++) {
    outgoing[halfEdges[i].origin].push(i);
  }
  for (let p = 0; p < points.length; p++) {
    const o = points[p];
    outgoing[p].sort((a, b) => {
      const ta = points[halfEdges[a].target];
      const tb = points[halfEdges[b].target];
      return (
        Math.atan2(ta.y - o.y, ta.x - o.x) -
        Math.atan2(tb.y - o.y, tb.x - o.x)
      );
    });
  }

  // For each half-edge h: a → b. At b, twin(h) is b → a. next(h) is the
  // outgoing edge at b immediately BEFORE twin(h) in CCW order (i.e.,
  // the most clockwise outgoing edge after twin). That walks the face
  // on h's LEFT side. With this rule, inner faces are traversed CCW
  // and the outer face CW, so shoelace > 0 ⇒ inner, < 0 ⇒ outer.
  for (let i = 0; i < halfEdges.length; i++) {
    const h = halfEdges[i];
    const out = outgoing[h.target];
    const idxTwin = out.indexOf(h.twin);
    const n = out.length;
    h.next = idxTwin < 0 ? h.twin : out[(idxTwin - 1 + n) % n];
  }

  return { points, halfEdges };
}

// ── Step 5: face enumeration ──────────────────────────────────────────────

function enumerateFaces(graph: Graph): number[][] {
  const visited = new Uint8Array(graph.halfEdges.length);
  const faces: number[][] = [];
  const limit = graph.halfEdges.length + 5;
  for (let i = 0; i < graph.halfEdges.length; i++) {
    if (visited[i]) continue;
    const cycle: number[] = [];
    let cur = i;
    let guard = 0;
    while (!visited[cur] && guard++ < limit) {
      visited[cur] = 1;
      cycle.push(cur);
      cur = graph.halfEdges[cur].next;
    }
    if (cycle.length >= 3) faces.push(cycle);
  }
  return faces;
}

// ── Step 6: filter to rooms ───────────────────────────────────────────────

function extractRoomFaces(
  graph: Graph,
  faces: number[][],
  minArea: number,
  maxArea: number,
  maxAspect: number,
  maxVerts: number,
  pageWidthPt: number,
  pageHeightPt: number,
): RoomFace[] {
  const pageArea = pageWidthPt * pageHeightPt;
  const out: RoomFace[] = [];
  for (const cycle of faces) {
    const poly: { x: number; y: number }[] = [];
    for (const heId of cycle) {
      poly.push(graph.points[graph.halfEdges[heId].origin]);
    }
    if (poly.length < 3) continue;
    if (poly.length > maxVerts) continue;

    const area = shoelaceSignedArea(poly);
    if (area <= 0) continue; // outer face has negative signed area
    if (area >= 0.85 * pageArea) continue;
    if (area < minArea) continue;
    if (area > maxArea) continue;

    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of poly) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 1 || h < 1) continue;
    const aspect = Math.max(w / h, h / w);
    if (aspect > maxAspect) continue;

    out.push({ polygon: poly, area, bbox: { x0, y0, x1, y1 } });
  }
  return out;
}

export function shoelaceSignedArea(
  poly: { x: number; y: number }[],
): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return 0.5 * sum;
}
