/**
 * Test the principled wall filter: walls ENCLOSE rooms, dimension lines
 * don't. Feed the clean double-line centerlines into the EXISTING room
 * detector (planar-graph.detectRooms, used as a read-only reader — not
 * modified) and render the resulting room-face polygons. Room faces are
 * area-filtered, so dimension-ladder cells (tiny) drop out automatically;
 * the face boundaries ARE the walls.
 *
 * Writes /tmp/rooms/p<page>-rooms.png and a left-region crop.
 */

import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { detectWallCenterlines } from "../src/lib/extract/wall-pairs.js";
import {
  buildWallGraph,
  wallGraphSegments,
} from "../src/lib/extract/wall-graph.js";
import { detectRooms, type Segment } from "../src/lib/planar-graph.js";

const DIAGONAL_WALL_MIN_PT = 50;
const OUT = "/tmp/rooms";
await mkdir(OUT, { recursive: true });

interface MupdfPath {
  walk: (h: Record<string, (...args: number[]) => void>) => void;
}
function txp(ctm: number[], x: number, y: number): [number, number] {
  return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
}
const PALETTE = [
  "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#46f0f0",
  "#f032e6", "#bcf60c", "#fabebe", "#008080", "#9a6324", "#800000",
  "#aaffc3", "#808000", "#ffd8b1", "#000075",
];

const file = process.argv[2] ?? "tests/fixtures/friend-commercial-plan.pdf";
const page1 = parseInt(process.argv[3] ?? "5", 10);
const scale = parseFloat(process.argv[4] ?? "2");
const minArea = parseFloat(process.argv[5] ?? "4000");
const extendPt = parseFloat(process.argv[6] ?? "7");

const buf = await readFile(path.join(process.cwd(), file));
const mupdf = (await import("mupdf")) as unknown as {
  Document: { openDocument: (b: Uint8Array, m: string) => unknown };
  Device: new (h: Record<string, unknown>) => unknown;
  Matrix: { identity: number[] };
  ColorSpace: { DeviceRGB: unknown };
};
const doc = mupdf.Document.openDocument(
  new Uint8Array(buf),
  "application/pdf",
) as { loadPage: (i: number) => unknown };
const page = doc.loadPage(page1 - 1) as {
  getBounds: () => number[];
  run: (d: unknown, m: number[]) => void;
  toPixmap: (
    m: number[],
    cs: unknown,
  ) => { asPNG: () => Buffer; getWidth: () => number; getHeight: () => number };
};
const bounds = page.getBounds();
const Wpt = bounds[2] - bounds[0];
const Hpt = bounds[3] - bounds[1];

const axial: Segment[] = [];
const diagonal: Segment[] = [];
function emit(x1: number, y1: number, x2: number, y2: number): void {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  const len = Math.hypot(dx, dy);
  if (len < 5) return;
  if (dy < 1.5 && dx > 1.5) axial.push({ x1, y1, x2, y2: y1 });
  else if (dx < 1.5 && dy > 1.5) axial.push({ x1, y1, x2: x1, y2 });
  else if (len >= 18 && len <= 45) {
    /* door swing */
  } else if (len >= DIAGONAL_WALL_MIN_PT) diagonal.push({ x1, y1, x2, y2 });
}
function collect(p: MupdfPath, ctm: number[]): void {
  let cx = 0, cy = 0, sx = 0, sy = 0;
  p.walk({
    moveTo: (x: number, y: number) => {
      [cx, cy] = txp(ctm, x, y);
      sx = cx; sy = cy;
    },
    lineTo: (x: number, y: number) => {
      const [nx, ny] = txp(ctm, x, y);
      emit(cx, cy, nx, ny);
      cx = nx; cy = ny;
    },
    curveTo: () => {},
    closePath: () => {
      emit(cx, cy, sx, sy);
      cx = sx; cy = sy;
    },
  });
}
const device = new mupdf.Device({
  fillPath: (p: MupdfPath, _: unknown, ctm: number[]) => collect(p, ctm),
  strokePath: (p: MupdfPath, _: unknown, ctm: number[]) => collect(p, ctm),
});
page.run(device, mupdf.Matrix.identity);

