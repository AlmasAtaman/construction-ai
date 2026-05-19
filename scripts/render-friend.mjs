import { readFile, writeFile, mkdir } from "node:fs/promises";
const OUT = "/tmp/friend";
await mkdir(OUT, { recursive: true });
const mupdf = await import("mupdf");
async function render(file, page1, scale, prefix) {
  const buf = await readFile(file);
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), "application/pdf");
  const page = doc.loadPage(page1 - 1);
  const matrix = [scale, 0, 0, scale, 0, 0];
  const pix = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB);
  await writeFile(`${OUT}/${prefix}.png`, pix.asPNG());
  console.log(`${OUT}/${prefix}.png ${pix.getWidth()}×${pix.getHeight()}`);
}
// Render full at 8x for maximum detail
await render(
  "/Users/almas/Documents/construction-ai/tests/fixtures/friend-commercial-walls-ANSWER.pdf",
  1, 8.0, "answer-xx-p1",
);
