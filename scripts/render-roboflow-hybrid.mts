/**
 * Full hybrid: Roboflow wall polygons (the FILTER) + our vector geometry
 * (the MEASUREMENT).
 *
 *   render page JPEG → Roboflow instance-seg → wall polygons (image px)
 *   → extract our precise vector segments (PDF pt)
 *   → keep segments whose midpoint falls inside a wall polygon (+margin)
 *   → detectWallCenterlines → buildWallGraph → autoTrace
 *   → render + report linear ft
 *
 * The model only says WHICH lines are walls; every coordinate/length is
 * from our extracted vectors. Run with --env-file=.env.local.
 */

import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  buildWallGraph,
  wallGraphSegments,
  type RawSegment,
} from "../src/lib/extract/wall-graph.js";
import { autoTraceWalls } from "../src/lib/extract/wall-autotrace.js";
import { detectWallCenterlines } from "../src/lib/extract/wall-pairs.js";

const FILE = process.argv[2] ?? "tests/fixtures/DP-BP-new-home-sample-drawings.pdf";
const PAGE = parseInt(process.argv[3] ?? "10", 10);
const MODEL = process.argv[4] ?? "floor-plan-nnoub-bk4vn-czy3i/1";
const maxGapPt = parseFloat(process.argv[5] ?? "12");
const marginPt = parseFloat(process.argv[6] ?? "6");
const OUT = "/tmp/roboflow";
await mkdir(OUT, { recursive: true });

const apiKey = process.env.ROBOFLOW_API_KEY;
if (!apiKey) { console.error("ROBOFLOW_API_KEY missing"); process.exit(1); }

interface MupdfPath { walk: (h: Record<string, (...a: number[]) => void>) => void; }
function txp(c: number[], x: number, y: number): [number, number] {
  return [c[0] * x + c[2] * y + c[4], c[1] * x + c[3] * y + c[5]];
}

const buf = await readFile(path.join(process.cwd(), FILE));
const mupdf = (await import("mupdf")) as unknown as {
  Document: { openDocument: (b: Uint8Array, m: string) => unknown };
  Device: new (h: Record<string, unknown>) => unknown;
  Matrix: { identity: number[] };
  ColorSpace: { DeviceRGB: unknown };
};
const doc = mupdf.Document.openDocument(new Uint8Array(buf), "application/pdf") as { loadPage: (i: number) => unknown };
const page = doc.loadPage(PAGE - 1) as {
  getBounds: () => number[];
  run: (d: unknown, m: number[]) => void;
  toPixmap: (m: number[], cs: unknown) => { asPNG: () => Buffer };
};
const b = page.getBounds();
const Wpt = b[2] - b[0];
const Hpt = b[3] - b[1];

// --- extract our precise vector segments ---
const DIAG_MIN = 50;
const axial: RawSegment[] = [];
const diagonal: RawSegment[] = [];
function emit(x1: number, y1: number, x2: number, y2: number): void {
  const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1), len = Math.hypot(dx, dy);
  if (len < 5) return;
  if (dy < 1.5 && dx > 1.5) axial.push({ x1, y1, x2, y2: y1 });
  else if (dx < 1.5 && dy > 1.5) axial.push({ x1, y1, x2: x1, y2 });
  else if (len >= 18 && len <= 45) { /* door swing */ }
  else if (len >= DIAG_MIN) diagonal.push({ x1, y1, x2, y2 });
}
function collect(p: MupdfPath, ctm: number[]): void {
  let cx = 0, cy = 0, sx = 0, sy = 0;
  p.walk({
    moveTo: (x, y) => { [cx, cy] = txp(ctm, x, y); sx = cx; sy = cy; },
    lineTo: (x, y) => { const [nx, ny] = txp(ctm, x, y); emit(cx, cy, nx, ny); cx = nx; cy = ny; },
    curveTo: () => {},
    closePath: () => { emit(cx, cy, sx, sy); cx = sx; cy = sy; },
  });
}
const device = new mupdf.Device({
  fillPath: (p: MupdfPath, _: unknown, c: number[]) => collect(p, c),
  strokePath: (p: MupdfPath, _: unknown, c: number[]) => collect(p, c),
});
page.run(device, mupdf.Matrix.identity);
const rawAll: RawSegment[] = [...axial, ...diagonal];

