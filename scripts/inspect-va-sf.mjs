import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pdfPath = path.resolve(
  __dirname,
  "../tests/fixtures/commercial-bench.pdf",
);
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const data = readFileSync(pdfPath);
const doc = await pdfjs.getDocument({
  data: new Uint8Array(data),
  useWorkerFetch: false,
  isEvalSupported: false,
  useSystemFonts: true,
}).promise;
const page = await doc.getPage(1);
const content = await page.getTextContent();
// Find every fragment with "SF" in it
for (const item of content.items) {
  const s = item.str?.trim();
  if (!s) continue;
  if (/SF/i.test(s)) {
    console.log(JSON.stringify(s));
  }
}
