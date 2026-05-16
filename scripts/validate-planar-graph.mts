// Validate planar-graph room recovery against the commercial benchmark.
//
// 1. Extract vector segments via mupdf
// 2. Run detectRooms() → polygons
// 3. Pull text fragments from pdfjs (the page's text layer)
// 4. For each polygon, find the largest in-polygon label
// 5. Match against ground-truth match keys

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const mupdf = await import("mupdf");
const planarGraph = await import("../src/lib/planar-graph.ts");
const { detectRooms } = planarGraph;
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const pdfPath = path.resolve(
  __dirname,
  "../tests/fixtures/commercial-bench.pdf",
);
const truthPath = path.resolve(
  __dirname,
  "../tests/fixtures/commercial-bench-ground-truth.json",
);
const pageNumber = 1;

const truth = JSON.parse(readFileSync(truthPath, "utf8")) as {
  pages: { pageNumber: number; rooms: { label: string; matchKeys: string[]; trueFloorAreaSqft: number }[] }[];
};
const groundTruth = truth.pages.find((p) => p.pageNumber === pageNumber)!.rooms;

// ── 1. Vector extraction ────────────────────────────────────────────────
const data = readFileSync(pdfPath);
const doc = mupdf.Document.openDocument(
  new Uint8Array(data),
  "application/pdf",
);
const mupdfPage = doc.loadPage(pageNumber - 1);
const bounds = mupdfPage.getBounds();
const pageW = bounds[2] - bounds[0];
const pageH = bounds[3] - bounds[1];
console.log(`Page: ${pageW.toFixed(0)} × ${pageH.toFixed(0)} pt`);

