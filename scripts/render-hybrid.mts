/**
 * Hybrid proof: AI classifies WHERE the walls are, geometry measures.
 *
 *   render small PNG → detectWallRegions (Claude vision) → footprint box(es)
 *   → keep double-line centerlines whose midpoint is inside a box
 *   → buildWallGraph + autoTrace (existing geometry)
 *   → render boxes (green) + kept walls (red) over the page
 *
 * The model only returns coarse region boxes; every coordinate/length comes
 * from geometry. Run with: npx tsx --env-file=.env.local scripts/render-hybrid.mts
 */

import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  buildWallGraph,
  wallGraphSegments,
  type RawSegment,
} from "../src/lib/extract/wall-graph.js";
import {
  autoTraceWalls,
  filterStrayPolylines,
  type TracedPolyline,
} from "../src/lib/extract/wall-autotrace.js";
import {
  detectWallCenterlines,
  dropParallelStacks,
} from "../src/lib/extract/wall-pairs.js";
import { detectWallRegions, type WallRegion } from "../src/lib/ai/wall-region.js";
import { classifyWallMarks } from "../src/lib/ai/wall-classify.js";

const DIAGONAL_WALL_MIN_PT = 50;
const OUT = "/tmp/hybrid";
await mkdir(OUT, { recursive: true });

interface MupdfPath {
  walk: (h: Record<string, (...args: number[]) => void>) => void;
}
function txp(ctm: number[], x: number, y: number): [number, number] {
  return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
}

const file = process.argv[2] ?? "tests/fixtures/friend-commercial-plan.pdf";
const page1 = parseInt(process.argv[3] ?? "5", 10);
const overlayScale = parseFloat(process.argv[4] ?? "2");
const marginFrac = parseFloat(process.argv[5] ?? "0.015");
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

// --- extract segments ---
const axial: RawSegment[] = [];
const diagonal: RawSegment[] = [];
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
    moveTo: (x, y) => { [cx, cy] = txp(ctm, x, y); sx = cx; sy = cy; },
    lineTo: (x, y) => { const [nx, ny] = txp(ctm, x, y); emit(cx, cy, nx, ny); cx = nx; cy = ny; },
    curveTo: () => {},
    closePath: () => { emit(cx, cy, sx, sy); cx = sx; cy = sy; },
  });
}
const device = new mupdf.Device({
  fillPath: (p: MupdfPath, _: unknown, ctm: number[]) => collect(p, ctm),
  strokePath: (p: MupdfPath, _: unknown, ctm: number[]) => collect(p, ctm),
});
page.run(device, mupdf.Matrix.identity);
const rawAll: RawSegment[] = [...axial, ...diagonal];

// --- render small PNG for the model (longest edge ~1555px) ---
const apiScale = 1555 / Math.max(Wpt, Hpt);
const apiPix = page.toPixmap([apiScale, 0, 0, apiScale, 0, 0], mupdf.ColorSpace.DeviceRGB);
const apiPng = Buffer.from(apiPix.asPNG());
const imageBase64 = apiPng.toString("base64");

console.log(`\n=== ${file} page ${page1} ===`);
console.log(`page ${Wpt.toFixed(0)}×${Hpt.toFixed(0)}pt; api image ${apiPix.getWidth()}×${apiPix.getHeight()}px`);

const t0 = Date.now();
const { regions, inputTokens, outputTokens } = await detectWallRegions({
  imageBase64,
  imageMediaType: "image/png",
});
console.log(`AI regions: ${regions.length} (in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${inputTokens} in / ${outputTokens} out tokens)`);
regions.forEach((r) =>
  console.log(`  "${r.label}": [${r.x0.toFixed(3)},${r.y0.toFixed(3)} → ${r.x1.toFixed(3)},${r.y1.toFixed(3)}]`),
);

