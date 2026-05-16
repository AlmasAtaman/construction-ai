// Run the vector room extractor on a PDF and report what we find.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pdfPath = process.argv[2] ?? path.resolve(
  __dirname,
  "../tests/fixtures/commercial-bench.pdf",
);
const pageNumber = parseInt(process.argv[3] ?? "1", 10);

// Use ts-node-ish: inline the extractor logic since we can't import .ts
// from a .mjs without a transform. Re-implement using the same API.
const mupdf = await import("mupdf");
const data = readFileSync(pdfPath);
const doc = mupdf.Document.openDocument(new Uint8Array(data), "application/pdf");
const page = doc.loadPage(pageNumber - 1);
const bounds = page.getBounds();
console.log("Page bounds:", bounds);

const COORD_TOL = 1.5;
const MIN_WALL_LEN_PT = 5;
const MIN_ROOM_AREA_PT = 5000;
const MAX_ROOM_AREA_PT = 5_000_000;

const segments = [];
function emit(curX, curY, x, y, list) {
  const dx = Math.abs(x - curX);
  const dy = Math.abs(y - curY);
  const len = Math.hypot(dx, dy);
  if (len < MIN_WALL_LEN_PT) return;
  if (dy < COORD_TOL && dx > COORD_TOL) {
    list.push({ x1: curX, y1: curY, x2: x, y2: y, o: "h", length: dx });
  } else if (dx < COORD_TOL && dy > COORD_TOL) {
    list.push({ x1: curX, y1: curY, x2: x, y2: y, o: "v", length: dy });
  }
}

function collect(path, ctm, isStroke) {
  if (!isStroke) return;
  let curX = 0, curY = 0, startX = 0, startY = 0;
  function tx(x, y) {
    return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
  }
  path.walk({
    moveTo: (x, y) => {
      [curX, curY] = tx(x, y);
      startX = curX;
      startY = curY;
    },
    lineTo: (x, y) => {
      const [nx, ny] = tx(x, y);
      emit(curX, curY, nx, ny, segments);
      curX = nx;
      curY = ny;
    },
    closePath: () => {
      emit(curX, curY, startX, startY, segments);
      curX = startX;
      curY = startY;
    },
  });
}

const dev = new mupdf.Device({
  fillPath: (path, _, ctm) => collect(path, ctm, false),
  strokePath: (path, _, ctm) => collect(path, ctm, true),
});
page.run(dev, mupdf.Matrix.identity);

console.log("Total wall-candidate segments:", segments.length);

// Detect rectangles
const horizontals = segments.filter((s) => s.o === "h");
const verticals = segments.filter((s) => s.o === "v");
const hByY = new Map();
for (const h of horizontals) {
  const y = Math.round(h.y1 / COORD_TOL) * COORD_TOL;
  if (!hByY.has(y)) hByY.set(y, []);
  hByY.get(y).push(h);
}
const vByX = new Map();
for (const v of verticals) {
  const x = Math.round(v.x1 / COORD_TOL) * COORD_TOL;
  if (!vByX.has(x)) vByX.set(x, []);
  vByX.get(x).push(v);
}

function findVerticalAt(x, yTop, yBot) {
  for (let dx = -COORD_TOL; dx <= COORD_TOL; dx += COORD_TOL) {
    const bucket = Math.round((x + dx) / COORD_TOL) * COORD_TOL;
    const lines = vByX.get(bucket);
    if (!lines) continue;
    for (const v of lines) {
      const vMin = Math.min(v.y1, v.y2);
      const vMax = Math.max(v.y1, v.y2);
      if (vMin <= yTop + COORD_TOL && vMax >= yBot - COORD_TOL) return v;
    }
  }
  return null;
}

const rects = [];
const seen = new Set();
const hYs = [...hByY.keys()].sort((a, b) => a - b);
for (let i = 0; i < hYs.length; i++) {
  const yTop = hYs[i];
  const topLines = hByY.get(yTop);
  for (let j = i + 1; j < hYs.length; j++) {
    const yBot = hYs[j];
    if (yBot - yTop < 20) continue;
    const botLines = hByY.get(yBot);
    for (const t of topLines) {
      const tMin = Math.min(t.x1, t.x2);
      const tMax = Math.max(t.x1, t.x2);
      for (const b of botLines) {
        const bMin = Math.min(b.x1, b.x2);
        const bMax = Math.max(b.x1, b.x2);
        const xLo = Math.max(tMin, bMin);
        const xHi = Math.min(tMax, bMax);
        if (xHi - xLo < 20) continue;
        if (!findVerticalAt(xLo, yTop, yBot)) continue;
        if (!findVerticalAt(xHi, yTop, yBot)) continue;
        const key = `${Math.round(xLo)}-${Math.round(yTop)}-${Math.round(xHi)}-${Math.round(yBot)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const w = xHi - xLo;
        const h = yBot - yTop;
        const area = w * h;
        if (area < MIN_ROOM_AREA_PT) continue;
        if (area > MAX_ROOM_AREA_PT) continue;
        rects.push({ x: xLo, y: yTop, width: w, height: h, areaPt: area });
      }
    }
  }
}
rects.sort((a, b) => b.areaPt - a.areaPt);

// Drop dominated rectangles
const kept = [];
for (const r of rects) {
  let dominated = false;
  for (const k of kept) {
    if (
      r.x >= k.x - COORD_TOL &&
      r.y >= k.y - COORD_TOL &&
      r.x + r.width <= k.x + k.width + COORD_TOL &&
      r.y + r.height <= k.y + k.height + COORD_TOL
    ) {
      dominated = true;
      break;
    }
  }
  if (!dominated) kept.push(r);
}

console.log(`\nDetected ${kept.length} room rectangles (sorted by area):`);
for (const r of kept.slice(0, 25)) {
  // Assume scale: 1 PDF inch = 96 points = (depends on plan). Without a
  // scale anchor we can't convert to sqft yet, but report relative size.
  console.log(
    `  ${r.width.toFixed(0).padStart(5)} × ${r.height.toFixed(0).padStart(5)} pt  (${Math.round(r.areaPt)} pt²)  at (${r.x.toFixed(0)}, ${r.y.toFixed(0)})`,
  );
}