const COORD_TOL = 1.5;
const MIN_WALL_LEN = 5;
const DOOR_MIN = 18;
const DOOR_MAX = 45;
type Segment = { x1: number; y1: number; x2: number; y2: number };
const segments: Segment[] = [];
const doorCandidates: { x: number; y: number; size: number }[] = [];

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
    curveTo?: (c1x: number, c1y: number, c2x: number, c2y: number, ex: number, ey: number) => void;
    closePath: () => void;
  }) => void;
}
function emit(x1: number, y1: number, x2: number, y2: number): void {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  const len = Math.hypot(dx, dy);
  if (len < MIN_WALL_LEN) return;
  if (dy < COORD_TOL && dx > COORD_TOL) {
    segments.push({ x1, y1, x2, y2: y1 });
  } else if (dx < COORD_TOL && dy > COORD_TOL) {
    segments.push({ x1, y1, x2: x1, y2 });
  } else if (len >= DOOR_MIN && len <= DOOR_MAX) {
    doorCandidates.push({ x: (x1 + x2) / 2, y: (y1 + y2) / 2, size: len });
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
    curveTo: (
      c1x: number,
      c1y: number,
      c2x: number,
      c2y: number,
      ex: number,
      ey: number,
    ) => {
      const [a1x, a1y] = tx(ctm, c1x, c1y);
      const [a2x, a2y] = tx(ctm, c2x, c2y);
      const [aex, aey] = tx(ctm, ex, ey);
      const minX = Math.min(cx, a1x, a2x, aex);
      const maxX = Math.max(cx, a1x, a2x, aex);
      const minY = Math.min(cy, a1y, a2y, aey);
      const maxY = Math.max(cy, a1y, a2y, aey);
      const extent = Math.max(maxX - minX, maxY - minY);
      if (extent >= DOOR_MIN && extent <= DOOR_MAX) {
        doorCandidates.push({
          x: (minX + maxX) / 2,
          y: (minY + maxY) / 2,
          size: extent,
        });
      }
      cx = aex;
      cy = aey;
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
(mupdfPage as unknown as { run: (d: unknown, m: number[]) => void }).run(
  dev,
  (mupdf as unknown as { Matrix: { identity: number[] } }).Matrix.identity,
);
console.log(`Wall segments: ${segments.length}`);
console.log(`Door candidates: ${doorCandidates.length}`);

// ── 2. Detect rooms ─────────────────────────────────────────────────────
const t0 = Date.now();
const rooms = detectRooms(segments, pageW, pageH, {
  snapTolerance: 1.5,
  minRoomArea: 1500,
  maxRoomArea: 0.85 * pageW * pageH,
  maxAspectRatio: 30,
  maxVertices: 80,
  maxDoorGap: 60,
  doorCandidates,
  doorMatchRadius: 60,
});
const dt = Date.now() - t0;
console.log(`Detected ${rooms.length} rooms in ${dt} ms`);

// ── 3. Extract text fragments via pdfjs ─────────────────────────────────
type TextFrag = { text: string; x: number; y: number; fontSize: number };
const pdfDoc = await pdfjs.getDocument({
  data: new Uint8Array(data),
  isEvalSupported: false,
}).promise;
const pdfPage = await pdfDoc.getPage(pageNumber);
const viewport = pdfPage.getViewport({ scale: 1 });
const textContent = await pdfPage.getTextContent();
const fragments: TextFrag[] = [];
for (const item of textContent.items as { str: string; transform: number[]; height: number }[]) {
  const text = item.str.trim();
  if (!text) continue;
  // pdfjs transform is [scaleX, skewY, skewX, scaleY, tx, ty]; ty is from top
  const x = item.transform[4];
  const yTopOrigin = item.transform[5];
  // pdfjs y is measured from BOTTOM of page (PDF user space), so we keep
  // it as-is to match mupdf's coordinate system.
  const y = yTopOrigin;
  fragments.push({
    text,
    x,
    y,
    fontSize: Math.abs(item.transform[3] || item.height || 8),
  });
}
console.log(`Text fragments: ${fragments.length}`);
console.log(`Viewport: ${viewport.width.toFixed(0)} × ${viewport.height.toFixed(0)}`);

// ── 4. Pair polygons with labels ────────────────────────────────────────
function pointInPolygon(p: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > p.y) !== (yj > p.y))
      && (p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

interface Pairing {
  roomIdx: number;
  area: number;
  bbox: { x: number; y: number; width: number; height: number };
  labels: TextFrag[];
  primaryLabel: string;
}

// First pass: for each label, find the SMALLEST polygon that contains
// it. That's the room — bigger polygons are wraparound interior space.
const labelToRoom = new Map<TextFrag, number>();
for (const f of fragments) {
  let bestIdx = -1;
  let bestArea = Infinity;
  for (let i = 0; i < rooms.length; i++) {
    if (!pointInPolygon({ x: f.x, y: f.y }, rooms[i].polygon)) continue;
    if (rooms[i].area < bestArea) {
      bestArea = rooms[i].area;
      bestIdx = i;
    }
  }
  if (bestIdx >= 0) labelToRoom.set(f, bestIdx);
}

const pairings: Pairing[] = [];
for (let i = 0; i < rooms.length; i++) {
  const r = rooms[i];
  const labels: TextFrag[] = [];
  for (const [f, idx] of labelToRoom) {
    if (idx === i) labels.push(f);
  }
  labels.sort((a, b) => b.fontSize - a.fontSize || a.text.localeCompare(b.text));
  const primaryLabel = labels.length > 0
    ? labels.slice(0, 4).map((f) => f.text).join(" ")
    : "(no label)";
  pairings.push({
    roomIdx: i,
    area: r.area,
    bbox: {
      x: r.bbox.x0,
      y: r.bbox.y0,
      width: r.bbox.x1 - r.bbox.x0,
      height: r.bbox.y1 - r.bbox.y0,
    },
    labels,
    primaryLabel,
  });
}

console.log("\nTop 20 pairings (by area):");
console.log("  Area (pt²)  Primary label (truncated)");
console.log("  " + "─".repeat(75));
for (const p of pairings.slice(0, 20)) {
  console.log(`  ${Math.round(p.area).toString().padStart(8)}    ${p.primaryLabel.slice(0, 60)}`);
}

// ── 5. Match against ground truth ───────────────────────────────────────
console.log("\nGround truth match (case-insensitive substring on primary label or ALL labels):");
let matched = 0;
for (const gt of groundTruth) {
  const allKeys = gt.matchKeys.map((k) => k.toLowerCase());
  let found: Pairing | null = null;
  for (const p of pairings) {
    const haystack = p.labels.map((l) => l.text.toLowerCase()).join(" ");
    if (allKeys.some((k) => haystack.includes(k))) {
      found = p;
      break;
    }
  }
  if (found) {
    matched++;
    console.log(
      `  ✓ ${gt.label.padEnd(35)} → polygon ${found.roomIdx} (${Math.round(found.area)} pt², ${found.labels.length} labels)`,
    );
  } else {
    console.log(`  ✗ ${gt.label.padEnd(35)} — not paired with any polygon`);
  }
}

console.log(`\n${matched}/${groundTruth.length} ground-truth rooms matched`);
