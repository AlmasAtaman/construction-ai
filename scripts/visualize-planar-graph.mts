// Visualize planar-graph extraction by writing an SVG showing:
//   - All wall segments (thin gray lines)
//   - Detected room polygons (semi-transparent fills + outlines)
//   - Text labels (red dots at label positions, with label text)
// This lets us SEE what's being detected vs what we expect.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const mupdf = await import("mupdf");
const planarGraph = await import("../src/lib/planar-graph.ts");
const { detectRooms } = planarGraph;
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const pdfPath =
  process.argv[2] ??
  path.resolve(__dirname, "../tests/fixtures/commercial-bench.pdf");
const pageNumber = parseInt(process.argv[3] ?? "1", 10);
const outPath = path.resolve(__dirname, "../planar-debug.svg");

const data = readFileSync(pdfPath);
const doc = mupdf.Document.openDocument(new Uint8Array(data), "application/pdf");
const mupdfPage = doc.loadPage(pageNumber - 1);
const bounds = mupdfPage.getBounds();
const pageW = bounds[2] - bounds[0];
const pageH = bounds[3] - bounds[1];

const COORD_TOL = 1.5;
const MIN_WALL_LEN = 5;
type Seg = { x1: number; y1: number; x2: number; y2: number };
const segments: Seg[] = [];

function tx(ctm: number[], x: number, y: number): [number, number] {
  return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
}
interface MP {
  walk: (v: {
    moveTo: (x: number, y: number) => void;
    lineTo: (x: number, y: number) => void;
    closePath: () => void;
  }) => void;
}
function emit(x1: number, y1: number, x2: number, y2: number): void {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  if (Math.hypot(dx, dy) < MIN_WALL_LEN) return;
  if (dy < COORD_TOL && dx > COORD_TOL) segments.push({ x1, y1, x2, y2: y1 });
  else if (dx < COORD_TOL && dy > COORD_TOL) segments.push({ x1, y1, x2: x1, y2 });
}
function collect(p: MP, ctm: number[]): void {
  let cx = 0, cy = 0, sx = 0, sy = 0;
  p.walk({
    moveTo: (x, y) => { [cx, cy] = tx(ctm, x, y); sx = cx; sy = cy; },
    lineTo: (x, y) => { const [nx, ny] = tx(ctm, x, y); emit(cx, cy, nx, ny); cx = nx; cy = ny; },
    closePath: () => { emit(cx, cy, sx, sy); cx = sx; cy = sy; },
  });
}
const dev = new (mupdf as unknown as { Device: new (o: object) => unknown }).Device({
  fillPath: (p: MP, _: unknown, ctm: number[]) => collect(p, ctm),
  strokePath: (p: MP, _: unknown, ctm: number[]) => collect(p, ctm),
});
(mupdfPage as unknown as { run: (d: unknown, m: number[]) => void }).run(
  dev,
  (mupdf as unknown as { Matrix: { identity: number[] } }).Matrix.identity,
);

const rooms = detectRooms(segments, pageW, pageH, {
  snapTolerance: 1.5,
  minRoomArea: 3000,
  maxRoomArea: 0.85 * pageW * pageH,
  maxAspectRatio: 30,
  maxVertices: 30,
});

// Text fragments
const pdfDoc = await pdfjs.getDocument({
  data: new Uint8Array(data),
  isEvalSupported: false,
}).promise;
const pdfPage = await pdfDoc.getPage(pageNumber);
const tc = await pdfPage.getTextContent();
const fragments = (tc.items as { str: string; transform: number[] }[])
  .filter((it) => it.str.trim().length > 0)
  .map((it) => ({
    text: it.str.trim(),
    x: it.transform[4],
    y: it.transform[5],
  }));

// SVG: y-axis-flip so it displays as a normal page (PDF user space has y up).
function svgY(y: number): number {
  return pageH - y;
}

const rng = (seed: number) => {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
};
const r = rng(42);
const palette: string[] = [];
for (let i = 0; i < 200; i++) {
  const h = Math.floor(r() * 360);
  palette.push(`hsl(${h}, 60%, 60%)`);
}

const parts: string[] = [];
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pageW} ${pageH}" font-family="sans-serif">`);
parts.push(`<rect width="${pageW}" height="${pageH}" fill="white"/>`);

// Wall segments
for (const s of segments) {
  parts.push(
    `<line x1="${s.x1.toFixed(1)}" y1="${svgY(s.y1).toFixed(1)}" x2="${s.x2.toFixed(1)}" y2="${svgY(s.y2).toFixed(1)}" stroke="#bbb" stroke-width="0.7"/>`,
  );
}

// Room polygons
rooms.forEach((rm, i) => {
  const pts = rm.polygon.map((p) => `${p.x.toFixed(1)},${svgY(p.y).toFixed(1)}`).join(" ");
  const color = palette[i % palette.length];
  parts.push(
    `<polygon points="${pts}" fill="${color}" fill-opacity="0.30" stroke="${color}" stroke-width="1.5"/>`,
  );
  const cx = (rm.bbox.x0 + rm.bbox.x1) / 2;
  const cy = (rm.bbox.y0 + rm.bbox.y1) / 2;
  parts.push(
    `<text x="${cx.toFixed(0)}" y="${svgY(cy).toFixed(0)}" font-size="14" fill="black" text-anchor="middle" font-weight="bold">${i}</text>`,
  );
});

// Text labels (only show notable ones)
const NOTABLE = /CORRIDOR|OXYGEN|STORAGE|LOBBY|LINK|ROOM|OFFICE|STAIR|ELEV|MECH|ELECTRICAL/i;
for (const f of fragments) {
  if (!NOTABLE.test(f.text)) continue;
  parts.push(
    `<circle cx="${f.x.toFixed(0)}" cy="${svgY(f.y).toFixed(0)}" r="3" fill="red"/>`,
  );
  parts.push(
    `<text x="${(f.x + 5).toFixed(0)}" y="${svgY(f.y).toFixed(0)}" font-size="10" fill="darkred">${f.text}</text>`,
  );
}

parts.push(`</svg>`);
writeFileSync(outPath, parts.join("\n"));
console.log(`Wrote ${outPath}`);
console.log(`  ${segments.length} wall segments`);
console.log(`  ${rooms.length} polygons`);
console.log(`  ${fragments.filter((f) => NOTABLE.test(f.text)).length} notable labels`);
