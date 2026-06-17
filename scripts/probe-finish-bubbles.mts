/** Extract finish-code bubbles on p5 with positions; overlay on walls. */
import fs from "fs";
import { extractTextLayer } from "../src/lib/pdf-render";
import { scanSegmentsByLayer } from "../src/lib/extract/layer-scan";
import { classifyLayers } from "../src/lib/extract/layer-classify";
import { traceWallsFromLayers } from "../src/lib/extract/layer-takeoff";
import { parseDimensionCallouts } from "../src/lib/dimension-callouts";

const PT = 18;
const buf = fs.readFileSync("tests/fixtures/friend-commercial-plan.pdf");
const { textFragments, pageWidthPt, pageHeightPt } = await extractTextLayer(buf, 5);

// Finish-code bubbles: P-n (paint), CT-n (wall tile), FRP-n, WD/SL (wood)
const CODE = /^(P-?\d|CT-?\d|FRP-?\d?|WD-?\d?|SL-?\d?)$/i;
const bubbles = textFragments
  .map((f) => ({ t: f.text.trim().replace(/\s+/g, ""), x: f.xNorm * pageWidthPt, y: f.yNorm * pageHeightPt }))
  .filter((f) => CODE.test(f.t));

const finishOf = (code: string): string => {
  const c = code.toUpperCase();
  if (c.startsWith("P")) return "paint";
  if (c.startsWith("CT")) return "tile";
  if (c.startsWith("FRP")) return "frp";
  if (c.startsWith("WD") || c.startsWith("SL")) return "wood";
  return "other";
};

console.log(`p5: ${bubbles.length} finish bubbles`);
const byFinish = new Map<string, number>();
for (const b of bubbles) byFinish.set(finishOf(b.t), (byFinish.get(finishOf(b.t)) ?? 0) + 1);
console.log("by finish:", JSON.stringify(Object.fromEntries(byFinish)));
console.log("page dims (text):", pageWidthPt.toFixed(0), pageHeightPt.toFixed(0));

// Trace walls (construction view) to compare coordinate space
const scan = await scanSegmentsByLayer(buf, 5);
console.log("page dims (scan):", scan.pageWidthPt.toFixed(0), scan.pageHeightPt.toFixed(0));
const roles = Object.fromEntries(classifyLayers(Object.keys(scan.segmentsPerLayer)).map((c) => [c.name, c.role]));
const dims = parseDimensionCallouts(textFragments.map((f) => ({ text: f.text, x: f.xNorm * pageWidthPt, y: f.yNorm * pageHeightPt }))).map((c) => ({ x: c.x, y: c.y }));
const res = traceWallsFromLayers(scan, roles, { ptPerFoot: PT, dimensionTextPt: dims });
const vb = res.viewBounds!;
console.log("wall view bbox pt:", JSON.stringify({x0:vb.x0|0,y0:vb.y0|0,x1:vb.x1|0,y1:vb.y1|0}));

// How many bubbles fall inside the wall view region?
const inView = bubbles.filter((b) => b.x >= vb.x0-20 && b.x <= vb.x1+20 && b.y >= vb.y0-20 && b.y <= vb.y1+20);
console.log(`bubbles inside wall view: ${inView.length}`);
for (const b of inView.sort((a,c)=>a.x-c.x)) console.log(`  ${b.t.padEnd(5)} (${finishOf(b.t)}) at x=${b.x|0} y=${b.y|0}`);

fs.writeFileSync("/tmp/layers/finish-bubbles.json", JSON.stringify({
  pageWidthPt, pageHeightPt,
  bubbles: bubbles.map((b) => ({ ...b, finish: finishOf(b.t) })),
  walls: res.polylines.map((p) => ({ pts: p.points, layer: p.sourceLayer })),
  view: vb,
}));
