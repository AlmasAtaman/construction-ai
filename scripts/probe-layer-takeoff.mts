/** End-to-end test of the layer-takeoff modules on Beaver Tails p5. */
import fs from "fs";
import { scanSegmentsByLayer } from "../src/lib/extract/layer-scan";
import { classifyLayers } from "../src/lib/extract/layer-classify";
import { traceWallsFromLayers } from "../src/lib/extract/layer-takeoff";

const PT_PER_FOOT = 18;
const buf = fs.readFileSync("tests/fixtures/friend-commercial-plan.pdf");
const scan = await scanSegmentsByLayer(buf, 5);

console.log("layer names:", scan.layerNames.length);
console.log("segments:", scan.segments.length);
const classified = classifyLayers(Object.keys(scan.segmentsPerLayer));
for (const c of classified.filter((c) => c.role !== "other")) {
  console.log(`  ${c.role.padEnd(14)} ${c.name} (${scan.segmentsPerLayer[c.name]} segs)`);
}

const roleFor = Object.fromEntries(classified.map((c) => [c.name, c.role]));
const result = traceWallsFromLayers(scan, roleFor, { ptPerFoot: PT_PER_FOOT });
console.log("\nok:", result.ok);
console.log("view bounds:", result.viewBounds);
console.log("wall layers used:", result.wallLayersUsed);
let total = 0;
const perLayer = new Map<string, number>();
for (const pl of result.polylines) {
  const lf = pl.lengthPt / PT_PER_FOOT;
  total += lf;
  perLayer.set(pl.sourceLayer, (perLayer.get(pl.sourceLayer) ?? 0) + lf);
}
console.log("polylines:", result.polylines.length, " total:", total.toFixed(0), "lf");
for (const [l, lf] of perLayer) console.log(`  ${l}: ${lf.toFixed(0)} lf`);
