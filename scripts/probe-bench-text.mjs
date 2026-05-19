// Dump every text fragment on every page with position + bbox.
import { readFile } from "node:fs/promises";

const FILE = "tests/fixtures/benchmark-plan.pdf";
const buf = await readFile(FILE);
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const doc = await pdfjs.getDocument({
  data: new Uint8Array(buf),
  useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true,
}).promise;

for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  console.log(`\n=== page ${p}: ${vp.width}x${vp.height}pt, ${tc.items.length} text items ===`);
  for (const it of tc.items) {
    const s = (it.str ?? "").trim();
    if (!s) continue;
    const w = it.width ?? 0;
    const h = it.height ?? Math.abs(it.transform?.[3] ?? 10);
    const x = it.transform[4];
    const y = it.transform[5];
    const xn = (x / vp.width).toFixed(2);
    const yn = (1 - (y + h/2) / vp.height).toFixed(2);
    console.log(`  ${JSON.stringify(s).padEnd(40)} pos=(${Math.round(x)},${Math.round(y)})pt size=${Math.round(w)}x${Math.round(h)} norm=(${xn},${yn})`);
  }
}
