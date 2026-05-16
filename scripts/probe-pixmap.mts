import { readFileSync } from "node:fs";
const mupdf = await import("mupdf");
const data = readFileSync("tests/fixtures/commercial-bench.pdf");
const doc = mupdf.Document.openDocument(new Uint8Array(data), "application/pdf");
const page = doc.loadPage(0);
const matrix = mupdf.Matrix.scale(0.3, 0.3);
const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceGray);
console.log("Pixmap type:", pixmap.constructor.name);
console.log("Own keys:", Object.keys(pixmap));
let proto: unknown = Object.getPrototypeOf(pixmap);
while (proto && (proto as { constructor: { name: string } }).constructor.name !== "Object") {
  const c = (proto as { constructor: { name: string } }).constructor.name;
  console.log(`[${c}] methods:`, Object.getOwnPropertyNames(proto));
  proto = Object.getPrototypeOf(proto);
}
