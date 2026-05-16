// Test scale anchor extraction on the VA commercial benchmark + residential.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sa = await import("../src/lib/scale-anchor.ts");
const { detectScaleAnchor } = sa;
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const tests = [
  {
    name: "VA commercial",
    path: "tests/fixtures/commercial-bench.pdf",
    page: 1,
  },
  {
    name: "Residential (ListSimple)",
    path: "tests/fixtures/benchmark-plan.pdf",
    page: 1,
  },
];

for (const t of tests) {
  console.log(`\n── ${t.name} ──`);
  const buf = readFileSync(path.resolve(__dirname, "..", t.path));
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  const page = await doc.getPage(t.page);
  const tc = await page.getTextContent();
  const frags = (tc.items as { str: string; transform: number[] }[])
    .filter((it) => it.str.trim().length > 0)
    .map((it) => ({ text: it.str.trim(), x: it.transform[4], y: it.transform[5] }));
  console.log(`  ${frags.length} text fragments`);
  const anchor = detectScaleAnchor(frags);
  if (anchor) {
    console.log(`  ✓ Scale: ${anchor.label}`);
    console.log(`    ${anchor.ptPerFoot.toFixed(2)} pt/ft, ${anchor.ptPerSqFt.toFixed(2)} pt²/sqft`);
    console.log(`    conf=${anchor.confidence.toFixed(2)}, raw="${anchor.rawText}"`);
    if (anchor.x != null && anchor.y != null) {
      console.log(`    at (${anchor.x.toFixed(0)}, ${anchor.y.toFixed(0)})`);
    }
  } else {
    console.log(`  ✗ No scale detected`);
    // Show fragments containing "SCALE" for debugging
    const scaleFrags = frags.filter((f) => /scale/i.test(f.text)).slice(0, 5);
    if (scaleFrags.length > 0) {
      console.log(`    Fragments mentioning "SCALE":`);
      for (const f of scaleFrags) console.log(`      "${f.text}"`);
    }
  }
}
