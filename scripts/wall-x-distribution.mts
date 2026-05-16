// Histogram wall midpoint X positions in 100pt buckets.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mupdf = await import("mupdf");

const pdfPath = path.resolve(__dirname, "../tests/fixtures/commercial-bench.pdf");
const data = readFileSync(pdfPath);
const doc = mupdf.Document.openDocument(new Uint8Array(data), "application/pdf");
const page = doc.loadPage(0);

const walls: { x: number; y: number }[] = [];
function tx(ctm: number[], x: number, y: number): [number, number] {
  return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
}
interface MP {
  walk: (v: { moveTo: (x: number, y: number) => void; lineTo: (x: number, y: number) => void; closePath: () => void }) => void;
}
function emit(x1: number, y1: number, x2: number, y2: number): void {
  if (Math.hypot(x2 - x1, y2 - y1) < 2) return;
  walls.push({ x: (x1 + x2) / 2, y: (y1 + y2) / 2 });
}
function collect(p: MP, ctm: number[]): void {
  let cx = 0, cy = 0, sx = 0, sy = 0;
  p.walk({
    moveTo: (x, y) => { [cx, cy] = tx(ctm, x, y); sx = cx; sy = cy; },
    lineTo: (x, y) => { const [nx, ny] = tx(ctm, x, y); emit(cx, cy, nx, ny); cx = nx; cy = ny; },
    closePath: () => { emit(cx, cy, sx, sy); cx = sx; cy = sy; },
  });
}
let fillImageCalls = 0;
let fillShadeCalls = 0;
const dev = new (mupdf as unknown as { Device: new (o: object) => unknown }).Device({
  fillPath: (p: MP, _: unknown, ctm: number[]) => collect(p, ctm),
  strokePath: (p: MP, _: unknown, ctm: number[]) => collect(p, ctm),
  fillImage: () => { fillImageCalls++; },
  fillImageMask: () => { fillImageCalls++; },
  fillShade: () => { fillShadeCalls++; },
});
(page as unknown as { run: (d: unknown, m: number[]) => void }).run(
  dev, (mupdf as unknown as { Matrix: { identity: number[] } }).Matrix.identity,
);

console.log(`Walls: ${walls.length}`);
console.log(`fillImage calls: ${fillImageCalls}`);
console.log(`fillShade calls: ${fillShadeCalls}`);

// Histogram by X (in 200pt buckets)
const buckets = new Map<number, number>();
for (const w of walls) {
  const b = Math.floor(w.x / 200) * 200;
  buckets.set(b, (buckets.get(b) ?? 0) + 1);
}
const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
console.log(`\nWalls by X bucket (200pt-wide):`);
for (const [x, c] of sorted) {
  console.log(`  x=${x.toFixed(0).padStart(4)}-${(x + 200).toFixed(0)}: ${c.toString().padStart(5)} ${"█".repeat(Math.min(50, Math.floor(c / 30)))}`);
}
