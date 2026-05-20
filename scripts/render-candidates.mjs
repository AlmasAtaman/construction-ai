import { readFile, writeFile, mkdir } from "node:fs/promises";
const OUT = "/tmp/friend-candidates";
await mkdir(OUT, { recursive: true });
const mupdf = await import("mupdf");

async function render(file, page1, scale, prefix) {
  const buf = await readFile(file);
  const doc = mupdf.Document.openDocument(
    new Uint8Array(buf),
    "application/pdf",
  );
  const n = doc.countPages();
  if (page1 > n) {
    console.log(`  (skip p${page1} — only ${n} pages)`);
    return;
  }
  const page = doc.loadPage(page1 - 1);
  const matrix = [scale, 0, 0, scale, 0, 0];
  const pix = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB);
  await writeFile(`${OUT}/${prefix}.png`, pix.asPNG());
  console.log(`${OUT}/${prefix}.png ${pix.getWidth()}×${pix.getHeight()}`);
}

const PLAN = "/Users/almas/Documents/construction-ai/tests/fixtures/friend-commercial-plan.pdf";
const ANSWER = "/Users/almas/Documents/construction-ai/tests/fixtures/friend-commercial-walls-ANSWER.pdf";

// Answer doc first — tells us which page the wall takeoff was done on.
const ansBuf = await readFile(ANSWER);
const ansDoc = mupdf.Document.openDocument(new Uint8Array(ansBuf), "application/pdf");
console.log(`ANSWER doc has ${ansDoc.countPages()} pages`);
for (let p = 1; p <= ansDoc.countPages(); p++) {
  await render(ANSWER, p, 1.0, `answer-p${String(p).padStart(2, "0")}`);
}

// Candidate plan pages (from Day-1 probe: high wall counts / diagonals).
for (const p of [4, 5, 9, 18, 20, 22, 24, 28, 30, 31, 33]) {
  await render(PLAN, p, 1.0, `plan-p${String(p).padStart(2, "0")}`);
}
