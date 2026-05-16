// Test OCR-based dimension extraction on the VA plan.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const id = await import("../src/lib/image-dimensions.ts");
const { ocrPageDimensions } = id;

const pdfPath =
  process.argv[2] ??
  path.resolve(__dirname, "../tests/fixtures/commercial-bench.pdf");
const pageNumber = parseInt(process.argv[3] ?? "1", 10);
const buf = readFileSync(pdfPath);

console.log(`OCR'ing ${path.basename(pdfPath)} page ${pageNumber}… (this can take 30-60s)`);
const result = await ocrPageDimensions(Buffer.from(buf), pageNumber, {
  dpi: 200,
});

console.log(`\nPage: ${result.pageWidthPt.toFixed(0)} × ${result.pageHeightPt.toFixed(0)} pt`);
console.log(`Render: ${result.stats.pixelsWidth} × ${result.stats.pixelsHeight} px`);
console.log(`OCR words recognized: ${result.stats.wordsRecognized}`);
console.log(`Dimension callouts extracted: ${result.stats.calloutsExtracted}`);
console.log(`OCR time: ${result.stats.ocrMs} ms`);
console.log(`Total: ${result.elapsedMs} ms`);

// Dump raw OCR words containing digits — see what Tesseract sees
console.log(`\nRaw OCR words containing digits (sample):`);
const id2 = await import("../src/lib/image-dimensions.ts");
// Re-run with a hacked path: just re-OCR and dump
// Actually, let's just call OCR again here briefly to inspect words
// (the result type doesn't surface raw words)
// Workaround: use the internal API
const tess = await import("tesseract.js");
const mupdf = await import("mupdf");
const doc = mupdf.Document.openDocument(new Uint8Array(buf), "application/pdf");
const page = doc.loadPage(pageNumber - 1);
const matrix = mupdf.Matrix.scale(200/72, 200/72);
const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceGray);
const png = pixmap.asPNG();
const worker = await tess.createWorker("eng");
const r = await worker.recognize(Buffer.from(png), {}, { blocks: true });
await worker.terminate();
const blocks = (r.data as { blocks?: { paragraphs?: { lines?: { words?: { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }[] }[] }[] }[] }).blocks ?? [];
const allWords: { text: string; x: number; y: number }[] = [];
for (const b of blocks)
  for (const p of b.paragraphs ?? [])
    for (const l of p.lines ?? [])
      for (const w of l.words ?? [])
        allWords.push({ text: w.text, x: (w.bbox.x0 + w.bbox.x1) / 2, y: (w.bbox.y0 + w.bbox.y1) / 2 });

const digitWords = allWords.filter((w) => /\d/.test(w.text));
console.log(`  ${digitWords.length} words contain digits`);
for (const w of digitWords.slice(0, 60)) {
  console.log(`    "${w.text}"`);
}

if (result.callouts.length > 0) {
  console.log(`\nSample callouts (first 40):`);
  for (const c of result.callouts.slice(0, 40)) {
    console.log(
      `  ${c.rawText.padEnd(14)} → ${c.lengthFt.toFixed(2)} ft  at (${c.x.toFixed(0)}, ${c.y.toFixed(0)})  conf=${c.confidence.toFixed(2)}`,
    );
  }
  // Length histogram
  console.log(`\nLength histogram:`);
  const hist = new Map<number, number>();
  for (const c of result.callouts) {
    const r = Math.round(c.lengthFt);
    hist.set(r, (hist.get(r) ?? 0) + 1);
  }
  for (const [ft, n] of [...hist.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${ft.toString().padStart(3)} ft: ${n.toString().padStart(3)} ${"#".repeat(Math.min(40, n))}`);
  }
}
