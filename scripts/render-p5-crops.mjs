import { readFile, writeFile, mkdir } from "node:fs/promises";
import sharp from "sharp";
const OUT = "/tmp/friend-candidates";
await mkdir(OUT, { recursive: true });
const mupdf = await import("mupdf");

const PLAN =
  "/Users/almas/Documents/construction-ai/tests/fixtures/friend-commercial-plan.pdf";
const buf = await readFile(PLAN);
const doc = mupdf.Document.openDocument(new Uint8Array(buf), "application/pdf");
const scale = 3.0;
const page = doc.loadPage(4); // page 5 (0-indexed)
const pix = page.toPixmap([scale, 0, 0, scale, 0, 0], mupdf.ColorSpace.DeviceRGB);
const fullPng = pix.asPNG();
await writeFile(`${OUT}/p05-full3x.png`, fullPng);
const W = pix.getWidth();
const H = pix.getHeight();
console.log(`full ${W}×${H}`);

// Construction plan occupies the top-left of the sheet. From the
// overview, it spans roughly x:[0.02,0.40] y:[0.03,0.22] of the page.
async function crop(name, l, t, w, h) {
  const left = Math.round(l * W);
  const top = Math.round(t * H);
  const width = Math.round(w * W);
  const height = Math.round(h * H);
  await sharp(fullPng)
    .extract({ left, top, width, height })
    .toFile(`${OUT}/${name}.png`);
  console.log(`${name}: ${width}×${height} at (${left},${top})`);
}

// Whole construction plan.
await crop("p05-constr", 0.02, 0.03, 0.40, 0.21);
// West (left) end of construction plan.
await crop("p05-constr-west", 0.02, 0.03, 0.12, 0.21);
// East (right) end of construction plan.
await crop("p05-constr-east", 0.28, 0.03, 0.14, 0.21);
// Finish plan (below construction).
await crop("p05-finish", 0.02, 0.26, 0.40, 0.21);