// --- centerlines → dedup via graph → de-stack → region filter ---
const maxGapPt = parseFloat(process.argv[8] ?? "12");
const centerlines = detectWallCenterlines(rawAll, { maxGapPt, extendPt });
const dedupSegs = wallGraphSegments(buildWallGraph(centerlines));
function inAnyRegion(mx: number, my: number): boolean {
  const xn = mx / Wpt;
  const yn = 1 - my / Hpt; // pt y-up → image y-down
  for (const r of regions) {
    if (
      xn >= r.x0 - marginFrac &&
      xn <= r.x1 + marginFrac &&
      yn >= r.y0 - marginFrac &&
      yn <= r.y1 + marginFrac
    ) {
      return true;
    }
  }
  return false;
}
const kept = dedupSegs.filter((c) =>
  inAnyRegion((c.x1 + c.x2) / 2, (c.y1 + c.y2) / 2),
);
console.log(
  `centerlines: ${centerlines.length} → deduped: ${dedupSegs.length} → inside regions: ${kept.length}`,
);

const graph = buildWallGraph(kept);
const cleaned = wallGraphSegments(graph);

// Connected-component sizes WITHIN the AI region.
const vp = graph.vertices.map((_, i) => i);
const find = (i: number): number => {
  let r = i;
  while (vp[r] !== r) r = vp[r];
  while (vp[i] !== r) { const n = vp[i]; vp[i] = r; i = n; }
  return r;
};
for (const e of graph.edges) { const a = find(e.p1), b = find(e.p2); if (a !== b) vp[a] = b; }
const compLen = new Map<number, number>();
for (const e of graph.edges) { const r = find(e.p1); compLen.set(r, (compLen.get(r) ?? 0) + e.lengthPt); }
const compSorted = [...compLen.values()].sort((a, b) => b - a);
console.log(`cleaned ${cleaned.length} edges, ${compLen.size} components`);
console.log(`  top component sizes (ft): ${compSorted.slice(0, 8).map((l) => (l / 18).toFixed(0)).join(", ")}`);

// Keep edges in the dominant wall components (>= 20% of the largest). These
// are the connected wall networks; dimension/furniture fragments are tiny.
const largest = compSorted[0] ?? 0;
const compFrac = parseFloat(process.argv[7] ?? "0.2");
const wallSegs: RawSegment[] = [];
for (const e of graph.edges) {
  if ((compLen.get(find(e.p1)) ?? 0) >= compFrac * largest) {
    const a = graph.vertices[e.p1];
    const b = graph.vertices[e.p2];
    wallSegs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }
}
const wallGraph = buildWallGraph(wallSegs);
const candidates = autoTraceWalls(wallGraph);
console.log(`big-component candidates: ${candidates.length} polylines, ${(candidates.reduce((s, p) => s + p.lengthPt, 0) / 18).toFixed(0)} ft`);

// --- 2nd AI pass: classify each candidate polyline as wall vs dimension ---
// Build a marked image cropped to the region union so the numbers are legible.
let ux0 = Infinity, uy0 = Infinity, ux1 = -Infinity, uy1 = -Infinity; // normalized y-down
for (const r of regions) {
  ux0 = Math.min(ux0, r.x0); uy0 = Math.min(uy0, r.y0);
  ux1 = Math.max(ux1, r.x1); uy1 = Math.max(uy1, r.y1);
}
// pad a little so edge walls + labels aren't clipped
const padN = 0.02;
ux0 = Math.max(0, ux0 - padN); uy0 = Math.max(0, uy0 - padN);
ux1 = Math.min(1, ux1 + padN); uy1 = Math.min(1, uy1 + padN);

const markScale = Math.min(2.4, 1500 / ((ux1 - ux0) * Wpt));
const mPix = page.toPixmap([markScale, 0, 0, markScale, 0, 0], mupdf.ColorSpace.DeviceRGB);
const mW = mPix.getWidth();
const mH = mPix.getHeight();
const cropLeft = Math.round(ux0 * mW);
const cropTop = Math.round(uy0 * mH);
const cropW = Math.round((ux1 - ux0) * mW);
const cropH = Math.round((uy1 - uy0) * mH);
const mpx = (x: number) => x * markScale - cropLeft;
const mpy = (y: number) => mH - y * markScale - cropTop; // pt y-up → crop px

