// Validate label-anchored room expansion against the VA commercial benchmark.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mupdf = await import("mupdf");
const re = await import("../src/lib/room-expand.ts");
const { expandRoomsFromLabels } = re;
const iw = await import("../src/lib/image-walls.ts");
const { detectWallsFromImage } = iw;
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const pdfPath = path.resolve(__dirname, "../tests/fixtures/commercial-bench.pdf");
const truthPath = path.resolve(__dirname, "../tests/fixtures/commercial-bench-ground-truth.json");
const data = readFileSync(pdfPath);
const truth = JSON.parse(readFileSync(truthPath, "utf8")) as {
  pages: { pageNumber: number; rooms: { label: string; matchKeys: string[]; trueFloorAreaSqft: number }[] }[];
};
const gt = truth.pages.find((p) => p.pageNumber === 1)!.rooms;

// ── 1. Wall segments via mupdf ──────────────────────────────────────────
const doc = mupdf.Document.openDocument(new Uint8Array(data), "application/pdf");
const mPage = doc.loadPage(0);
const bounds = mPage.getBounds();
const pageW = bounds[2] - bounds[0];
const pageH = bounds[3] - bounds[1];

type Seg = { x1: number; y1: number; x2: number; y2: number };
const walls: Seg[] = [];
const doorBarriers: { x: number; y: number; size: number }[] = [];

