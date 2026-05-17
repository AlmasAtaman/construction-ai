import { readFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
const cr = await import("../src/lib/commercial-rooms.ts");

const pdfPath = "tests/fixtures/benchmark-commercial/hawksnest.pdf";
const gtPath = "tests/fixtures/benchmark-commercial/hawksnest-p5-ground-truth.json";

const buf = readFileSync(pdfPath);
const gt = JSON.parse(readFileSync(gtPath, "utf8")) as {
  rooms: Array<{ label: string; floorAreaSqft: number; basis: string; confidence: number }>;
};

const result = await cr.extractCommercialRoomCandidates(Buffer.from(buf), 5, { enableAiOcr: false });
console.log(`Scale: ${result.scaleAnchor?.label}, ${result.candidates.length} candidates after filter\n`);

// Show all candidates with sqft
const cands = result.candidates
  .filter((c) => c.areaSqft != null)
  .sort((a, b) => (b.areaSqft ?? 0) - (a.areaSqft ?? 0));
console.log(`Pipeline candidates with sqft (top 25):`);
for (const c of cands.slice(0, 25)) {
  console.log(`  ${c.areaSqft!.toFixed(0).padStart(6)} sqft  conf=${c.confidence.toFixed(2)}  src=${c.measurementSource.padEnd(15)}  "${c.label.slice(0, 50)}"`);
}

// Match each GT room to the best pipeline candidate (substring match on label)
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9 ]/g, "").trim();
}

console.log(`\nGT vs Pipeline (match by label substring):`);
console.log(`  GT room                        Truth sqft   Pipeline sqft   Err %`);
console.log(`  ${"─".repeat(70)}`);
let matched = 0;
let totalErrPct = 0;
let totalGtSqft = 0;
let totalPipelineSqft = 0;
for (const g of gt.rooms.sort((a, b) => b.floorAreaSqft - a.floorAreaSqft)) {
  const gNorm = normalize(g.label);
  const hits = cands.filter((c) => {
    const cNorm = normalize(c.label);
    return cNorm.includes(gNorm) || gNorm.includes(cNorm.split(" ")[0]);
  });
  if (hits.length === 0) {
    console.log(`  ${g.label.padEnd(33)} ${g.floorAreaSqft.toFixed(0).padStart(8)}    (not found)`);
    totalGtSqft += g.floorAreaSqft;
    continue;
  }
  // Take the largest match
  const best = hits.sort((a, b) => (b.areaSqft ?? 0) - (a.areaSqft ?? 0))[0];
  const errPct = ((best.areaSqft! - g.floorAreaSqft) / g.floorAreaSqft) * 100;
  console.log(
    `  ${g.label.padEnd(33)} ${g.floorAreaSqft.toFixed(0).padStart(8)}    ${best.areaSqft!.toFixed(0).padStart(8)}    ${errPct > 0 ? "+" : ""}${errPct.toFixed(0)}%`,
  );
  matched++;
  totalGtSqft += g.floorAreaSqft;
  totalPipelineSqft += best.areaSqft!;
  totalErrPct += Math.abs(errPct);
}

console.log(`\n${matched}/${gt.rooms.length} ground-truth rooms matched`);
if (matched > 0) {
  console.log(`Mean absolute error: ${(totalErrPct / matched).toFixed(1)}%`);
  console.log(`Total GT sqft: ${totalGtSqft.toFixed(0)}, Total matched pipeline sqft: ${totalPipelineSqft.toFixed(0)}`);
  console.log(`Total error: ${(((totalPipelineSqft - totalGtSqft) / totalGtSqft) * 100).toFixed(1)}%`);
}