const markParts: string[] = [];
candidates.forEach((pl, i) => {
  const id = i + 1;
  const pts = pl.points.map((p) => `${mpx(p.x).toFixed(1)},${mpy(p.y).toFixed(1)}`).join(" ");
  markParts.push(
    `<polyline points="${pts}" fill="none" stroke="#ff00ff" stroke-width="3" opacity="0.9"/>`,
  );
  const mid = pl.points[Math.floor(pl.points.length / 2)];
  const lx = mpx(mid.x);
  const ly = mpy(mid.y);
  markParts.push(
    `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="13" fill="#ff00ff" stroke="white" stroke-width="2"/>` +
      `<text x="${lx.toFixed(1)}" y="${(ly + 5).toFixed(1)}" font-family="Arial" font-size="15" font-weight="700" fill="white" text-anchor="middle">${id}</text>`,
  );
});
const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cropW}" height="${cropH}">${markParts.join("")}</svg>`;
const markedJpeg = await sharp(Buffer.from(mPix.asPNG()))
  .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
  .composite([{ input: Buffer.from(markSvg), top: 0, left: 0 }])
  .jpeg({ quality: 85 })
  .toBuffer();
await sharp(markedJpeg).toFile(`${OUT}/p${page1}-marked.jpg`);

const markIds = candidates.map((_, i) => i + 1);
const t1 = Date.now();
const cls = await classifyWallMarks({
  imageBase64: markedJpeg.toString("base64"),
  imageMediaType: "image/jpeg",
  markIds,
});
const counts = { wall: 0, dimension: 0, other: 0 };
for (const k of cls.kinds.values()) counts[k]++;
console.log(`2nd AI pass (${((Date.now() - t1) / 1000).toFixed(1)}s, ${cls.inputTokens} in / ${cls.outputTokens} out): wall ${counts.wall}, dimension ${counts.dimension}, other ${counts.other}`);

const keptPolys = candidates.filter((_, i) => cls.kinds.get(i + 1) === "wall");
console.log(`kept walls: ${keptPolys.length} polylines, ${(keptPolys.reduce((s, p) => s + p.lengthPt, 0) / 18).toFixed(0)} ft @18pt/ft`);

// --- render overlay ---
const pix = page.toPixmap([overlayScale, 0, 0, overlayScale, 0, 0], mupdf.ColorSpace.DeviceRGB);
const W = pix.getWidth();
const H = pix.getHeight();
const pngBuf = pix.asPNG();
const px = (x: number) => x * overlayScale;
const py = (y: number) => H - y * overlayScale;

const parts: string[] = [];
// region boxes (green dashed) — convert normalized y-down → image px
for (const r of regions) {
  const rx = r.x0 * W;
  const ry = r.y0 * H;
  const rw = (r.x1 - r.x0) * W;
  const rh = (r.y1 - r.y0) * H;
  parts.push(
    `<rect x="${rx.toFixed(1)}" y="${ry.toFixed(1)}" width="${rw.toFixed(1)}" height="${rh.toFixed(1)}" fill="none" stroke="#0a0" stroke-width="3" stroke-dasharray="12 8" opacity="0.8"/>`,
  );
}
// kept walls (red)
for (const pl of keptPolys) {
  const pts = pl.points.map((p) => `${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
  parts.push(
    `<polyline points="${pts}" fill="none" stroke="#e6194b" stroke-width="3" opacity="0.95"/>`,
  );
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join("")}</svg>`;
await sharp(pngBuf)
  .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
  .toFile(`${OUT}/p${page1}-hybrid.png`);
console.log(`wrote ${OUT}/p${page1}-hybrid.png (${W}×${H})`);
