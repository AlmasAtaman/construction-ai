/**
 * Reconciliation vs the contractor's PlanSwift takeoff (decoded from the
 * answer-PDF photos). We don't have his file; these targets are read off
 * the screenshots. Goal: quantify our gap and pin down the assumptions.
 *
 * Decoded answer (friend-commercial-walls-ANSWER.pdf):
 *   Wall Area  (green)  840.0  sq ft   → Overstock room walls
 *   "1"        (yellow) 1540.9 sq ft   → Sales + Service walls
 *   Area       (teal)   549.3  sq ft   → ceiling/floor (RCP sheet)
 *   Paint wall total            2380.9 sq ft
 */
import fs from "fs";
import { scanSegmentsByLayer } from "../src/lib/extract/layer-scan";
import { classifyLayers } from "../src/lib/extract/layer-classify";
import { traceWallsFromLayers } from "../src/lib/extract/layer-takeoff";
import { extractTextLayer } from "../src/lib/pdf-render";
import { parseDimensionCallouts } from "../src/lib/dimension-callouts";

const PT = 18;
const FRIEND_HEIGHT_FT = 9; // 840/9 = 93.3 lf overstock; evidence says flat 9
const FRIEND = { overstockSqft: 840.0, salesSqft: 1540.9, totalSqft: 2380.9 };

const buf = fs.readFileSync("tests/fixtures/friend-commercial-plan.pdf");
const scan = await scanSegmentsByLayer(buf, 5);
const roles = Object.fromEntries(
  classifyLayers(Object.keys(scan.segmentsPerLayer)).map((c) => [c.name, c.role]),
);
const { textFragments } = await extractTextLayer(buf, 5);
const dims = parseDimensionCallouts(
  textFragments.map((f) => ({ text: f.text, x: f.xNorm * scan.pageWidthPt, y: f.yNorm * scan.pageHeightPt })),
).map((c) => ({ x: c.x, y: c.y }));
const res = traceWallsFromLayers(scan, roles, { ptPerFoot: PT, dimensionTextPt: dims });

const perLayer = new Map<string, number>();
let totalLf = 0;
for (const p of res.polylines) {
  const lf = p.lengthPt / PT;
  totalLf += lf;
  perLayer.set(p.sourceLayer, (perLayer.get(p.sourceLayer) ?? 0) + lf);
}

console.log("=== Our layer takeoff (Beaver Tails p5) ===");
for (const [l, lf] of [...perLayer].sort((a, b) => b[1] - a[1]))
  console.log(`  ${l.split("|").pop()}: ${lf.toFixed(1)} lf`);
console.log(`  TOTAL: ${totalLf.toFixed(1)} lf`);
console.log(`  at flat ${FRIEND_HEIGHT_FT}ft = ${(totalLf * FRIEND_HEIGHT_FT).toFixed(0)} sq ft`);

console.log("\n=== Friend's decoded takeoff ===");
console.log(`  Overstock: ${FRIEND.overstockSqft} sqft = ${(FRIEND.overstockSqft / FRIEND_HEIGHT_FT).toFixed(1)} lf`);
console.log(`  Sales+Svc: ${FRIEND.salesSqft} sqft = ${(FRIEND.salesSqft / FRIEND_HEIGHT_FT).toFixed(1)} lf`);
console.log(`  PAINT TOTAL: ${FRIEND.totalSqft} sqft = ${(FRIEND.totalSqft / FRIEND_HEIGHT_FT).toFixed(1)} lf`);

const friendLf = FRIEND.totalSqft / FRIEND_HEIGHT_FT;
console.log("\n=== Gap ===");
console.log(`  Our ${totalLf.toFixed(0)} lf vs friend ${friendLf.toFixed(0)} lf  → ratio ${(totalLf / friendLf).toFixed(2)}×`);
