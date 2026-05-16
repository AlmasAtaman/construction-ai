// Inspect the raw text fragments + parsed room labels + dimension table
// for a given PDF page. Used to debug per-room accuracy.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_NUM = parseInt(process.argv[3] ?? "1", 10);
const PDF_PATH = process.argv[2] ?? path.join(
  __dirname,
  "../tests/fixtures/benchmark-plan.pdf",
);

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const data = readFileSync(PDF_PATH);
const doc = await pdfjs.getDocument({
  data: new Uint8Array(data),
  useWorkerFetch: false,
  isEvalSupported: false,
  useSystemFonts: true,
}).promise;
const page = await doc.getPage(PAGE_NUM);
const viewport = page.getViewport({ scale: 1 });
const content = await page.getTextContent();

console.log(`Page ${PAGE_NUM}: ${viewport.width.toFixed(0)} × ${viewport.height.toFixed(0)} pt`);
console.log(`Found ${content.items.length} text fragments\n`);

for (const item of content.items) {
  if (!item.str?.trim()) continue;
  const tx = item.transform[4];
  const ty = item.transform[5];
  const h = item.height ?? 10;
  const cx = tx + (item.width ?? 0) / 2;
  const cy = viewport.height - (ty + h / 2);
  const xn = (cx / viewport.width).toFixed(3);
  const yn = (cy / viewport.height).toFixed(3);
  console.log(`(${xn}, ${yn})  "${item.str}"`);
}
