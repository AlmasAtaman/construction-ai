import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractPage } from "../src/lib/extract/page-extract.js";

const buf = await readFile(path.join(process.cwd(), "tests/fixtures/DP-BP-new-home-sample-drawings.pdf"));
const r = await extractPage(buf, 10);
console.log(`status: ${r.status}, strategy: ${r.strategy}`);
console.log(`scale: ${JSON.stringify(r.establishedScale)}`);
console.log(`page: ${r.pageWidthPt} x ${r.pageHeightPt} pt`);
console.log(`diagnostics: ${JSON.stringify(r.diagnostics)}`);
console.log(`\nrooms (${r.rooms.length}):`);
for (const room of r.rooms) {
  console.log(`  label="${room.label}"`);
  console.log(`    bboxPt: ${JSON.stringify(room.bboxPt)}`);
  console.log(`    widthFt=${room.widthFt}, heightFt=${room.heightFt}, areaSqft=${room.areaSqft}, perimeterFt=${room.perimeterFt}`);
  console.log(`    derivation: ${room.derivation}`);
  console.log(`    polygonNorm verts: ${room.polygonNorm.length}`);
}
