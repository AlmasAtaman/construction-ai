/**
 * Read-only probe: do walls separate from furniture / dimensions / text
 * by STROKE WIDTH on the commercial wall plan (page 5)?
 *
 * MuPDF's strokePath device callback hands us the StrokeState (we
 * currently ignore it). We capture each stroked segment's line width
 * (scaled to device pt by the CTM) plus its length, then histogram
 * line widths overall and split by length band (long ≥ 50pt = likely
 * wall, short < 50pt = likely noise). Also tallies fill vs stroke ops.
 *
 * Writes nothing. Prints the histograms.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const FILE =
  process.argv[2] ?? "tests/fixtures/friend-commercial-plan.pdf";
const PAGE = parseInt(process.argv[3] ?? "5", 10);

const buf = await readFile(path.join(process.cwd(), FILE));
const mupdf = await import("mupdf");
const doc = mupdf.Document.openDocument(new Uint8Array(buf), "application/pdf");
const page = doc.loadPage(PAGE - 1);

function tx(ctm, x, y) {
  return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
}
// Uniform-ish scale factor of a CTM (geometric mean of the 2x2 part).
function ctmScale(ctm) {
  const det = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
  return Math.sqrt(det) || 1;
}

let fillOps = 0;
let strokeOps = 0;
let dumpedStroke = 0;

// Per-segment records: { len, width }
const segs = [];

function readLineWidth(stroke) {
  if (stroke == null) return null;
  // mupdf.js StrokeState: try common shapes.
  if (typeof stroke === "object") {
    if (typeof stroke.lineWidth === "number") return stroke.lineWidth;
    if (typeof stroke.getLineWidth === "function") {
      try {
        return stroke.getLineWidth();
      } catch {
        /* fall through */
      }
    }
  }
  return null;
}

function walkPath(p, ctm, lineWidth) {
  const scale = ctmScale(ctm);
  const wPt = lineWidth != null ? lineWidth * scale : null;
  let cx = 0,
    cy = 0,
    sx = 0,
    sy = 0;
  p.walk({
    moveTo: (x, y) => {
      [cx, cy] = tx(ctm, x, y);
      sx = cx;
      sy = cy;
    },
    lineTo: (x, y) => {
      const [nx, ny] = tx(ctm, x, y);
      const len = Math.hypot(nx - cx, ny - cy);
      if (len >= 5) segs.push({ len, width: wPt });
      cx = nx;
      cy = ny;
    },
    curveTo: (a, b, c, d, ex, ey) => {
      [cx, cy] = tx(ctm, ex, ey);
    },
    closePath: () => {
      const len = Math.hypot(sx - cx, sy - cy);
      if (len >= 5) segs.push({ len, width: wPt });
      cx = sx;
      cy = sy;
    },
  });
}

const device = new mupdf.Device({
  fillPath: (p, _evenOdd, ctm) => {
    fillOps++;
    // Fills have no stroke width; record width = 0 to mark "fill".
    walkPath(p, ctm, 0);
  },
  strokePath: (p, stroke, ctm) => {
    strokeOps++;
    const lw = readLineWidth(stroke);
    if (dumpedStroke < 3) {
      dumpedStroke++;
      const keys =
        stroke && typeof stroke === "object"
          ? Object.keys(stroke).join(",")
          : String(typeof stroke);
      console.log(
        `  [stroke sample] lineWidth=${lw} stroke-keys=[${keys}]`,
      );
    }
    walkPath(p, ctm, lw);
  },
});

page.run(device, mupdf.Matrix.identity);

console.log(`\n=== ${FILE} page ${PAGE} ===`);
console.log(`fill ops: ${fillOps}, stroke ops: ${strokeOps}`);
console.log(`segments (>=5pt): ${segs.length}`);

const withWidth = segs.filter((s) => s.width != null && s.width > 0);
console.log(
  `segments with a usable stroke width: ${withWidth.length} (${((100 * withWidth.length) / segs.length).toFixed(0)}%)`,
);

function histogram(records, label) {
  // Bucket widths into 0.25pt bins.
  const bins = new Map();
  for (const r of records) {
    if (r.width == null) continue;
    const b = (Math.round(r.width / 0.25) * 0.25).toFixed(2);
    bins.set(b, (bins.get(b) ?? 0) + 1);
  }
  const sorted = [...bins.entries()].sort(
    (a, b) => parseFloat(a[0]) - parseFloat(b[0]),
  );
  console.log(`\n  ${label} — width(pt) × count:`);
  for (const [w, n] of sorted) {
    const bar = "#".repeat(Math.min(60, Math.ceil(n / 20)));
    console.log(`    ${w.padStart(6)} : ${String(n).padStart(6)} ${bar}`);
  }
}

const longSegs = segs.filter((s) => s.len >= 50);
const shortSegs = segs.filter((s) => s.len < 50);
console.log(
  `\nlength bands: long(≥50pt)=${longSegs.length}, short(<50pt)=${shortSegs.length}`,
);

histogram(longSegs, "LONG segments (≥50pt — wall candidates)");
histogram(shortSegs, "SHORT segments (<50pt — furniture/dims/text)");

// Quick separation metric: median width of long vs short.
function median(records) {
  const ws = records
    .map((r) => r.width)
    .filter((w) => w != null && w > 0)
    .sort((a, b) => a - b);
  if (ws.length === 0) return null;
  return ws[Math.floor(ws.length / 2)];
}
console.log(
  `\nmedian width — long: ${median(longSegs)?.toFixed(3) ?? "n/a"} pt, short: ${median(shortSegs)?.toFixed(3) ?? "n/a"} pt`,
);
