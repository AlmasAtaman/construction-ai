import { readFile } from "node:fs/promises";
import path from "node:path";

const FILES = [
  "tests/fixtures/benchmark-plan.pdf",
  "tests/fixtures/LOFT-Collection-OCT-16.pdf",
  "tests/fixtures/DP-BP-new-home-sample-drawings.pdf",
  "tests/fixtures/commercial-bench.pdf",
];

const root = process.cwd();
const SCALE_HINT = /scale|1\s*\/\s*\d|1\s*:\s*\d{2,4}|=\s*\d+\s*[''’]|\d+'-\d+"|\d+'/i;

for (const f of FILES) {
  console.log(`\n=== ${f} ===`);
  const buf = await readFile(path.join(root, f));
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf), useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true,
  }).promise;
  console.log(`pages: ${doc.numPages}`);
  for (let p = 1; p <= Math.min(doc.numPages, 8); p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const hits = [];
    for (const it of tc.items) {
      const s = (it.str ?? "").trim();
      if (!s) continue;
      if (SCALE_HINT.test(s)) hits.push(s);
    }
    if (hits.length > 0) {
      console.log(`  page ${p}: ${hits.slice(0, 20).map((s) => JSON.stringify(s)).join(", ")}`);
    } else {
      console.log(`  page ${p}: (no scale-shaped text)`);
    }
  }
}
