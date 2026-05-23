/**
 * Client-side "follow the wall" traversal for assisted tracing.
 *
 * The walls API (GET /api/plan-pages/[id]/walls) already returns cleaned,
 * merged, deduplicated wall segments (collinear fragments are one segment,
 * endpoints are snapped to shared vertices). This module builds a cheap
 * endpoint-adjacency index over those segments so the editor can, on a
 * single click, walk the connected wall run around corners until it reaches
 * a junction (a vertex where 3+ walls meet) — the eTakeoff-SnapAI "hunt the
 * next logical connecting line" behavior. No network round-trip per click.
 *
 * All coordinates are normalized 0..1 (y-down), matching the snap engine.
 */

export interface RunSeg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface RunPoint {
  x: number;
  y: number;
}

export interface WallRun {
  /** Ordered polyline along the followed run (normalized). */
  points: RunPoint[];
  /** Indices (into the input segments) that were followed, in order. */
  segmentIndices: number[];
  /** True if the run closed back on its starting vertex (e.g. a room loop). */
  closed: boolean;
}

interface Node {
  x: number;
  y: number;
  /** Incident segment endpoints: which segment, and which end (0=a,1=b). */
  incident: { seg: number; end: 0 | 1 }[];
}

export interface RunIndex {
  segments: RunSeg[];
  nodes: Node[];
  /** segment index → [nodeId at end a, nodeId at end b] */
  segNodes: [number, number][];
}

// Endpoints that should coincide are exactly equal coming from the server
// (it clusters them to shared vertices), but render/normalize rounding can
// nudge them. Snap to a small grid (~1px on a 1500px render) to merge.
const NODE_GRID = 0.0008;
const keyOf = (x: number, y: number): string =>
  `${Math.round(x / NODE_GRID)}|${Math.round(y / NODE_GRID)}`;

export function buildRunIndex(segments: RunSeg[]): RunIndex {
  const nodes: Node[] = [];
  const nodeByKey = new Map<string, number>();
  const segNodes: [number, number][] = [];

  const nodeAt = (x: number, y: number): number => {
    const k = keyOf(x, y);
    let id = nodeByKey.get(k);
    if (id === undefined) {
      id = nodes.length;
      nodes.push({ x, y, incident: [] });
      nodeByKey.set(k, id);
    }
    return id;
  };

  segments.forEach((s, i) => {
    const a = nodeAt(s.x1, s.y1);
    const b = nodeAt(s.x2, s.y2);
    nodes[a].incident.push({ seg: i, end: 0 });
    nodes[b].incident.push({ seg: i, end: 1 });
    segNodes.push([a, b]);
  });

  return { segments, nodes, segNodes };
}

/** The node at the given end of a segment. */
function nodeOf(index: RunIndex, seg: number, end: 0 | 1): number {
  return index.segNodes[seg][end];
}

function pointOf(index: RunIndex, nodeId: number): RunPoint {
  const n = index.nodes[nodeId];
  return { x: n.x, y: n.y };
}

/**
 * Walk the connected wall run starting from `startSeg`, heading away from
 * `fromNode` (so the run extends in the direction the user is pointing).
 * Continues through degree-2 vertices (a wall turning a corner or a straight
 * continuation) and stops at junctions (degree ≠ 2), dead ends, or when the
 * run closes. Returns the ordered polyline.
 *
 * `maxSegments` guards against pathological loops.
 */
export function followRun(
  index: RunIndex,
  startSeg: number,
  fromNode: number,
  opts: { maxSegments?: number } = {},
): WallRun {
  const maxSegments = opts.maxSegments ?? 400;
  const [a, b] = index.segNodes[startSeg];
  const startNode = fromNode === a ? a : b;
  let currentNode = fromNode === a ? b : a;

  const points: RunPoint[] = [pointOf(index, startNode), pointOf(index, currentNode)];
  const segmentIndices: number[] = [startSeg];
  const usedSegs = new Set<number>([startSeg]);
  let closed = false;

  while (segmentIndices.length < maxSegments) {
    const node = index.nodes[currentNode];
    // Candidate continuations: incident segments other than the one we
    // arrived on, not already used.
    const lastSeg = segmentIndices[segmentIndices.length - 1];
    const conts = node.incident.filter(
      (inc) => inc.seg !== lastSeg && !usedSegs.has(inc.seg),
    );
    // Degree-2 vertex => exactly one continuation: follow it (corner or
    // straight). Anything else (junction, dead end) stops the run.
    if (node.incident.length !== 2 || conts.length !== 1) break;

    const next = conts[0];
    const nextNode = nodeOf(index, next.seg, next.end === 0 ? 1 : 0);
    usedSegs.add(next.seg);
    segmentIndices.push(next.seg);
    points.push(pointOf(index, nextNode));
    currentNode = nextNode;

    if (currentNode === startNode) {
      closed = true;
      break;
    }
  }

  return { points, segmentIndices, closed };
}

/**
 * Convenience: given a clicked segment and the click point, follow the run
 * in BOTH directions and stitch them so the user gets the whole connected
 * wall run regardless of which end they pointed at. If the run is a closed
 * loop, the forward walk already returns it.
 */
export function followRunBothWays(
  index: RunIndex,
  startSeg: number,
): WallRun {
  const [a, b] = index.segNodes[startSeg];
  const forward = followRun(index, startSeg, a); // heads toward b
  if (forward.closed) return forward;
  const backward = followRun(index, startSeg, b); // heads toward a

  // backward.points start at node b ... node a-side end. Reverse it and drop
  // the shared startSeg span so we don't double-count.
  const backSegs = backward.segmentIndices.slice(1); // drop startSeg
  if (backSegs.length === 0) return forward;
  const backPts = backward.points.slice(2).reverse(); // drop the startSeg's two pts
  return {
    points: [...backPts, ...forward.points],
    segmentIndices: [...backSegs.reverse(), ...forward.segmentIndices],
    closed: false,
  };
}
