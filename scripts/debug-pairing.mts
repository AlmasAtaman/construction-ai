// Dump text-fragment positions and polygon positions to see if they're
// in the same coordinate space.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const pdfPath = path.resolve(
  __dirname,
  "../tests/fixtures/commercial-bench.pdf",
);
const data = readFileSync(pdfPath);

const pdfDoc = await pdfjs.getDocument({
  data: new Uint8Array(data),
  isEvalSupported: false,
}).promise;
const page = await pdfDoc.getPage(1);
const viewport = page.getViewport({ scale: 1 });
console.log(`Viewport: ${viewport.width} × ${viewport.height}`);
console.log(`Rotation: ${page.rotate}`);

const tc = await page.getTextContent();
console.log(`\nFirst 30 text fragments (raw transform[4], transform[5]):`);
console.log(`  text (truncated)               x       y      font`);
console.log(`  ${"─".repeat(60)}`);
for (const item of (tc.items as { str: string; transform: number[]; height: number }[]).slice(0, 30)) {
  const text = item.str.trim().slice(0, 30);
  if (!text) continue;
  console.log(`  ${text.padEnd(30)}  ${item.transform[4].toFixed(0).padStart(6)}  ${item.transform[5].toFixed(0).padStart(6)}  ${(item.transform[3] || item.height).toFixed(1)}`);
}

// Hunt for ground-truth labels
console.log(`\nSearching for ground-truth labels:`);
const targets = ["CORRIDOR", "OXYGEN", "STORAGE", "LOBBY", "CE-3", "CE-5", "LINK", "169", "134A"];
const items = tc.items as { str: string; transform: number[] }[];
for (const t of targets) {
  const found = items.filter((it) => it.str.toUpperCase().includes(t.toUpperCase()));
  console.log(`  "${t}": ${found.length} match(es)`);
  for (const f of found.slice(0, 3)) {
    console.log(`    "${f.str}" at (${f.transform[4].toFixed(0)}, ${f.transform[5].toFixed(0)})`);
  }
}
