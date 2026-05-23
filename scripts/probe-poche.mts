/**
 * Read-only probe: are the walls on this plan drawn as POCHÉ (solid-filled
 * thin rectangles)? The lineweight test failed (no stroke-width separation),
 * but page 5 has ~5,864 fill ops. If walls are poché, the wall BODIES are
 * sitting in the fills already separated from line-work.
 *
 * For every fillPath op we compute the path's bounding box (in device pt),
 * its aspect ratio and short-side thickness, and classify:
 *   - WALL_POCHE : thin (short side <= THICK_MAX) AND long (long side >= LONG_MIN)
 *   - BLOB       : both sides small  (text / symbols / furniture dots)
 *   - BIG        : both sides large  (room shading / title block / graphics)
 *   - OTHER      : everything else
 *
 * Then renders the page with each fill's outline color-coded by class so we
 * can SEE whether the WALL_POCHE fills trace the real walls. Writes nothing
 * but PNGs to /tmp/poche.
 *
 * Also reports a quick parallel-pair tally on the long axial strokes (the
 * other free "what is a wall" signal: walls = two faces a wall-thickness
 * apart), so we can compare the two levers before committing to one.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const FILE = process.argv[2] ?? "tests/fixtures/friend-commercial-plan.pdf";
const PAGE = parseInt(process.argv[3] ?? "5", 10);
const SCALE = parseFloat(process.argv[4] ?? "2");
const OUT = "/tmp/poche";
await mkdir(OUT, { recursive: true });

// Poché classification thresholds (device pt). A wall body is a long thin
// filled rectangle: thin in one axis, long in the other.
const THICK_MAX = 14; // wall poché short side: <= ~14pt (≈ up to ~9in at 18pt/ft)
const LONG_MIN = 24; // wall poché long side: >= 24pt (≈ 16in) so we skip tiny dots
const BLOB_MAX = 24; // both sides below this => text / symbol / furniture

interface MupdfPath {
  walk: (h: Record<string, (...args: number[]) => void>) => void;
}
function txp(ctm: number[], x: number, y: number): [number, number] {
  return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
}

const buf = await readFile(path.join(process.cwd(), FILE));
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
const page = doc.loadPage(PAGE - 1) as {
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

type Cls = "WALL_POCHE" | "BLOB" | "BIG" | "OTHER";
interface Fill {
  x0: number;
  y0: number;
  x1: number;
  y1: number; // bbox in pt (y-up)
  w: number;
  h: number;
  cls: Cls;
}
const fills: Fill[] = [];
// axial strokes for the parallel-pair tally
const axial: { x1: number; y1: number; x2: number; y2: number }[] = [];

function classify(w: number, h: number): Cls {
  const shortSide = Math.min(w, h);
  const longSide = Math.max(w, h);
  if (shortSide <= THICK_MAX && longSide >= LONG_MIN) return "WALL_POCHE";
  if (longSide <= BLOB_MAX) return "BLOB";
  if (shortSide >= 80 && longSide >= 80) return "BIG";
  return "OTHER";
}

function fillBBox(p: MupdfPath, ctm: number[]): Fill | null {
  let minx = Infinity,
    miny = Infinity,
    maxx = -Infinity,
    maxy = -Infinity,
    cx = 0,
    cy = 0,
    sx = 0,
    sy = 0,
    pts = 0;
  const see = (x: number, y: number) => {
    if (x < minx) minx = x;
    if (y < miny) miny = y;
    if (x > maxx) maxx = x;
    if (y > maxy) maxy = y;
    pts++;
  };
  p.walk({
    moveTo: (x: number, y: number) => {
      [cx, cy] = txp(ctm, x, y);
      sx = cx;
      sy = cy;
      see(cx, cy);
    },
    lineTo: (x: number, y: number) => {
      [cx, cy] = txp(ctm, x, y);
      see(cx, cy);
    },
    curveTo: (
      a: number,
      b: number,
      c: number,
      d: number,
      ex: number,
      ey: number,
    ) => {
      [cx, cy] = txp(ctm, ex, ey);
      see(cx, cy);
    },
    closePath: () => {
      cx = sx;
      cy = sy;
    },
  });
  if (pts < 2 || !isFinite(minx)) return null;
  const w = maxx - minx;
  const h = maxy - miny;
  return { x0: minx, y0: miny, x1: maxx, y1: maxy, w, h, cls: classify(w, h) };
}

function collectStroke(p: MupdfPath, ctm: number[]): void {
  let cx = 0,
    cy = 0,
    sx = 0,
    sy = 0;
  const emit = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    if (Math.hypot(dx, dy) < 5) return;
    if (dy < 1.5 && dx > 1.5) axial.push({ x1, y1, x2, y2: y1 });
    else if (dx < 1.5 && dy > 1.5) axial.push({ x1, y1, x2: x1, y2 });
  };
  p.walk({
    moveTo: (x: number, y: number) => {
      [cx, cy] = txp(ctm, x, y);
      sx = cx;
      sy = cy;
    },
    lineTo: (x: number, y: number) => {
      const [nx, ny] = txp(ctm, x, y);
      emit(cx, cy, nx, ny);
      cx = nx;
      cy = ny;
    },
    curveTo: () => {},
    closePath: () => {
      emit(cx, cy, sx, sy);
      cx = sx;
      cy = sy;
    },
  });
}

let fillOps = 0;
let strokeOps = 0;
const device = new mupdf.Device({
  fillPath: (p: MupdfPath, _e: unknown, ctm: number[]) => {
    fillOps++;
    const f = fillBBox(p, ctm);
    if (f) fills.push(f);
  },
  strokePath: (p: MupdfPath, _s: unknown, ctm: number[]) => {
    strokeOps++;
    collectStroke(p, ctm);
  },
});
page.run(device, mupdf.Matrix.identity);

const byCls = (c: Cls) => fills.filter((f) => f.cls === c);
const wallPoche = byCls("WALL_POCHE");
console.log(`\n=== ${FILE} page ${PAGE}  (${Wpt.toFixed(0)}×${Hpt.toFixed(0)}pt) ===`);
console.log(`fill ops: ${fillOps}, stroke ops: ${strokeOps}`);
console.log(`fills with a bbox: ${fills.length}`);
console.log(
  `  WALL_POCHE (thin+long): ${wallPoche.length}` +
    `\n  BLOB (small): ${byCls("BLOB").length}` +
    `\n  BIG (large): ${byCls("BIG").length}` +
    `\n  OTHER: ${byCls("OTHER").length}`,
);
if (wallPoche.length) {
  const thick = wallPoche
    .map((f) => Math.min(f.w, f.h))
    .sort((a, b) => a - b);
  const med = thick[Math.floor(thick.length / 2)];
  const totalLongPt = wallPoche.reduce((s, f) => s + Math.max(f.w, f.h), 0);
  console.log(
    `  WALL_POCHE short-side: min ${thick[0].toFixed(1)}, median ${med.toFixed(1)}, max ${thick[thick.length - 1].toFixed(1)} pt`,
  );
  console.log(
    `  WALL_POCHE total long-side length: ${totalLongPt.toFixed(0)} pt (${(totalLongPt / 18).toFixed(0)} ft @18pt/ft, before merging shared faces)`,
  );
}

// --- Parallel-pair tally on axial strokes (the other lever) ---
// Count horizontal segments that have a near-collinear partner 2..16pt away
// in y (a wall's two faces). Same for vertical in x. This is a coarse signal.
type Seg = { x1: number; y1: number; x2: number; y2: number };
const pairedSegs: Seg[] = [];
function parallelPairs(): { h: number; v: number } {
  const H = axial.filter((s) => s.y1 === s.y2);
  const V = axial.filter((s) => s.x1 === s.x2);
  let hp = 0;
  for (let i = 0; i < H.length; i++) {
    for (let j = i + 1; j < H.length; j++) {
      const dy = Math.abs(H[i].y1 - H[j].y1);
      if (dy < 2 || dy > 16) continue;
      // x-overlap
      const aL = Math.min(H[i].x1, H[i].x2),
        aR = Math.max(H[i].x1, H[i].x2);
      const bL = Math.min(H[j].x1, H[j].x2),
        bR = Math.max(H[j].x1, H[j].x2);
      const ov = Math.min(aR, bR) - Math.max(aL, bL);
      if (ov > 20) {
        hp++;
        pairedSegs.push(H[i]);
        break;
      }
    }
  }
  let vp = 0;
  for (let i = 0; i < V.length; i++) {
    for (let j = i + 1; j < V.length; j++) {
      const dx = Math.abs(V[i].x1 - V[j].x1);
      if (dx < 2 || dx > 16) continue;
      const aB = Math.min(V[i].y1, V[i].y2),
        aT = Math.max(V[i].y1, V[i].y2);
      const bB = Math.min(V[j].y1, V[j].y2),
        bT = Math.max(V[j].y1, V[j].y2);
      const ov = Math.min(aT, bT) - Math.max(aB, bB);
      if (ov > 20) {
        vp++;
        pairedSegs.push(V[i]);
        break;
      }
    }
  }
  return { h: hp, v: vp };
}
const pp = parallelPairs();
console.log(
  `\nparallel-pair signal (axial strokes with a partner 2-16pt away):` +
    `\n  horizontal segs with a parallel partner: ${pp.h}` +
    `\n  vertical segs with a parallel partner:   ${pp.v}` +
    `\n  (axial strokes total: ${axial.length})`,
);

// --- Render fills color-coded by class ---
const pix = page.toPixmap([SCALE, 0, 0, SCALE, 0, 0], mupdf.ColorSpace.DeviceRGB);
const Wpx = pix.getWidth();
const Hpx = pix.getHeight();
const pngBuf = pix.asPNG();
const px = (x: number) => x * SCALE;
const py = (y: number) => Hpx - y * SCALE;
const COLOR: Record<Cls, string> = {
  WALL_POCHE: "#e6194b",
  BLOB: "#bbbbbb",
  BIG: "#3cb44b",
  OTHER: "#4363d8",
};

function rectSvg(list: Fill[], only?: Cls): string {
  const parts: string[] = [];
  for (const f of list) {
    if (only && f.cls !== only) continue;
    const x = px(f.x0);
    const y = py(f.y1); // top
    const w = (f.x1 - f.x0) * SCALE;
    const h = (f.y1 - f.y0) * SCALE;
    parts.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${COLOR[f.cls]}" fill-opacity="0.45" stroke="${COLOR[f.cls]}" stroke-width="0.6"/>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Wpx}" height="${Hpx}">${parts.join("")}</svg>`;
}

await sharp(pngBuf)
  .composite([{ input: Buffer.from(rectSvg(fills)), top: 0, left: 0 }])
  .toFile(`${OUT}/p${PAGE}-fills-all.png`);
await sharp(pngBuf)
  .composite([{ input: Buffer.from(rectSvg(fills, "WALL_POCHE")), top: 0, left: 0 }])
  .toFile(`${OUT}/p${PAGE}-fills-wallpoche.png`);

// Render parallel-pair (double-line wall-face) segments.
const pairParts: string[] = pairedSegs.map(
  (s) =>
    `<line x1="${px(s.x1).toFixed(1)}" y1="${py(s.y1).toFixed(1)}" x2="${px(s.x2).toFixed(1)}" y2="${py(s.y2).toFixed(1)}" stroke="#e6194b" stroke-width="2.5" opacity="0.85"/>`,
);
const pairSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Wpx}" height="${Hpx}">${pairParts.join("")}</svg>`;
await sharp(pngBuf)
  .composite([{ input: Buffer.from(pairSvg), top: 0, left: 0 }])
  .toFile(`${OUT}/p${PAGE}-parallel-pairs.png`);

console.log(
  `\nwrote ${OUT}/p${PAGE}-fills-all.png, p${PAGE}-fills-wallpoche.png, p${PAGE}-parallel-pairs.png (${Wpx}×${Hpx})`,
);