// --- render JPEG + call Roboflow ---
const scale = 1500 / Math.max(Wpt, Hpt);
const pix = page.toPixmap([scale, 0, 0, scale, 0, 0], mupdf.ColorSpace.DeviceRGB);
const pngBuf = Buffer.from(pix.asPNG());
const jpeg = await sharp(pngBuf).jpeg({ quality: 85 }).toBuffer();
const imgW = Math.round(Wpt * scale);
const imgH = Math.round(Hpt * scale);

const resp = await fetch(`https://serverless.roboflow.com/${MODEL}?api_key=${apiKey}`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: jpeg.toString("base64"),
});
if (!resp.ok) { console.error(`HTTP ${resp.status}: ${await resp.text()}`); process.exit(1); }
interface Pred { x: number; y: number; width: number; height: number; class: string; points?: { x: number; y: number }[]; }
const json = (await resp.json()) as { predictions?: Pred[]; image?: { width: number; height: number } };
const preds = json.predictions ?? [];
const rW = json.image?.width ?? imgW;
const rH = json.image?.height ?? imgH;

// Wall polygons → in OUR pt space (y-up). Roboflow pts are image px (y-down).
const sx = imgW / rW, sy = imgH / rH;
type Poly = { x: number; y: number }[];
const wallPolysPt: Poly[] = [];
for (const p of preds) {
  if (!p.class.toLowerCase().includes("wall") || !p.points || p.points.length < 3) continue;
  wallPolysPt.push(
    p.points.map((q) => ({ x: (q.x * sx) / scale, y: Hpt - (q.y * sy) / scale })),
  );
}
console.log(`\n=== ${FILE} p${PAGE} via ${MODEL} ===`);
console.log(`our vectors: ${rawAll.length}; roboflow wall polygons: ${wallPolysPt.length}`);

function inPoly(poly: Poly, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// Expand test with margin: sample midpoint; accept if inside any polygon, or
// within marginPt of a polygon edge (cheap: test a few offset points).
function nearAnyWall(x: number, y: number): boolean {
  const offs = [[0, 0], [marginPt, 0], [-marginPt, 0], [0, marginPt], [0, -marginPt]];
  for (const poly of wallPolysPt) {
    for (const [ox, oy] of offs) if (inPoly(poly, x + ox, y + oy)) return true;
  }
  return false;
}

const kept = rawAll.filter((s) => nearAnyWall((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2));
console.log(`vectors inside wall mask: ${kept.length}`);

const centerlines = detectWallCenterlines(kept, { maxGapPt });
const graph = buildWallGraph(centerlines);
const cleaned = wallGraphSegments(graph);
const polys = autoTraceWalls(graph);
const totalPt = polys.reduce((s, p) => s + p.lengthPt, 0);
console.log(`centerlines ${centerlines.length} → cleaned ${cleaned.length} edges → autotrace ${polys.length} polylines, ${totalPt.toFixed(0)} pt`);

// --- render overlay ---
const px = (x: number) => x * scale;
const py = (y: number) => imgH - y * scale;
const parts: string[] = [];
for (const poly of wallPolysPt) {
  const pts = poly.map((q) => `${px(q.x).toFixed(1)},${py(q.y).toFixed(1)}`).join(" ");
  parts.push(`<polygon points="${pts}" fill="#22c55e" fill-opacity="0.12" stroke="#22c55e" stroke-width="1.5" stroke-dasharray="6 4"/>`);
}
for (const pl of polys) {
  const pts = pl.points.map((p) => `${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
  parts.push(`<polyline points="${pts}" fill="none" stroke="#e6194b" stroke-width="2.5" opacity="0.95"/>`);
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${imgW}" height="${imgH}">${parts.join("")}</svg>`;
await sharp(jpeg).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).toFile(`${OUT}/p${PAGE}-hybrid.png`);
console.log(`wrote ${OUT}/p${PAGE}-hybrid.png`);
