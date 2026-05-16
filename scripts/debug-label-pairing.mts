// For each ground-truth room label, find the nearest polygon and report
// whether the label is INSIDE the polygon or outside (and how far).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const mupdf = await import("mupdf");
const planarGraph = await import("../src/lib/planar-graph.ts");
const { detectRooms } = planarGraph;
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const pdfPath = path.resolve(__dirname, "../tests/fixtures/commercial-bench.pdf");
const data = readFileSync(pdfPath);
const doc = mupdf.Document.openDocument(new Uint8Array(data), "application/pdf");
const mupdfPage = doc.loadPage(0);
const bounds = mupdfPage.getBounds();
const pageW = bounds[2] - bounds[0];
const pageH = bounds[3] - bounds[1];

type Seg = { x1: number; y1: number; x2: number; y2: number };
const segments: Seg[] = [];
function tx(ctm: number[], x: number, y: number): [number, number] {
  return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
}
interface MP {
  walk: (v: { moveTo: (x: number, y: number) => void; lineTo: (x: number, y: number) => void; closePath: () => void }) => void;
}
function emit(x1: number, y1: number, x2: number, y2: number): void {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  if (Math.hypot(dx, dy) < 5) return;
  if (dy < 1.5 && dx > 1.5) segments.push({ x1, y1, x2, y2: y1 });
  else if (dx < 1.5 && dy > 1.5) segments.push({ x1, y1, x2: x1, y2 });
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

const pdfDoc = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
const pdfPage = await pdfDoc.getPage(1);
const tc = await pdfPage.getTextContent();
const fragments = (tc.items as { str: string; transform: number[] }[])
  .filter((it) => it.str.trim().length > 0)
  .map((it) => ({ text: it.str.trim(), x: it.transform[4], y: it.transform[5] }));

function pointInPolygon(p: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    const intersect = (yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// For each ground truth label, find nearest polygon
const targets = ["CORRIDOR", "OXYGEN", "STORAGE", "LOBBY", "LINK"];
console.log(`Polygons: ${rooms.length}, page ${pageW}×${pageH}`);
for (const t of targets) {
  const matches = fragments.filter((f) => f.text.toUpperCase().includes(t.toUpperCase()));
  console.log(`\n"${t}":`);
  for (const m of matches.slice(0, 3)) {
    const insideRooms: number[] = [];
    let nearestRoom = -1;
    let nearestDist = Infinity;
    rooms.forEach((r, i) => {
      if (pointInPolygon({ x: m.x, y: m.y }, r.polygon)) insideRooms.push(i);
      const cx = (r.bbox.x0 + r.bbox.x1) / 2;
      const cy = (r.bbox.y0 + r.bbox.y1) / 2;
      const d = Math.hypot(cx - m.x, cy - m.y);
      if (d < nearestDist) { nearestDist = d; nearestRoom = i; }
    });
    const r = rooms[nearestRoom];
    console.log(
      `  "${m.text}" at (${m.x.toFixed(0)}, ${m.y.toFixed(0)}) — inside: [${insideRooms.join(",")}], nearest=#${nearestRoom} dist=${nearestDist.toFixed(0)} bbox=(${r.bbox.x0.toFixed(0)},${r.bbox.y0.toFixed(0)})..(${r.bbox.x1.toFixed(0)},${r.bbox.y1.toFixed(0)})`,
    );
  }
}
