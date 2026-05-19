// Dump all text fragments on a LOFT page with positions.
import { readFile } from "node:fs/promises";
const PAGE = parseInt(process.argv[2] ?? "4", 10);
const buf = await readFile("tests/fixtures/LOFT-Collection-OCT-16.pdf");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const doc = await pdfjs.getDocument({
  data: new Uint8Array(buf), useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true,
}).promise;
const page = await doc.getPage(PAGE);
const vp = page.getViewport({ scale: 1 });
const tc = await page.getTextContent();
console.log(`page ${PAGE}: ${vp.width}x${vp.height}pt | ${tc.items.length} items`);
for (const it of tc.items) {
  const s = (it.str ?? "").trim();
  if (!s) continue;
  const w = it.width ?? 0;
  const h = it.height ?? Math.abs(it.transform?.[3] ?? 10);
  const x = it.transform[4];
  const y = it.transform[5];
  const yDown = (1 - (y + h/2) / vp.height).toFixed(2);
  console.log(`  ${JSON.stringify(s).padEnd(30)} pt=(${Math.round(x)},${Math.round(y)}) size=${Math.round(w)}x${Math.round(h)} yDownNorm=${yDown}`);
}
