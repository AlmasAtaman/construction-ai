// Smoke test for the commercial-rooms facade.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cr = await import("../src/lib/commercial-rooms.ts");
const { extractCommercialRoomCandidates } = cr;

const pdfPath =
  process.argv[2] ??
  path.resolve(__dirname, "../tests/fixtures/commercial-bench.pdf");
const pageNumber = parseInt(process.argv[3] ?? "1", 10);
const data = readFileSync(pdfPath);

console.log(`Extracting room candidates from ${path.basename(pdfPath)} page ${pageNumber} (AI-OCR enabled)…`);
const result = await extractCommercialRoomCandidates(Buffer.from(data), pageNumber, {
  enableAiOcr: true,
  aiOcrCols: 4,
  aiOcrRows: 3,
});
console.log(`\nPage: ${result.pageWidthPt.toFixed(0)} × ${result.pageHeightPt.toFixed(0)} pt`);
console.log(`Vector walls: ${result.vectorWallCount.toLocaleString()}`);
console.log(`Image walls: ${result.imageWallCount.toLocaleString()}`);
console.log(`Door candidates: ${result.doorCandidateCount.toLocaleString()}`);
console.log(`Planar-graph faces: ${result.faceCount.toLocaleString()}`);
console.log(`Scale anchor: ${result.scaleAnchor ? `${result.scaleAnchor.label} (${result.scaleAnchor.ptPerFoot.toFixed(1)} pt/ft)` : "(not detected)"}`);
console.log(`Dimension callouts: ${result.dimensionCallouts.length}`);
console.log(`Total time: ${result.elapsedMs} ms`);
console.log(`Room candidates: ${result.candidates.length}\n`);

console.log("Top 25 candidates by area:");
const sorted = [...result.candidates].sort((a, b) => b.areaPt - a.areaPt);
for (const c of sorted.slice(0, 25)) {
  const sqft = c.areaSqft != null ? `${c.areaSqft.toFixed(0)} sqft` : "—";
  console.log(
    `  conf=${c.confidence.toFixed(2)}  pt²=${Math.round(c.areaPt).toString().padStart(7)}  ${sqft.padStart(10)}  src=${c.measurementSource.padEnd(15)}  "${c.label.slice(0, 50)}"`,
  );
}

console.log("\nGT cross-check against commercial-bench-ground-truth.json:");
const truth = JSON.parse(
  readFileSync(
    path.resolve(__dirname, "../tests/fixtures/commercial-bench-ground-truth.json"),
    "utf8",
  ),
) as {
  pages: { pageNumber: number; rooms: { label: string; matchKeys: string[]; trueFloorAreaSqft: number }[] }[];
};
const gt = truth.pages.find((p) => p.pageNumber === pageNumber)!.rooms;

let matched = 0;
for (const g of gt) {
  const keys = g.matchKeys.map((k) => k.toLowerCase());
  let hit: (typeof result.candidates)[number] | null = null;
  // Smallest-area candidate whose label contains any match key
  for (const c of result.candidates) {
    const t = c.label.toLowerCase();
    if (!keys.some((k) => t.includes(k))) continue;
    if (!hit || c.areaPt < hit.areaPt) hit = c;
  }
  if (hit) {
    matched++;
    const sqft = hit.areaSqft != null ? `${hit.areaSqft.toFixed(0)} sqft` : "(no sqft)";
    const errStr = hit.areaSqft != null
      ? `err ${((hit.areaSqft / g.trueFloorAreaSqft - 1) * 100).toFixed(0)}%`
      : "";
    console.log(
      `  ✓ ${g.label.padEnd(35)} conf=${hit.confidence.toFixed(2)} ${sqft.padStart(10)} src=${hit.measurementSource.padEnd(15)} truth=${g.trueFloorAreaSqft} ${errStr}`,
    );
  } else {
    console.log(`  ✗ ${g.label.padEnd(35)} — no candidate`);
  }
}
console.log(`\n${matched}/${gt.length} GT rooms found`);
