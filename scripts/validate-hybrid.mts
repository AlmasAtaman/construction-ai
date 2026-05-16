// Hybrid: planar-graph faces (wall-bounded regions) → label assignment.
// Each face contains 1+ labels, becomes a room. No Voronoi over-slicing.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mupdf = await import("mupdf");
const pg = await import("../src/lib/planar-graph.ts");
const { detectRooms } = pg;
const iw = await import("../src/lib/image-walls.ts");
const { detectWallsFromImage } = iw;
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const pdfPath = path.resolve(__dirname, "../tests/fixtures/commercial-bench.pdf");
const truthPath = path.resolve(__dirname, "../tests/fixtures/commercial-bench-ground-truth.json");
const data = readFileSync(pdfPath);
const truth = JSON.parse(readFileSync(truthPath, "utf8")) as {
  pages: { pageNumber: number; rooms: { label: string; matchKeys: string[]; trueFloorAreaSqft: number }[] }[];
};
const gt = truth.pages.find((p) => p.pageNumber === 1)!.rooms;

// ── Vector walls + door candidates ──────────────────────────────────────
const doc = mupdf.Document.openDocument(new Uint8Array(data), "application/pdf");
const mPage = doc.loadPage(0);
const bounds = mPage.getBounds();
const pageW = bounds[2] - bounds[0];
const pageH = bounds[3] - bounds[1];

type Seg = { x1: number; y1: number; x2: number; y2: number };
const walls: Seg[] = [];
const doorCandidates: { x: number; y: number; size: number }[] = [];

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
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  const len = Math.hypot(dx, dy);
  if (len < 5) return;
  if (dy < 1.5 && dx > 1.5) walls.push({ x1, y1, x2, y2: y1 });
  else if (dx < 1.5 && dy > 1.5) walls.push({ x1, y1, x2: x1, y2 });
  else if (len >= 18 && len <= 45) {
    doorCandidates.push({ x: (x1 + x2) / 2, y: (y1 + y2) / 2, size: len });
  }
}
function collect(p: MP, ctm: number[]): void {
  let cx = 0, cy = 0, sx = 0, sy = 0;
  p.walk({
    moveTo: (x, y) => { [cx, cy] = tx(ctm, x, y); sx = cx; sy = cy; },
    lineTo: (x, y) => { const [nx, ny] = tx(ctm, x, y); emit(cx, cy, nx, ny); cx = nx; cy = ny; },
    curveTo: (c1x, c1y, c2x, c2y, ex, ey) => {
      const [a1x, a1y] = tx(ctm, c1x, c1y);
      const [a2x, a2y] = tx(ctm, c2x, c2y);
      const [aex, aey] = tx(ctm, ex, ey);
      const minX = Math.min(cx, a1x, a2x, aex);
      const maxX = Math.max(cx, a1x, a2x, aex);
      const minY = Math.min(cy, a1y, a2y, aey);
      const maxY = Math.max(cy, a1y, a2y, aey);
      const extent = Math.max(maxX - minX, maxY - minY);
      if (extent >= 18 && extent <= 45) {
        doorCandidates.push({ x: (minX + maxX) / 2, y: (minY + maxY) / 2, size: extent });
      }
      cx = aex; cy = aey;
    },
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

// ── Text fragments ──────────────────────────────────────────────────────
const pdfDoc = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
const pdfPage = await pdfDoc.getPage(1);
const tc = await pdfPage.getTextContent();
const frags = (tc.items as { str: string; transform: number[]; height: number; width: number }[])
  .filter((it) => it.str.trim().length > 0)
  .map((it) => ({
    text: it.str.trim(),
    x: it.transform[4],
    y: it.transform[5],
    fontSize: Math.abs(it.transform[3] || it.height || 8),
  }));
const textBoxes = frags.map((f) => ({
  x: f.x,
  y: f.y - f.fontSize * 0.2,
  width: f.fontSize * f.text.length * 0.6,
  height: f.fontSize * 1.2,
}));

// ── Image walls ─────────────────────────────────────────────────────────
const imgResult = await detectWallsFromImage(Buffer.from(data), 1, {
  dpi: 150,
  threshold: 140,
  minWallPx: 24,
  minWallThickness: 2,
  textBoxes,
});
for (const s of imgResult.segments) walls.push({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 });
console.log(`Walls: vector ${walls.length - imgResult.segments.length} + image ${imgResult.segments.length} = ${walls.length}`);
console.log(`Door candidates: ${doorCandidates.length}`);

// ── Planar-graph faces ──────────────────────────────────────────────────
const t0 = Date.now();
const faces = detectRooms(walls, pageW, pageH, {
  snapTolerance: 1.5,
  minRoomArea: 500,
  maxRoomArea: 0.85 * pageW * pageH,
  maxAspectRatio: 50,
  maxVertices: 200,
  maxDoorGap: 60,
  doorCandidates,
  doorMatchRadius: 60,
});
console.log(`Planar-graph faces: ${faces.length} in ${Date.now() - t0}ms`);

// ── Point-in-polygon ────────────────────────────────────────────────────
function inside(p: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > p.y) !== (yj > p.y)) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) r = !r;
  }
  return r;
}

