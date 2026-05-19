// Try extractCommercialRoomCandidates directly on a few LOFT pages.
import { readFile } from "node:fs/promises";

const { extractCommercialRoomCandidates } = await import(
  "../src/lib/commercial-rooms.ts"
);
const buf = await readFile("tests/fixtures/LOFT-Collection-OCT-16.pdf");

for (const p of [3, 4, 5, 7, 8, 9, 13, 30, 32, 33]) {
  try {
    const r = await extractCommercialRoomCandidates(buf, p, { skipImageWalls: true });
    console.log(`\n=== LOFT p${p} ===`);
    console.log(`  page ${r.pageWidthPt}x${r.pageHeightPt} | walls=${r.vectorWallCount} faces=${r.faceCount} candidates=${r.candidates.length}`);
    for (const c of r.candidates.slice(0, 30)) {
      console.log(`   · "${c.label}" src=${c.source} conf=${c.confidence.toFixed(2)} bbox=(${Math.round(c.bbox.x)},${Math.round(c.bbox.y)}) ${Math.round(c.bbox.width)}x${Math.round(c.bbox.height)}pt`);
    }
  } catch (e) {
    console.error(`p${p} failed:`, e?.message ?? e);
  }
}
