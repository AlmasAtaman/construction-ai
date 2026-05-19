// Step-1 fixture probe. Reports, for each PDF:
//   - page count, per-page point size
//   - number of vector path operations (lines + curves) per page
//   - number of text fragments per page
//   - a sample of room-label-shaped fragments per page
//   - presence of a "dimensions table" (W' x H' rows)
//   - whether the page has effectively no text/vectors (scanned/flattened)
//
// READ-ONLY. Does not write anything.

import { readFile } from "node:fs/promises";
import path from "node:path";

const FILES = [
  "tests/fixtures/benchmark-plan.pdf",
  "tests/fixtures/LOFT-Collection-OCT-16.pdf",
];

const root = process.cwd();

const DIM_RE =
  /^\s*\d{1,3}\s*['‘’′]\s*\d{0,2}\s*["“”″]?\s*[xX×]\s*\d{1,3}\s*['‘’′]\s*\d{0,2}\s*["“”″]?\s*$/;
const SIMPLE_DIM_RE = /^\s*\d{1,3}(?:\.\d+)?\s*[xX×]\s*\d{1,3}(?:\.\d+)?\s*$/;

async function probe(file) {
  const buf = await readFile(path.join(root, file));
  console.log(`\n=== ${file} ===  size=${buf.length} bytes`);

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  console.log(`pages: ${doc.numPages}`);

  // MuPDF for vector-path enumeration.
  const mupdf = await import("mupdf");
  const mdoc = mupdf.Document.openDocument(new Uint8Array(buf), "application/pdf");

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items;
    const fragments = items
      .filter((it) => it.str && it.str.trim().length > 0)
      .map((it) => ({
        text: it.str.trim(),
        x: it.transform[4],
        y: it.transform[5],
        w: it.width ?? 0,
        h: it.height ?? Math.abs(it.transform[3] ?? 10),
      }));

    // Count vector path ops via mupdf.
    let lineOps = 0;
    let curveOps = 0;
    let moveOps = 0;
    let closeOps = 0;
    try {
      const mpage = mdoc.loadPage(p - 1);
      const dev = new mupdf.Device({
        fillPath: (path) => {
          path.walk({
            moveTo: () => moveOps++,
            lineTo: () => lineOps++,
            curveTo: () => curveOps++,
            closePath: () => closeOps++,
          });
        },
        strokePath: (path) => {
          path.walk({
            moveTo: () => moveOps++,
            lineTo: () => lineOps++,
            curveTo: () => curveOps++,
            closePath: () => closeOps++,
          });
        },
      });
      mpage.run(dev, mupdf.Matrix.identity);
    } catch (e) {
      console.log(`  page ${p}: mupdf walk failed: ${e?.message ?? e}`);
    }

    // Detect dimension-table rows (count W'x H' patterns).
    let dimRows = 0;
    for (const f of fragments) {
      const stripped = f.text.replace(/\s+/g, "");
      if (DIM_RE.test(stripped) || SIMPLE_DIM_RE.test(stripped)) dimRows++;
    }

    // Pick a few short uppercase-looking labels for a quick sanity peek.
    const labelLooking = fragments
      .filter((f) => f.text.length >= 3 && f.text.length <= 28)
      .filter((f) => /[A-Za-z]{2,}/.test(f.text))
      .filter((f) => !/^\d/.test(f.text))
      .slice(0, 10)
      .map((f) => f.text);

    const noText = fragments.length === 0;
    const noVectors = moveOps + lineOps + curveOps + closeOps === 0;

    console.log(
      `  page ${p}: ${Math.round(viewport.width)}x${Math.round(viewport.height)}pt | text=${fragments.length} | move=${moveOps} line=${lineOps} curve=${curveOps} close=${closeOps} | dimRows=${dimRows}` +
      (noText && noVectors ? "  [LIKELY SCANNED]" : ""),
    );
    if (labelLooking.length > 0) {
      console.log(`    sample labels: ${labelLooking.map((s) => JSON.stringify(s)).join(", ")}`);
    }
  }
}

for (const f of FILES) {
  try {
    await probe(f);
  } catch (e) {
    console.error(`${f}: probe failed: ${e?.stack ?? e}`);
  }
}
