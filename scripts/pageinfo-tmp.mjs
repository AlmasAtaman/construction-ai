import { readFile } from "node:fs/promises";
import path from "node:path";

const files = [
  "/Users/almas/Documents/construction-ai/tests/fixtures/friend-commercial-plan.pdf",
  "/Users/almas/Documents/construction-ai/tests/fixtures/friend-commercial-walls-ANSWER.pdf",
];
process.chdir("/Users/almas/Documents/construction-ai");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
for (const f of files) {
  const buf = await readFile(f);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;
  console.log(`\n=== ${path.basename(f)} ===`);
  console.log(`pages: ${doc.numPages}`);
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const texts = tc.items.map(it => (it.str ?? "").trim()).filter(s => s.length > 0);
    const charsTotal = texts.join(" ").length;
    console.log(`  page ${p}: ${Math.round(vp.width)}×${Math.round(vp.height)} pt, ${texts.length} text items, ${charsTotal} chars`);
  }
}
