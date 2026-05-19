import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractPage } from "../src/lib/extract/page-extract.js";

const buf = await readFile(path.join(process.cwd(), "tests/fixtures/LOFT-Collection-OCT-16.pdf"));
const r = await extractPage(buf, 4, { userScale: { ptPerFoot: 9, label: "1/8\" = 1'-0\"" } });
console.log(`rooms (${r.rooms.length}):`);
for (const room of r.rooms) {
  console.log(`  "${room.label}" derivation=${room.derivation}  bbox=${JSON.stringify(room.bboxPt)} W=${room.widthFt} H=${room.heightFt} A=${room.areaSqft}`);
}
