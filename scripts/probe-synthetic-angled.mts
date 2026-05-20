/**
 * Day 5 — synthetic proof that the diagonal pipeline works end to end
 * on a TRUE angled wall, since none of the available fixtures contain
 * one (their "diagonals" are casework, millwork, stairs, hatching).
 *
 * Footprint: a rectangle with the top-right corner clipped at 45° —
 * exactly the "angled entrance" shape the brief described. We feed the
 * raw segments through buildWallGraph + autoTraceWalls and assert:
 *   (a) the diagonal segment survives cleanup (capture)
 *   (b) the graph has vertices at both ends of the diagonal (T-split /
 *       joint vertices at the angled corners)
 *   (c) the auto-trace walks a polyline straight through the angled
 *       joint (continuity across a non-90° vertex)
 */

import {
  buildWallGraph,
  wallGraphSegments,
  type RawSegment,
} from "../src/lib/extract/wall-graph.js";
import { autoTraceWalls } from "../src/lib/extract/wall-autotrace.js";

// Closed footprint, y-up pt. Top-right corner clipped (300,150)→(250,200).
const raw: RawSegment[] = [
  { x1: 0, y1: 0, x2: 300, y2: 0 }, // bottom
  { x1: 300, y1: 0, x2: 300, y2: 150 }, // right (partial)
  { x1: 300, y1: 150, x2: 250, y2: 200 }, // ANGLED entrance (~45°, 70.7pt)
  { x1: 250, y1: 200, x2: 0, y2: 200 }, // top
  { x1: 0, y1: 200, x2: 0, y2: 0 }, // left
];

const graph = buildWallGraph(raw);
const cleaned = wallGraphSegments(graph);

function approxEq(a: number, b: number, tol = 2): boolean {
  return Math.abs(a - b) <= tol;
}
function hasVertex(x: number, y: number): boolean {
  return graph.vertices.some((v) => approxEq(v.x, x) && approxEq(v.y, y));
}
function angleOf(s: RawSegment): number {
  const a = (Math.atan2(s.y2 - s.y1, s.x2 - s.x1) * 180) / Math.PI;
  return ((a % 180) + 180) % 180;
}

// (a) Capture — a ~45° edge of ~70pt should be present.
const diagonals = cleaned.filter((s) => {
  const a = angleOf(s);
  const off = Math.min(Math.abs(a - 45), Math.abs(a - 135));
  const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
  return off < 5 && len > 40;
});
console.log(`(a) capture: ${diagonals.length} diagonal edge(s) survived cleanup`);
for (const d of diagonals) {
  console.log(
    `    (${d.x1},${d.y1})→(${d.x2},${d.y2}) len=${Math.hypot(d.x2 - d.x1, d.y2 - d.y1).toFixed(1)} angle=${angleOf(d).toFixed(1)}°`,
  );
}

// (b) Joint vertices at the angled corners.
const v1 = hasVertex(300, 150);
const v2 = hasVertex(250, 200);
console.log(`(b) joint vertices: (300,150)=${v1}  (250,200)=${v2}`);

// (c) Auto-trace walks through the angled joint. Find a polyline whose
// consecutive vertices include (300,150)→(250,200) (or reverse).
const polylines = autoTraceWalls(graph);
let walked = false;
for (const pl of polylines) {
  for (let i = 0; i < pl.points.length - 1; i++) {
    const a = pl.points[i];
    const b = pl.points[i + 1];
    const fwd =
      approxEq(a.x, 300) && approxEq(a.y, 150) && approxEq(b.x, 250) && approxEq(b.y, 200);
    const rev =
      approxEq(a.x, 250) && approxEq(a.y, 200) && approxEq(b.x, 300) && approxEq(b.y, 150);
    if (fwd || rev) walked = true;
  }
}
console.log(`(c) auto-trace walks the angled joint: ${walked}`);
console.log(
  `    ${polylines.length} polyline(s); longest has ${Math.max(...polylines.map((p) => p.points.length))} vertices`,
);

const pass = diagonals.length >= 1 && v1 && v2 && walked;
console.log(`\nRESULT: ${pass ? "PASS — diagonal pipeline works end to end" : "FAIL"}`);
process.exit(pass ? 0 : 1);
