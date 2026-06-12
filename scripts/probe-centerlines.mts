import fs from "fs";
import { scanSegmentsByLayer } from "../src/lib/extract/layer-scan";
import { classifyLayers } from "../src/lib/extract/layer-classify";
import { detectWallCenterlines } from "../src/lib/extract/wall-pairs";
import { buildWallGraph } from "../src/lib/extract/wall-graph";
import { autoTraceWalls } from "../src/lib/extract/wall-autotrace";

const PT = 18;
const buf = fs.readFileSync("tests/fixtures/friend-commercial-plan.pdf");
const scan = await scanSegmentsByLayer(buf, 5);
const roles = Object.fromEntries(classifyLayers(Object.keys(scan.segmentsPerLayer)).map(c=>[c.name,c.role]));
// construction view only (from previous probe): x 253-1253, y 185-585
const inView = (s:any)=> Math.min(s.x1,s.x2)>=233 && Math.max(s.x1,s.x2)<=1273 && Math.min(s.y1,s.y2)>=165 && Math.max(s.y1,s.y2)<=605;
const lf = (ss:any[]) => ss.reduce((t,s)=>t+Math.hypot(s.x2-s.x1,s.y2-s.y1),0)/PT;
for (const layer of Object.keys(scan.segmentsPerLayer)) {
  const role = roles[layer];
  if (role !== "wall-new" && role !== "wall-existing") continue;
  const segs = scan.segments.filter(s=>s.layer===layer && inView(s));
  if (!segs.length) continue;
  const center = detectWallCenterlines(segs);
  const graph = buildWallGraph(center as any);
  const polys = autoTraceWalls(graph, { minPolylineLengthPt: PT });
  let traced = 0; for (const p of polys) for (let i=1;i<p.points.length;i++) traced += Math.hypot(p.points[i].x-p.points[i-1].x, p.points[i].y-p.points[i-1].y);
  console.log(`${layer}: faces ${segs.length} segs / ${lf(segs).toFixed(0)} lf -> centerlines ${center.length} / ${lf(center).toFixed(0)} lf -> traced ${(traced/PT).toFixed(0)} lf (${polys.length} runs)`);
}
