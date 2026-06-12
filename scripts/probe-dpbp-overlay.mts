import fs from "fs";
import * as mupdf from "mupdf";
import { scanSegmentsByLayer } from "../src/lib/extract/layer-scan";
import { classifyLayers } from "../src/lib/extract/layer-classify";
import { traceWallsFromLayers } from "../src/lib/extract/layer-takeoff";
import { extractTextLayer } from "../src/lib/pdf-render";
import { parseDimensionCallouts } from "../src/lib/dimension-callouts";

const buf = fs.readFileSync("tests/fixtures/DP-BP-new-home-sample-drawings.pdf");
const scan = await scanSegmentsByLayer(buf, 10);
const roles = Object.fromEntries(classifyLayers(Object.keys(scan.segmentsPerLayer)).map((c) => [c.name, c.role]));
const { textFragments } = await extractTextLayer(buf, 10);
const dims = parseDimensionCallouts(
  textFragments.map((f) => ({ text: f.text, x: f.xNorm * scan.pageWidthPt, y: f.yNorm * scan.pageHeightPt })),
).map((c) => ({ x: c.x, y: c.y }));
const res = traceWallsFromLayers(scan, roles, { ptPerFoot: 13.5, dimensionTextPt: dims });
const doc = (mupdf as any).Document.openDocument(new Uint8Array(buf), "application/pdf");
const page = doc.loadPage(9);
const S = 1.6;
const pix = page.toPixmap((mupdf as any).Matrix.scale(S, S), (mupdf as any).ColorSpace.DeviceRGB, false, true);
fs.writeFileSync("/tmp/layers/dpbp-base.png", pix.asPNG());
fs.writeFileSync("/tmp/layers/dpbp-polys.json", JSON.stringify({ S, polys: res.polylines.map((p) => p.points), dims }));
console.log("polylines:", res.polylines.length);
