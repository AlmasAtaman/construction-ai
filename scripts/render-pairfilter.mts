/**
 * Visual proof of the double-line wall pre-filter. Runs the FULL chain:
 *   extract axial+diagonal segments
 *   → detectWallCenterlines (NEW double-line pre-filter)
 *   → buildWallGraph (existing cleanup: snap, merge, T-split, prune)
 *   → autoTraceWalls + filterStrayPolylines (existing)
 *   → render
 *
 * Compares against the OLD path (no pre-filter) on the same page so we can
 * see the before/after. Writes PNGs to /tmp/pairfilter.
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
import { detectWallCenterlines } from "../src/lib/extract/wall-pairs.js";

const DIAGONAL_WALL_MIN_PT = 50;
const OUT = "/tmp/pairfilter";
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
];

const file = process.argv[2] ?? "tests/fixtures/friend-commercial-plan.pdf";
const page1 = parseInt(process.argv[3] ?? "5", 10);
const scale = parseFloat(process.argv[4] ?? "2");
const maxGap = parseFloat(process.argv[5] ?? "12");
const tag = process.argv[6] ?? "";

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

const rawAll: RawSegment[] = [...axial, ...diagonal];

// NEW path: pre-filter to wall centerlines first.
const centerlines = detectWallCenterlines(rawAll, { maxGapPt: maxGap });
const graphNew = buildWallGraph(centerlines);
const cleanedNew = wallGraphSegments(graphNew);
const polysNew = autoTraceWalls(graphNew);
const fNew = filterStrayPolylines(graphNew, polysNew);

// OLD path: everything (what produced the mess).
const graphOld = buildWallGraph(rawAll);
const polysOld = autoTraceWalls(graphOld);
const fOld = filterStrayPolylines(graphOld, polysOld);

console.log(`\n=== ${file} page ${page1} ===`);
console.log(`raw segments: ${rawAll.length} (${axial.length} axial + ${diagonal.length} diag)`);
console.log(`OLD (no pre-filter): autotrace ${polysOld.length} polylines → kept ${fOld.kept.length}`);
console.log(`NEW (double-line):   centerlines ${centerlines.length} → cleaned ${cleanedNew.length} edges, ${graphNew.vertices.length} verts → autotrace ${polysNew.length} → kept ${fNew.kept.length}`);
const lenFt = (polys: TracedPolyline[]) =>
  (polys.reduce((s, p) => s + p.lengthPt, 0) / 18).toFixed(0);
console.log(`NEW kept linear length: ${lenFt(fNew.kept)} ft @18pt/ft`);

const pix = page.toPixmap([scale, 0, 0, scale, 0, 0], mupdf.ColorSpace.DeviceRGB);
const W = pix.getWidth();
const H = pix.getHeight();
const pngBuf = pix.asPNG();
const px = (x: number) => x * scale;
const py = (y: number) => H - y * scale;

function svg(polys: TracedPolyline[], underlay?: RawSegment[]): string {
  const parts: string[] = [];
  if (underlay) {
    // Centerlines (output of the double-line filter) in bold blue.
    for (const s of underlay) {
      parts.push(
        `<line x1="${px(s.x1).toFixed(1)}" y1="${py(s.y1).toFixed(1)}" x2="${px(s.x2).toFixed(1)}" y2="${py(s.y2).toFixed(1)}" stroke="#1d4ed8" stroke-width="2.5" opacity="0.85"/>`,
      );
    }
  }
  // Kept polylines (after autotrace + stray filter) in bold red on top.
  polys.forEach((pl) => {
    const pts = pl.points
      .map((p) => `${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`)
      .join(" ");
    parts.push(
      `<polyline points="${pts}" fill="none" stroke="#e6194b" stroke-width="2.5" opacity="0.95"/>`,
    );
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join("")}</svg>`;
}

await sharp(pngBuf)
  .composite([{ input: Buffer.from(svg(fOld.kept)), top: 0, left: 0 }])
  .toFile(`${OUT}/p${page1}-OLD.png`);
await sharp(pngBuf)
  .composite([{ input: Buffer.from(svg(fNew.kept, cleanedNew)), top: 0, left: 0 }])
  .toFile(`${OUT}/p${page1}-NEW${tag}.png`);
console.log(`wrote ${OUT}/p${page1}-OLD.png and p${page1}-NEW${tag}.png (${W}×${H})`);