function tx(ctm: number[], x: number, y: number): [number, number] {
  return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
}
interface MP {
  walk: (v: {
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
  if (len < 2) return; // keep short segments — small rooms have them
  walls.push({ x1, y1, x2, y2 });
  // Diagonal lines at door-panel scale = door indicator. Record so we
  // paint a barrier at this location to close the door opening.
  if (len >= 18 && len <= 45 && Math.abs(dx) > 2 && Math.abs(dy) > 2) {
    doorBarriers.push({ x: (x1 + x2) / 2, y: (y1 + y2) / 2, size: len });
  }
}
function collect(p: MP, ctm: number[]): void {
  let cx = 0, cy = 0, sx = 0, sy = 0;
  p.walk({
    moveTo: (x, y) => { [cx, cy] = tx(ctm, x, y); sx = cx; sy = cy; },
    lineTo: (x, y) => { const [nx, ny] = tx(ctm, x, y); emit(cx, cy, nx, ny); cx = nx; cy = ny; },
    curveTo: (c1x, c1y, c2x, c2y, ex, ey) => {
      // Approximate the curve with chord segments for rasterization.
      const [a1x, a1y] = tx(ctm, c1x, c1y);
      const [a2x, a2y] = tx(ctm, c2x, c2y);
      const [aex, aey] = tx(ctm, ex, ey);
      // 4-step subdivision of cubic Bezier
      const steps = 4;
      let px = cx, py = cy;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const mt = 1 - t;
        const bx = mt * mt * mt * cx + 3 * mt * mt * t * a1x + 3 * mt * t * t * a2x + t * t * t * aex;
        const by = mt * mt * mt * cy + 3 * mt * mt * t * a1y + 3 * mt * t * t * a2y + t * t * t * aey;
        emit(px, py, bx, by);
        px = bx;
        py = by;
      }
      // Record curve as a door barrier if its bounding box is door-sized.
      const minX = Math.min(cx, a1x, a2x, aex);
      const maxX = Math.max(cx, a1x, a2x, aex);
      const minY = Math.min(cy, a1y, a2y, aey);
      const maxY = Math.max(cy, a1y, a2y, aey);
      const extent = Math.max(maxX - minX, maxY - minY);
      if (extent >= 18 && extent <= 45) {
        doorBarriers.push({ x: (minX + maxX) / 2, y: (minY + maxY) / 2, size: extent });
      }
      cx = aex;
      cy = aey;
    },
    closePath: () => { emit(cx, cy, sx, sy); cx = sx; cy = sy; },
  });
}
const dev = new (mupdf as unknown as { Device: new (o: object) => unknown }).Device({
  fillPath: (p: MP, _: unknown, ctm: number[]) => collect(p, ctm),
  strokePath: (p: MP, _: unknown, ctm: number[]) => collect(p, ctm),
});
(mPage as unknown as { run: (d: unknown, m: number[]) => void }).run(
  dev, (mupdf as unknown as { Matrix: { identity: number[] } }).Matrix.identity,
);
console.log(`Page: ${pageW}×${pageH}, vector walls: ${walls.length}`);

// ── Need text fragments for the text mask. Extract early. ────────────
const pdfDocForText = await pdfjs.getDocument({
  data: new Uint8Array(data),
  isEvalSupported: false,
}).promise;
const pdfPageForText = await pdfDocForText.getPage(1);
const tcEarly = await pdfPageForText.getTextContent();
const textBoxes = (tcEarly.items as { str: string; transform: number[]; width: number; height: number }[])
  .filter((it) => it.str.trim().length > 0)
  .map((it) => ({
    // pdfjs gives transform[4]=x (left), transform[5]=y (baseline in PDF user space)
    // For our box (Y up), the box bottom is roughly y - 0.2*height (descender), top is y + height.
    x: it.transform[4],
    y: it.transform[5] - it.height * 0.2,
    width: it.width || it.transform[0] * it.str.length,
    height: it.height * 1.2,
  }));

// ── 1b. Image-based wall detection ─────────────────────────────────────
// Recovers walls embedded in rasterized PDF backgrounds (fillImage
// operations) that aren't visible in the vector layer. Text bboxes are
// masked out so labels/dimensions don't get classified as walls.
const imgWalls = await detectWallsFromImage(Buffer.from(data), 1, {
  dpi: 150,
  threshold: 140,
  minWallPx: 24,
  minWallThickness: 2,
  textBoxes,
});
for (const s of imgWalls.segments) {
  walls.push({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 });
}
console.log(`Image walls: ${imgWalls.segments.length} (${imgWalls.elapsedMs}ms, text-masked ${textBoxes.length})`);
console.log(`Total walls: ${walls.length}`);

// ── 2. Text fragments → candidate room labels ──────────────────────────
const pdfDoc = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
const pdfPage = await pdfDoc.getPage(1);
const tc = await pdfPage.getTextContent();
const allFrags = (tc.items as { str: string; transform: number[] }[])
  .filter((it) => it.str.trim().length > 0)
  .map((it) => ({ text: it.str.trim(), x: it.transform[4], y: it.transform[5], fontSize: Math.abs(it.transform[3] || 8) }));
console.log(`Text fragments: ${allFrags.length}`);

// Plausible room-label filter: must contain a room-name keyword OR a
// room-number pattern. Exclude obvious non-labels (material codes,
// dimension callouts, note numbers, title-block keywords).
const ROOM_KW = /\b(ROOM|CORRIDOR|OFFICE|STAIR|ELEV|LOBBY|STORAGE|STORE|OXYGEN|BATH|RESTROOM|TOILET|MECH|ELECTRICAL|JANITOR|KITCHEN|LOCKER|VEST|LOUNGE|WAIT|PANTRY|CLOSET|UTILITY|SOIL|CLEAN|SOILED|LINEN|EXAM|CONF|RECEPTION|STAFF|PATIENT|NOURISH|ALCOVE|VESTIBULE|LINK|CONNECTING|VOLTAGE|VEND)\b/i;
const ROOM_NUM = /^[A-Z]{0,3}\s*\d{2,4}[A-Z]?$/i; // "169", "134A", "CE-3", etc.
const ROOM_CODE = /^[A-Z]{1,3}-?\d{1,3}[A-Z]?$/i; // "CE-3"
const EXCLUDE = /\b(SF|SQFT|TYP|DET|DETAIL|NOTE|NOTES|SEE|ALIGN|VIF|REF|SECTION|ELEVATION|PLAN|DRAWING|SHEET|SCALE|TITLE|STAMP|REVISION|PROJECT|ARCHITECT|ENGINEER|CONSULTANT|FINISH|SCHEDULE|GENERAL|LEGEND|KEY|SYMBOL|CODE|NAVIGATION|DEPARTMENT|VETERANS)\b/i;
const DIM_CALLOUT = /^\d+(['"’”′″]|\s*(SF|sqft))/;
const NOTE_BULLET = /^\d{1,2}\.$/;

function isLikelyRoomLabel(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  if (NOTE_BULLET.test(t)) return false;
  if (DIM_CALLOUT.test(t)) return false;
  if (EXCLUDE.test(t)) return false;
  if (ROOM_KW.test(t)) return true;
  if (ROOM_NUM.test(t)) return true;
  if (ROOM_CODE.test(t)) return true;
  return false;
}

// Seed plausible room labels only. No font filter — let isLikelyRoomLabel
// handle it.
const allLikely = allFrags.filter((f) => isLikelyRoomLabel(f.text));
console.log(`Plausible (text-filtered) labels: ${allLikely.length}`);

// Cluster nearby room-labels into one seed per room. Room labels are
// stacked vertically ~10-15pt apart ("ROOM" / "134A" / "16 SF"). Labels
// from adjacent rooms are >30pt apart. CLUSTER_DIST=18 splits the two.
const CLUSTER_DIST = 25;
const clusterDistSq = CLUSTER_DIST * CLUSTER_DIST;
const parent = allLikely.map((_, i) => i);
function find(i: number): number {
  let r = i;
  while (parent[r] !== r) r = parent[r];
  while (parent[i] !== r) {
    const n = parent[i];
    parent[i] = r;
    i = n;
  }
  return r;
}
for (let i = 0; i < allLikely.length; i++) {
  for (let j = i + 1; j < allLikely.length; j++) {
    const dx = allLikely[i].x - allLikely[j].x;
    const dy = allLikely[i].y - allLikely[j].y;
    if (dx * dx + dy * dy <= clusterDistSq) {
      const ri = find(i), rj = find(j);
      if (ri !== rj) parent[ri] = rj;
    }
  }
}
const clusterMap = new Map<number, { x: number; y: number; texts: string[]; cnt: number }>();
for (let i = 0; i < allLikely.length; i++) {
  const r = find(i);
  const c = clusterMap.get(r) ?? { x: 0, y: 0, texts: [], cnt: 0 };
  c.x += allLikely[i].x;
  c.y += allLikely[i].y;
  c.texts.push(allLikely[i].text);
  c.cnt++;
  clusterMap.set(r, c);
}
const labels = [...clusterMap.entries()].map(([_, c], i) => ({
  id: `${i}`,
  x: c.x / c.cnt,
  y: c.y / c.cnt,
  text: c.texts.join(" "),
}));
console.log(`Plausible labels: ${allLikely.length} → clustered to ${labels.length} (tight ${CLUSTER_DIST}pt)`);

// For GT scoring: which cluster ID corresponds to which GT room?
function gtIdxForLabel(text: string): number {
  const tl = text.toLowerCase();
  for (let i = 0; i < gt.length; i++) {
    if (gt[i].matchKeys.some((k) => tl.includes(k.toLowerCase()))) return i;
  }
  return -1;
}
const labelGtIdx = new Map<string, number>();
labels.forEach((l) => labelGtIdx.set(l.id, gtIdxForLabel(l.text)));

// ── 3. Expand ───────────────────────────────────────────────────────────
const t0 = Date.now();
console.log(`Door barriers: ${doorBarriers.length}`);
const rooms = expandRoomsFromLabels(
  walls,
  labels.map((l) => ({ id: l.id, x: l.x, y: l.y })),
  pageW,
  pageH,
  {
    cellSize: 3,
    minCells: 50,
    wallThickness: 1,
    doorBarriers,
  },
);
console.log(`Expanded ${rooms.length} rooms in ${Date.now() - t0} ms`);

// ── 4. Match: each GT room is the LARGEST expanded region anchored to
// any label that maps to that GT room.
const gtArea = new Map<number, number>();
const gtBbox = new Map<number, { x: number; y: number; w: number; h: number }>();
for (const r of rooms) {
  const gi = labelGtIdx.get(r.labelId);
  if (gi == null || gi < 0) continue;
  const cur = gtArea.get(gi) ?? 0;
  if (r.areaPt > cur) {
    gtArea.set(gi, r.areaPt);
    gtBbox.set(gi, { x: r.bbox.x, y: r.bbox.y, w: r.bbox.width, h: r.bbox.height });
  }
}

console.log(`\nGT match (largest region per GT room):`);
let matched = 0;
for (let i = 0; i < gt.length; i++) {
  const a = gtArea.get(i);
  if (a == null) {
    // Diagnostics: which clusters mapped to this GT?
    const clusters: string[] = [];
    for (const [id, gi] of labelGtIdx) {
      if (gi === i) {
        const l = labels.find((ll) => ll.id === id);
        if (l) clusters.push(`#${l.id}@(${l.x.toFixed(0)},${l.y.toFixed(0)}) "${l.text.slice(0, 200)}"`);
      }
    }
    console.log(`  ✗ ${gt[i].label.padEnd(35)} — no expanded region; clusters=${clusters.length}: ${clusters.slice(0, 2).join(", ")}`);
  } else {
    matched++;
    const b = gtBbox.get(i)!;
    console.log(`  ✓ ${gt[i].label.padEnd(35)} → ${Math.round(a)} pt² (bbox ${b.w.toFixed(0)}×${b.h.toFixed(0)})  truth: ${gt[i].trueFloorAreaSqft} sqft`);
  }
}
console.log(`\n${matched}/${gt.length} GT rooms expanded`);

// ── 5. Scale calibration: if all GT rooms have areas, infer pt→sqft.
// At 1/8":1' scale, 1 sqft = 81 pt². Print implied scales.
const ratios: number[] = [];
for (let i = 0; i < gt.length; i++) {
  const a = gtArea.get(i);
  if (a == null) continue;
  const ptPerSqft = a / gt[i].trueFloorAreaSqft;
  ratios.push(ptPerSqft);
}
ratios.sort((a, b) => a - b);
if (ratios.length > 0) {
  const median = ratios[Math.floor(ratios.length / 2)];
  console.log(`\nImplied pt² per sqft (median): ${median.toFixed(0)}`);
  console.log(`  → 1 sqft ≈ ${Math.sqrt(median).toFixed(1)} pt linear`);
  console.log(`  → expected at 1/8":1' = 81 pt²/sqft (9 pt linear)`);
}
