import fs from "fs";
import { scanSegmentsByLayer } from "../src/lib/extract/layer-scan";
import { classifyLayers } from "../src/lib/extract/layer-classify";
import { traceWallsFromLayers } from "../src/lib/extract/layer-takeoff";
import { extractTextLayer } from "../src/lib/pdf-render";
import { parseDimensionCallouts } from "../src/lib/dimension-callouts";

const buf = fs.readFileSync("tests/fixtures/DP-BP-new-home-sample-drawings.pdf");
const scan = await scanSegmentsByLayer(buf, 10);
const roles = Object.fromEntries(classifyLayers(Object.keys(scan.segmentsPerLayer)).map((c) => [c.name, c.role]));
const { textFragments } = await extractTextLayer(buf, 10);
const callouts = parseDimensionCallouts(
  textFragments.map((f) => ({ text: f.text, x: f.xNorm * scan.pageWidthPt, y: f.yNorm * scan.pageHeightPt })),
);
console.log("parsed callouts:", callouts.map(c=>c.rawText).join(" | "));
const res = traceWallsFromLayers(scan, roles, { ptPerFoot: 13.5, dimensionTextPt: callouts.map(c=>({x:c.x,y:c.y})) });
function dist(px:number,py:number,a:any,b:any){const dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;let t=l2?((px-a.x)*dx+(py-a.y)*dy)/l2:0;t=Math.max(0,Math.min(1,t));return Math.hypot(px-(a.x+t*dx),py-(a.y+t*dy));}
for (const pl of res.polylines.sort((a,b)=>b.lengthPt-a.lengthPt).slice(0,12)) {
  let best = {d: 1e9, text: ""};
  for (const c of callouts) for (let i=1;i<pl.points.length;i++){
    const d = dist(c.x,c.y,pl.points[i-1],pl.points[i]);
    if (d < best.d) best = {d, text: c.rawText};
  }
  const p0 = pl.points[0];
  console.log(`lf=${(pl.lengthPt/13.5).toFixed(0)} start=(${p0.x.toFixed(0)},${p0.y.toFixed(0)}) nearestCallout="${best.text}" d=${best.d.toFixed(1)}pt`);
}