const rawAll: Segment[] = [...axial, ...diagonal];
const centerlines = detectWallCenterlines(rawAll, { maxGapPt: 12, extendPt });
// Clean the fragmented/overlapping centerlines into deduplicated, connected
// wall edges BEFORE handing them to the room detector.
const graph = buildWallGraph(centerlines);
const cleaned = wallGraphSegments(graph);
const faces = detectRooms(cleaned as Segment[], Wpt, Hpt, {
  minRoomArea: minArea,
});

console.log(`\n=== ${file} page ${page1} ===`);
console.log(`raw ${rawAll.length} → centerlines ${centerlines.length} → cleaned ${cleaned.length} edges`);
console.log(`room faces (minArea ${minArea}): ${faces.length}`);
const sqft = faces.map((f) => f.area / (18 * 18)).sort((a, b) => b - a);
console.log(`face areas sqft@18: ${sqft.map((s) => s.toFixed(0)).join(", ")}`);

// --- Connected-component analysis of the cleaned graph ---
const verts = graph.vertices;
const parent = verts.map((_, i) => i);
const find = (i: number): number => {
  let r = i;
  while (parent[r] !== r) r = parent[r];
  while (parent[i] !== r) {
    const n = parent[i];
    parent[i] = r;
    i = n;
  }
  return r;
};
for (const e of graph.edges) {
  const ra = find(e.p1);
  const rb = find(e.p2);
  if (ra !== rb) parent[ra] = rb;
}
interface Comp {
  root: number;
  len: number;
  edges: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const comps = new Map<number, Comp>();
for (const e of graph.edges) {
  const r = find(e.p1);
  let c = comps.get(r);
  if (!c) {
    c = { root: r, len: 0, edges: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    comps.set(r, c);
  }
  c.len += e.lengthPt;
  c.edges++;
  for (const vi of [e.p1, e.p2]) {
    const v = verts[vi];
    c.x0 = Math.min(c.x0, v.x);
    c.y0 = Math.min(c.y0, v.y);
    c.x1 = Math.max(c.x1, v.x);
    c.y1 = Math.max(c.y1, v.y);
  }
}
const sorted = [...comps.values()].sort((a, b) => b.len - a.len);
console.log(`connected components: ${sorted.length}`);
sorted.slice(0, 8).forEach((c, i) => {
  console.log(
    `  #${i}: ${c.edges} edges, ${(c.len / 18).toFixed(0)} ft, bbox ${(c.x0).toFixed(0)},${(c.y0).toFixed(0)} → ${(c.x1).toFixed(0)},${(c.y1).toFixed(0)} (${(c.x1 - c.x0).toFixed(0)}×${(c.y1 - c.y0).toFixed(0)}pt)`,
  );
});

const pix = page.toPixmap([scale, 0, 0, scale, 0, 0], mupdf.ColorSpace.DeviceRGB);
const W = pix.getWidth();
const H = pix.getHeight();
const pngBuf = pix.asPNG();
const px = (x: number) => x * scale;
const py = (y: number) => H - y * scale;

// Color the top-8 components distinctly; the rest faint gray.
const compColor = new Map<number, string>();
sorted.slice(0, 12).forEach((c, i) => compColor.set(c.root, PALETTE[i % PALETTE.length]));
const parts: string[] = [];
for (const e of graph.edges) {
  const r = find(e.p1);
  const color = compColor.get(r) ?? "#cccccc";
  const a = verts[e.p1];
  const b = verts[e.p2];
  parts.push(
    `<line x1="${px(a.x).toFixed(1)}" y1="${py(a.y).toFixed(1)}" x2="${px(b.x).toFixed(1)}" y2="${py(b.y).toFixed(1)}" stroke="${color}" stroke-width="3" opacity="0.9"/>`,
  );
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join("")}</svg>`;
await sharp(pngBuf)
  .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
  .toFile(`${OUT}/p${page1}-components.png`);
console.log(`wrote ${OUT}/p${page1}-components.png (${W}×${H})`);
