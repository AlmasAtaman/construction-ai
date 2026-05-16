// Test dimension-callout parsing on the VA commercial benchmark.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dc = await import("../src/lib/dimension-callouts.ts");
const { parseDimensionCallouts } = dc;
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const pdfPath = path.resolve(__dirname, "../tests/fixtures/commercial-bench.pdf");
const buf = readFileSync(pdfPath);

const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
const page = await doc.getPage(1);
const tc = await page.getTextContent();
const frags = (tc.items as { str: string; transform: number[] }[])
  .filter((it) => it.str.trim().length > 0)
  .map((it) => {
    // pdfjs transform = [scaleX, skewY, skewX, scaleY, tx, ty].
    // Rotation can be derived from atan2(skewY, scaleX).
    const rotation = Math.atan2(it.transform[1], it.transform[0]);
    return {
      text: it.str.trim(),
      x: it.transform[4],
      y: it.transform[5],
      rotation,
    };
  });

console.log(`${frags.length} text fragments`);

const callouts = parseDimensionCallouts(frags);
console.log(`Detected ${callouts.length} dimension callouts:`);

const grouped = new Map<"h" | "v" | "?", number>();
for (const c of callouts) {
  const k = c.orientation ?? "?";
  grouped.set(k, (grouped.get(k) ?? 0) + 1);
}
console.log(`  Horizontal: ${grouped.get("h") ?? 0}`);
console.log(`  Vertical:   ${grouped.get("v") ?? 0}`);
console.log(`  Unknown:    ${grouped.get("?") ?? 0}`);

console.log("\nSample callouts (first 30):");
for (const c of callouts.slice(0, 30)) {
  console.log(
    `  ${c.rawText.padEnd(12)} → ${c.lengthFt.toFixed(2)} ft  orient=${c.orientation ?? "?"}  conf=${c.confidence.toFixed(2)}  at (${c.x.toFixed(0)}, ${c.y.toFixed(0)})`,
  );
}

// Length histogram (rounded to nearest foot)
console.log("\nLength histogram (rounded):");
const hist = new Map<number, number>();
for (const c of callouts) {
  const r = Math.round(c.lengthFt);
  hist.set(r, (hist.get(r) ?? 0) + 1);
}
const sorted = [...hist.entries()].sort((a, b) => a[0] - b[0]);
for (const [ft, n] of sorted) {
  console.log(`  ${ft.toString().padStart(3)} ft: ${n.toString().padStart(3)} ${"#".repeat(Math.min(40, n))}`);
}
