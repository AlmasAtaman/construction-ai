/**
 * Read-only: since stroke width does NOT separate walls from noise on
 * this plan, test the next lever — do the walls ENCLOSE rooms? If the
 * existing room detector finds sensible faces, their boundaries are the
 * walls (furniture / dimensions / text don't form rooms), and we can
 * trace those instead of all line-work.
 *
 * Runs detectRooms (the existing axis-aligned planar-graph) on page 5's
 * H/V walls and reports face count + areas in sqft (at 18 pt/ft).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { detectRooms } from "../src/lib/planar-graph.js";

const FILE = process.argv[2] ?? "tests/fixtures/friend-commercial-plan.pdf";
const PAGE = parseInt(process.argv[3] ?? "5", 10);
const PT_PER_FT = parseFloat(process.argv[4] ?? "18");

const buf = await readFile(path.join(process.cwd(), FILE));
const mupdf = (await import("mupdf")) as unknown as {
  Document: { openDocument: (b: Uint8Array, m: string) => unknown };
  Device: new (h: Record<string, unknown>) => unknown;
  Matrix: { identity: number[] };
};
const doc = mupdf.Document.openDocument(
  new Uint8Array(buf),
  "application/pdf",
) as { loadPage: (i: number) => unknown };
const page = doc.loadPage(PAGE - 1) as {
  getBounds: () => number[];
  run: (d: unknown, m: number[]) => void;
};
const b = page.getBounds();
const W = b[2] - b[0];
const H = b[3] - b[1];

function txp(ctm: number[], x: number, y: number): [number, number] {
  return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
}
const walls: { x1: number; y1: number; x2: number; y2: number }[] = [];
function emit(x1: number, y1: number, x2: number, y2: number): void {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  const len = Math.hypot(dx, dy);
  if (len < 5) return;
  if (dy < 1.5 && dx > 1.5) walls.push({ x1, y1, x2, y2: y1 });
  else if (dx < 1.5 && dy > 1.5) walls.push({ x1, y1, x2: x1, y2 });
}
interface MupdfPath {
  walk: (h: Record<string, (...args: number[]) => void>) => void;
}
function collect(p: MupdfPath, ctm: number[]): void {
  let cx = 0,
    cy = 0,
    sx = 0,
    sy = 0;
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
const device = new mupdf.Device({
  fillPath: (p: MupdfPath, _: unknown, ctm: number[]) => collect(p, ctm),
  strokePath: (p: MupdfPath, _: unknown, ctm: number[]) => collect(p, ctm),
});
page.run(device, mupdf.Matrix.identity);

const faces = detectRooms(walls, W, H, {});
console.log(`\n=== ${FILE} page ${PAGE} ===`);
console.log(`H/V wall segments: ${walls.length}`);
console.log(`room faces detected: ${faces.length}`);
const sqft = faces
  .map((f) => f.area / (PT_PER_FT * PT_PER_FT))
  .sort((a, b) => b - a);
console.log(
  `face areas (sqft @ ${PT_PER_FT}pt/ft): ${sqft.map((s) => s.toFixed(0)).join(", ")}`,
);
const total = sqft.reduce((s, a) => s + a, 0);
console.log(`total enclosed area: ${total.toFixed(0)} sqft`);
