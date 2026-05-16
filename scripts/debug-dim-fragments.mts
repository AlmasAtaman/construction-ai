// Dump every text fragment containing an apostrophe or double-quote —
// likely dimension callouts that didn't match the parser regex.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

for (const f of ["tests/fixtures/commercial-bench.pdf", "tests/fixtures/benchmark-plan.pdf"]) {
  const buf = readFileSync(path.resolve(__dirname, "..", f));
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  const page = await doc.getPage(1);
  const tc = await page.getTextContent();
  const frags = (tc.items as { str: string; transform: number[] }[])
    .filter((it) => it.str.trim().length > 0)
    .map((it) => ({ text: it.str.trim(), x: it.transform[4], y: it.transform[5] }));

  console.log(`\n── ${path.basename(f)} (${frags.length} frags) ──`);
  const dimLike = frags.filter((g) => /['"’”′″\d]/.test(g.text) && /\d/.test(g.text));
  console.log(`  ${dimLike.length} fragments contain digits + quotes/apostrophes`);

  // Look for things that LOOK like dimensions
  const interesting = frags.filter((g) => {
    const t = g.text;
    // Has digit followed by ' or "
    return /\d['"’”′″]/.test(t) || /\d-\d/.test(t);
  });
  console.log(`  ${interesting.length} look dimension-like`);
  console.log(`  Sample (first 40):`);
  for (const g of interesting.slice(0, 40)) {
    console.log(`    "${g.text}"`);
  }
}
