/** Render layer-takeoff traces color-coded by source layer over p5. */
import fs from "fs";
import * as mupdf from "mupdf";
import { scanSegmentsByLayer } from "../src/lib/extract/layer-scan";
import { classifyLayers } from "../src/lib/extract/layer-classify";
import { traceWallsFromLayers } from "../src/lib/extract/layer-takeoff";

const PT = 18;
const buf = fs.readFileSync("tests/fixtures/friend-commercial-plan.pdf");
const scan = await scanSegmentsByLayer(buf, 5);
const roles = Object.fromEntries(classifyLayers(Object.keys(scan.segmentsPerLayer)).map(c=>[c.name,c.role]));
const res = traceWallsFromLayers(scan, roles, { ptPerFoot: PT });

const doc = (mupdf as any).Document.openDocument(new Uint8Array(buf), "application/pdf");
const page = doc.loadPage(4);
const S = 1.2;
const pix = page.toPixmap((mupdf as any).Matrix.scale(S,S), (mupdf as any).ColorSpace.DeviceRGB, false, true);
fs.writeFileSync("/tmp/layers/base.png", pix.asPNG());
fs.writeFileSync("/tmp/layers/polys.json", JSON.stringify({
  S,
  view: res.viewBounds,
  polys: res.polylines.map(p=>({ layer: p.sourceLayer, points: p.points })),
}));
let total = 0;
for (const p of res.polylines) total += p.lengthPt / PT;
console.log("dumped", res.polylines.length, "polylines,", total.toFixed(0), "lf");
