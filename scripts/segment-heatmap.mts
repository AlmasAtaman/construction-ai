// Heatmap of wall segment positions: divide the page into 10x10 grid
// and count segments per cell. Reveals where walls actually are.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mupdf = await import("mupdf");

const pdfPath =
  process.argv[2] ??
  path.resolve(__dirname, "../tests/fixtures/commercial-bench.pdf");
const data = readFileSync(pdfPath);
const doc = mupdf.Document.openDocument(new Uint8Array(data), "application/pdf");
const page = doc.loadPage(0);
const bounds = page.getBounds();
const pageW = bounds[2] - bounds[0];
const pageH = bounds[3] - bounds[1];

const segments: { x1: number; y1: number; x2: number; y2: number }[] = [];

function tx(ctm: number[], x: number, y: number): [number, number] {
  return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
}
interface MP {
  walk: (v: { moveTo: (x: number, y: number) => void; lineTo: (x: number, y: number) => void; closePath: () => void }) => void;
}
function emit(x1: number, y1: number, x2: number, y2: number): void {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  if (Math.hypot(dx, dy) < 5) return;
  if (dy < 1.5 && dx > 1.5) segments.push({ x1, y1, x2, y2: y1 });
  else if (dx < 1.5 && dy > 1.5) segments.push({ x1, y1, x2: x1, y2 });
}
function collect(p: MP, ctm: number[]): void {
  let cx = 0, cy = 0, sx = 0, sy = 0;
  p.walk({
    moveTo: (x, y) => { [cx, cy] = tx(ctm, x, y); sx = cx; sy = cy; },
    lineTo: (x, y) => { const [nx, ny] = tx(ctm, x, y); emit(cx, cy, nx, ny); cx = nx; cy = ny; },
    closePath: () => { emit(cx, cy, sx, sy); cx = sx; cy = sy; },
  });
}
const dev = new (mupdf as unknown as { Device: new (o: object) => unknown }).Device({
  fillPath: (p: MP, _: unknown, ctm: number[]) => collect(p, ctm),
  strokePath: (p: MP, _: unknown, ctm: number[]) => collect(p, ctm),
});
(page as unknown as { run: (d: unknown, m: number[]) => void }).run(
  dev,
  (mupdf as unknown as { Matrix: { identity: number[] } }).Matrix.identity,
);

// 10x10 grid, count segment midpoints per cell.
const W = 10;
const H = 10;
const counts = Array.from({ length: H }, () => new Array(W).fill(0) as number[]);
for (const s of segments) {
  const mx = (s.x1 + s.x2) / 2;
  const my = (s.y1 + s.y2) / 2;
  const cx = Math.min(W - 1, Math.floor((mx / pageW) * W));
  const cy = Math.min(H - 1, Math.floor((my / pageH) * H));
  counts[cy][cx]++;
}

console.log(`Page ${pageW.toFixed(0)}×${pageH.toFixed(0)}, ${segments.length} segments`);
console.log("\nHeatmap (rows=Y bottom→top, cols=X left→right):");
// Print top-to-bottom (high Y first)
for (let row = H - 1; row >= 0; row--) {
  const line = counts[row]
    .map((c) => c.toString().padStart(5))
    .join("");
  const yRange = `y=${((row / H) * pageH).toFixed(0)}-${(((row + 1) / H) * pageH).toFixed(0)}`;
  console.log(`  ${yRange.padEnd(14)}${line}`);
}
console.log("  " + " ".repeat(14) + Array.from({ length: W }, (_, i) =>
  `x=${((i / W) * pageW).toFixed(0)}`.padStart(5),
).join(""));
