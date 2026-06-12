/** Verify dimension rejection: DP-BP p10 (polluted layer) + Beaver p5 (clean). */
import fs from "fs";
import { scanSegmentsByLayer } from "../src/lib/extract/layer-scan";
import { classifyLayers } from "../src/lib/extract/layer-classify";
import { traceWallsFromLayers } from "../src/lib/extract/layer-takeoff";
import { extractTextLayer } from "../src/lib/pdf-render";
import { parseDimensionCallouts } from "../src/lib/dimension-callouts";

async function run(pdfPath: string, pageNum: number, ptPerFoot: number) {
  const buf = fs.readFileSync(pdfPath);
  const scan = await scanSegmentsByLayer(buf, pageNum);
  const roles = Object.fromEntries(
    classifyLayers(Object.keys(scan.segmentsPerLayer)).map((c) => [c.name, c.role]),
  );
  const { textFragments } = await extractTextLayer(buf, pageNum);
  const dims = parseDimensionCallouts(
    textFragments.map((f) => ({ text: f.text, x: f.xNorm * scan.pageWidthPt, y: f.yNorm * scan.pageHeightPt })),
  ).map((c) => ({ x: c.x, y: c.y }));
  for (const [label, dimOpt] of [["without rejection", undefined], ["with rejection", dims]] as const) {
    const res = traceWallsFromLayers(scan, roles, { ptPerFoot, dimensionTextPt: dimOpt as any });
    let lf = 0;
    for (const p of res.polylines) lf += p.lengthPt / ptPerFoot;
    console.log(`  ${label}: ${res.polylines.length} polylines / ${lf.toFixed(0)} lf  (callouts: ${dims.length})`);
  }
}
console.log("DP-BP p10 (3/16\"=1' → 13.5 pt/ft):");
await run("tests/fixtures/DP-BP-new-home-sample-drawings.pdf", 10, 13.5);
console.log("Beaver Tails p5 (1/4\"=1' → 18 pt/ft):");
await run("tests/fixtures/friend-commercial-plan.pdf", 5, 18);
