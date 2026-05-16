// Run the planar-graph room extractor on the VA commercial benchmark
// (or any provided PDF) and report what we find.
//
// Usage:
//   npx tsx scripts/test-planar-graph-va.ts [pdfPath] [pageNumber]
//
// Default: tests/fixtures/commercial-bench.pdf page 1

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const mupdf = await import("mupdf");
const planarGraph = await import("../src/lib/planar-graph.ts");
const { detectRooms } = planarGraph;
type Segment = { x1: number; y1: number; x2: number; y2: number };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pdfPath =
  process.argv[2] ??
  path.resolve(__dirname, "../tests/fixtures/commercial-bench.pdf");
const pageNumber = parseInt(process.argv[3] ?? "1", 10);

console.log(`Loading ${path.basename(pdfPath)} page ${pageNumber}…`);
const data = readFileSync(pdfPath);
const doc = mupdf.Document.openDocument(
  new Uint8Array(data),
  "application/pdf",
);
const page = doc.loadPage(pageNumber - 1);
const bounds = page.getBounds();
const pageW = bounds[2] - bounds[0];
const pageH = bounds[3] - bounds[1];
console.log(`Page bounds: ${pageW.toFixed(1)} × ${pageH.toFixed(1)} pt`);

// Walk every path in the page and emit each line as a segment, with
// the current CTM applied so coords are in page user space.
const COORD_TOL = 1.5;
const MIN_WALL_LEN = 5;
const segments: Segment[] = [];

function tx(ctm: number[], x: number, y: number): [number, number] {
  return [
    ctm[0] * x + ctm[2] * y + ctm[4],
    ctm[1] * x + ctm[3] * y + ctm[5],
  ];
}

interface MupdfPath {
  walk: (visitor: {
    moveTo: (x: number, y: number) => void;
    lineTo: (x: number, y: number) => void;
    closePath: () => void;
  }) => void;
}

function emit(x1: number, y1: number, x2: number, y2: number): void {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  const len = Math.hypot(dx, dy);
  if (len < MIN_WALL_LEN) return;
  // Only axis-aligned for v1 (covers >99% of architectural walls)
  if (dy < COORD_TOL && dx > COORD_TOL) {
    segments.push({ x1, y1: y1, x2, y2: y1 });
  } else if (dx < COORD_TOL && dy > COORD_TOL) {
    segments.push({ x1, y1, x2: x1, y2 });
  }
}

function collect(p: MupdfPath, ctm: number[]): void {
  let cx = 0,
    cy = 0,
    sx = 0,
    sy = 0;
  p.walk({
    moveTo: (x, y) => {
      [cx, cy] = tx(ctm, x, y);
      sx = cx;
      sy = cy;
    },
    lineTo: (x, y) => {
      const [nx, ny] = tx(ctm, x, y);
      emit(cx, cy, nx, ny);
      cx = nx;
      cy = ny;
    },
    closePath: () => {
      emit(cx, cy, sx, sy);
      cx = sx;
      cy = sy;
    },
  });
}

const dev = new (mupdf as unknown as { Device: new (opts: object) => unknown })
  .Device({
  fillPath: (p: MupdfPath, _: unknown, ctm: number[]) => collect(p, ctm),
  strokePath: (p: MupdfPath, _: unknown, ctm: number[]) => collect(p, ctm),
});
(page as unknown as { run: (d: unknown, m: number[]) => void }).run(
  dev,
  (mupdf as unknown as { Matrix: { identity: number[] } }).Matrix.identity,
);

console.log(`Wall-candidate segments: ${segments.length}`);

// Run the planar-graph detector.
const t0 = Date.now();
const rooms = detectRooms(segments, pageW, pageH, {
  snapTolerance: 1.5,
  minRoomArea: 3000, // ~3 sqft at 1pt = 1"; tuned for PDFs in PDF points
  maxRoomArea: 0.85 * pageW * pageH,
  maxAspectRatio: 30, // corridors can be very long & thin
});
const dt = Date.now() - t0;

console.log(`\nDetected ${rooms.length} faces in ${dt} ms`);

// Convert area: at typical 1/8" = 1' scale, 96 PDF pt = 1' so 1 sqft = 96² pt².
// But we don't know the scale yet. Just report relative size.
console.log("\nTop 25 rooms by area (sorted):");
console.log("  Area (pt²)  W × H (pt)        Bbox center        Vertices");
console.log("  " + "─".repeat(70));
for (const r of rooms.slice(0, 25)) {
  const w = r.bbox.x1 - r.bbox.x0;
  const h = r.bbox.y1 - r.bbox.y0;
  const cx = (r.bbox.x0 + r.bbox.x1) / 2;
  const cy = (r.bbox.y0 + r.bbox.y1) / 2;
  console.log(
    `  ${Math.round(r.area).toString().padStart(8)} ` +
      `   ${w.toFixed(0).padStart(4)} × ${h.toFixed(0).padStart(4)}` +
      `    (${cx.toFixed(0).padStart(4)}, ${cy.toFixed(0).padStart(4)})` +
      `    ${r.polygon.length}`,
  );
}

// Histogram of vertex counts (rectangles=4, L-shapes=6, corridors might be 4+)
const vertHist = new Map<number, number>();
for (const r of rooms) {
  vertHist.set(r.polygon.length, (vertHist.get(r.polygon.length) ?? 0) + 1);
}
console.log("\nVertex count histogram:");
const sortedHist = [...vertHist.entries()].sort((a, b) => a[0] - b[0]);
for (const [n, count] of sortedHist) {
  console.log(`  ${n.toString().padStart(3)} vertices: ${count}`);
}