// ── Assign labels to faces (smallest containing face wins) ──────────────
const labelToFace = new Map<number, number>();
for (let li = 0; li < frags.length; li++) {
  let best = -1;
  let bestArea = Infinity;
  for (let fi = 0; fi < faces.length; fi++) {
    if (!inside({ x: frags[li].x, y: frags[li].y }, faces[fi].polygon)) continue;
    if (faces[fi].area < bestArea) {
      bestArea = faces[fi].area;
      best = fi;
    }
  }
  if (best >= 0) labelToFace.set(li, best);
}

// ── GT match ────────────────────────────────────────────────────────────
function gtIdxForText(text: string): number {
  const t = text.toLowerCase();
  for (let i = 0; i < gt.length; i++) {
    if (gt[i].matchKeys.some((k) => t.includes(k.toLowerCase()))) return i;
  }
  return -1;
}

const gtFace = new Map<number, number>(); // gtIdx → faceIdx
for (const [li, fi] of labelToFace) {
  const gi = gtIdxForText(frags[li].text);
  if (gi < 0) continue;
  // Prefer the smallest face that any label of this GT lands in
  const cur = gtFace.get(gi);
  if (cur == null || faces[fi].area < faces[cur].area) {
    gtFace.set(gi, fi);
  }
}

console.log(`\nGT → face mapping:`);
let matched = 0;
let totalDetected = 0;
let totalTruth = 0;
for (let i = 0; i < gt.length; i++) {
  const fi = gtFace.get(i);
  if (fi == null) {
    console.log(`  ✗ ${gt[i].label.padEnd(35)} — no enclosing face`);
  } else {
    matched++;
    const f = faces[fi];
    const w = f.bbox.x1 - f.bbox.x0;
    const h = f.bbox.y1 - f.bbox.y0;
    totalDetected += f.area;
    totalTruth += gt[i].trueFloorAreaSqft;
    console.log(`  ✓ ${gt[i].label.padEnd(35)} → face ${fi} area=${Math.round(f.area)} bbox=${w.toFixed(0)}×${h.toFixed(0)}  truth=${gt[i].trueFloorAreaSqft}sqft`);
  }
}

console.log(`\n${matched}/${gt.length} GT rooms matched to faces`);

if (matched > 0 && totalTruth > 0) {
  const scale = totalDetected / totalTruth; // pt²/sqft
  console.log(`Implied scale: ${scale.toFixed(0)} pt²/sqft (expected ${81} at 1/8":1')`);
  console.log(`Per-room sqft at this scale:`);
  for (let i = 0; i < gt.length; i++) {
    const fi = gtFace.get(i);
    if (fi == null) continue;
    const sqft = faces[fi].area / scale;
    const err = (sqft / gt[i].trueFloorAreaSqft - 1) * 100;
    console.log(`  ${gt[i].label.padEnd(35)} detected=${sqft.toFixed(0)} truth=${gt[i].trueFloorAreaSqft} err=${err > 0 ? "+" : ""}${err.toFixed(0)}%`);
  }
}
