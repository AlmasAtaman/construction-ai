// Dump walls + nearby labels within 200pt of a specific position.
// Used to debug why room expansion misbehaves at a known location.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mupdf = await import("mupdf");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

// Target: OXYGEN ROOM area on VA plan
const TARGET_X = parseFloat(process.argv[2] ?? "1430");
const TARGET_Y = parseFloat(process.argv[3] ?? "1497");
const RADIUS = 200;

const pdfPath = path.resolve(__dirname, "../tests/fixtures/commercial-bench.pdf");
const data = readFileSync(pdfPath);
const doc = mupdf.Document.openDocument(new Uint8Array(data), "application/pdf");
const mPage = doc.loadPage(0);

type Seg = { x1: number; y1: number; x2: number; y2: number };
const walls: Seg[] = [];
function tx(ctm: number[], x: number, y: number): [number, number] {
  return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
}
interface MP {
  walk: (v: {
    moveTo: (x: number, y: number) => void;
    lineTo: (x: number, y: number) => void;
    curveTo?: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    closePath: () => void;
  }) => void;
}
function emit(x1: number, y1: number, x2: number, y2: number): void {
  if (Math.hypot(x2 - x1, y2 - y1) < 2) return;
  walls.push({ x1, y1, x2, y2 });
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
(mPage as unknown as { run: (d: unknown, m: number[]) => void }).run(
  dev, (mupdf as unknown as { Matrix: { identity: number[] } }).Matrix.identity,
);

// Walls within radius of target
const near = walls.filter(
  (w) =>
    Math.hypot((w.x1 + w.x2) / 2 - TARGET_X, (w.y1 + w.y2) / 2 - TARGET_Y) < RADIUS,
);
console.log(`Walls within ${RADIUS}pt of (${TARGET_X}, ${TARGET_Y}): ${near.length} of ${walls.length} total`);

// Sort by distance from target, print first 30
near.sort((a, b) => {
  const da = Math.hypot((a.x1 + a.x2) / 2 - TARGET_X, (a.y1 + a.y2) / 2 - TARGET_Y);
  const db = Math.hypot((b.x1 + b.x2) / 2 - TARGET_X, (b.y1 + b.y2) / 2 - TARGET_Y);
  return da - db;
});
console.log(`\nClosest 30 walls:`);
for (const w of near.slice(0, 30)) {
  const dx = Math.abs(w.x2 - w.x1);
  const dy = Math.abs(w.y2 - w.y1);
  const ax = dy < 1.5 ? "h" : dx < 1.5 ? "v" : "/";
  console.log(`  (${w.x1.toFixed(0)},${w.y1.toFixed(0)}) → (${w.x2.toFixed(0)},${w.y2.toFixed(0)})  [${ax}, len ${Math.hypot(dx, dy).toFixed(0)}]`);
}

// Text fragments nearby
const pdfDoc = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
const pdfPage = await pdfDoc.getPage(1);
const tc = await pdfPage.getTextContent();
const frags = (tc.items as { str: string; transform: number[] }[])
  .filter((it) => it.str.trim().length > 0)
  .map((it) => ({ text: it.str.trim(), x: it.transform[4], y: it.transform[5] }));
const nearLabels = frags.filter(
  (f) => Math.hypot(f.x - TARGET_X, f.y - TARGET_Y) < RADIUS,
);
nearLabels.sort(
  (a, b) =>
    Math.hypot(a.x - TARGET_X, a.y - TARGET_Y) -
    Math.hypot(b.x - TARGET_X, b.y - TARGET_Y),
);
console.log(`\nLabels within ${RADIUS}pt:`);
for (const l of nearLabels.slice(0, 30)) {
  console.log(`  "${l.text}" at (${l.x.toFixed(0)}, ${l.y.toFixed(0)})`);
}
