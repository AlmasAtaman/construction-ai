/**
 * Commercial-plan hybrid: AI region crop → Roboflow per-plan → our geometry.
 *
 * The Roboflow model blobs multi-plan sheets at full-sheet resolution, so we
 * first use detectWallRegions to find each floor plan, crop to it, and send
 * each crop to Roboflow at full detail. Wall polygons are mapped back to PDF
 * pt, unioned, used to filter our precise vectors, then measured.
 *
 * Run with --env-file=.env.local.
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
import { detectWallRegions } from "../src/lib/ai/wall-region.js";

const FILE = process.argv[2] ?? "tests/fixtures/friend-commercial-plan.pdf";
const PAGE = parseInt(process.argv[3] ?? "5", 10);
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
const bb = page.getBounds();
const Wpt = bb[2] - bb[0];
const Hpt = bb[3] - bb[1];

// --- extract our vectors ---
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
page.run(new mupdf.Device({
  fillPath: (p: MupdfPath, _: unknown, c: number[]) => collect(p, c),
  strokePath: (p: MupdfPath, _: unknown, c: number[]) => collect(p, c),
}), mupdf.Matrix.identity);
const rawAll: RawSegment[] = [...axial, ...diagonal];

// --- detect plan regions (small image) ---
const smallScale = 1400 / Math.max(Wpt, Hpt);
const smallPix = page.toPixmap([smallScale, 0, 0, smallScale, 0, 0], mupdf.ColorSpace.DeviceRGB);
const smallJpeg = await sharp(Buffer.from(smallPix.asPNG())).jpeg({ quality: 85 }).toBuffer();
const { regions } = await detectWallRegions({ imageBase64: smallJpeg.toString("base64"), imageMediaType: "image/jpeg" });
console.log(`\n=== ${FILE} p${PAGE} ===\nAI regions: ${regions.length}`);

// --- render full page once at a per-region-detail scale ---
let maxRegionLong = 0;
for (const r of regions) maxRegionLong = Math.max(maxRegionLong, (r.x1 - r.x0) * Wpt, (r.y1 - r.y0) * Hpt);
const renderScale = Math.min(2.0, 1500 / Math.max(1, maxRegionLong));
const fullPix = page.toPixmap([renderScale, 0, 0, renderScale, 0, 0], mupdf.ColorSpace.DeviceRGB);
const fullPng = Buffer.from(fullPix.asPNG());
const fW = Math.round(Wpt * renderScale);
const fH = Math.round(Hpt * renderScale);

interface Pred { x: number; y: number; width: number; height: number; class: string; points?: { x: number; y: number }[]; }
type Poly = { x: number; y: number }[];
const wallPolysPt: Poly[] = [];

for (const r of regions) {
  const cropLeft = Math.round(r.x0 * fW);
  const cropTop = Math.round(r.y0 * fH);
  const cropW = Math.round((r.x1 - r.x0) * fW);
  const cropH = Math.round((r.y1 - r.y0) * fH);
  if (cropW < 20 || cropH < 20) continue;
  const cropJpeg = await sharp(fullPng).extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH }).jpeg({ quality: 85 }).toBuffer();
  const resp = await fetch(`https://serverless.roboflow.com/${MODEL}?api_key=${apiKey}`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: cropJpeg.toString("base64"),
  });
  if (!resp.ok) { console.error(`  region "${r.label}" HTTP ${resp.status}`); continue; }
  const json = (await resp.json()) as { predictions?: Pred[]; image?: { width: number; height: number } };
  const preds = json.predictions ?? [];
  const rW = json.image?.width ?? cropW;
  const rH = json.image?.height ?? cropH;
  const wallN = preds.filter((p) => p.class.toLowerCase().includes("wall")).length;
  console.log(`  "${r.label}": ${preds.length} preds, ${wallN} walls`);
  for (const p of preds) {
    if (!p.class.toLowerCase().includes("wall") || !p.points || p.points.length < 3) continue;
    // crop-roboflow px → full-image px → pt (y-up)
    wallPolysPt.push(p.points.map((q) => {
      const fx = cropLeft + q.x * (cropW / rW);
      const fy = cropTop + q.y * (cropH / rH);
      return { x: fx / renderScale, y: Hpt - fy / renderScale };
    }));
  }
}
console.log(`total wall polygons: ${wallPolysPt.length}`);

function inPoly(poly: Poly, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function nearAnyWall(x: number, y: number): boolean {
  const offs = [[0, 0], [marginPt, 0], [-marginPt, 0], [0, marginPt], [0, -marginPt]];
  for (const poly of wallPolysPt) for (const [ox, oy] of offs) if (inPoly(poly, x + ox, y + oy)) return true;
  return false;
}

const kept = rawAll.filter((s) => nearAnyWall((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2));
const centerlines = detectWallCenterlines(kept, { maxGapPt });
const graph = buildWallGraph(centerlines);
const cleaned = wallGraphSegments(graph);
const polys = autoTraceWalls(graph);
console.log(`our vectors ${rawAll.length} → in wall mask ${kept.length} → centerlines ${centerlines.length} → cleaned ${cleaned.length} → autotrace ${polys.length} polylines, ${polys.reduce((s, p) => s + p.lengthPt, 0).toFixed(0)} pt`);

// --- overlay on a display-size image ---
const dispScale = 2;
const dispPix = page.toPixmap([dispScale, 0, 0, dispScale, 0, 0], mupdf.ColorSpace.DeviceRGB);
const dispW = Math.round(Wpt * dispScale);
const dispH = Math.round(Hpt * dispScale);
const px = (x: number) => x * dispScale;
const py = (y: number) => dispH - y * dispScale;
const parts: string[] = [];
for (const poly of wallPolysPt) {
  const pts = poly.map((q) => `${px(q.x).toFixed(1)},${py(q.y).toFixed(1)}`).join(" ");
  parts.push(`<polygon points="${pts}" fill="#22c55e" fill-opacity="0.12" stroke="#22c55e" stroke-width="1.5" stroke-dasharray="6 4"/>`);
}
for (const pl of polys) {
  const pts = pl.points.map((p) => `${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
  parts.push(`<polyline points="${pts}" fill="none" stroke="#e6194b" stroke-width="3" opacity="0.95"/>`);
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${dispW}" height="${dispH}">${parts.join("")}</svg>`;
await sharp(Buffer.from(dispPix.asPNG())).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).toFile(`${OUT}/p${PAGE}-region-hybrid.png`);
console.log(`wrote ${OUT}/p${PAGE}-region-hybrid.png`);
