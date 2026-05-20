/**
 * Day 1 sanity probe — does the relaxed wall extractor now capture
 * non-axis-aligned wall segments on real fixtures?
 *
 * Replicates the emit logic of scanVectorPaths in
 * src/lib/extract/page-extract.ts so the same filter is applied here
 * as runs in production. If you tune DIAGONAL_WALL_MIN_PT, change both.
 *
 * READ-ONLY: prints stats and a sample of captured diagonals per page.
 * Does not write or persist anything.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const DIAGONAL_WALL_MIN_PT = 50;

const FIXTURES = [
  { file: "tests/fixtures/friend-commercial-plan.pdf", focusPages: null },
  {
    file: "tests/fixtures/DP-BP-new-home-sample-drawings.pdf",
    focusPages: [10],
  },
];

const root = process.cwd();

function txp(ctm, x, y) {
  return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
}

function classify(x1, y1, x2, y2) {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  const len = Math.hypot(dx, dy);
  if (len < 5) return { kind: "drop", len };
  if (dy < 1.5 && dx > 1.5) return { kind: "axial-h", len };
  if (dx < 1.5 && dy > 1.5) return { kind: "axial-v", len };
  if (len >= 18 && len <= 45) return { kind: "door-swing", len };
  if (len >= DIAGONAL_WALL_MIN_PT) {
    const angleDeg = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    return { kind: "diagonal-wall", len, angleDeg };
  }
  return { kind: "drop-tweener", len };
}

async function probePage(mupdf, doc, pageIndex) {
  const page = doc.loadPage(pageIndex);
  const bounds = page.getBounds();
  const pageWidth = bounds[2] - bounds[0];
  const pageHeight = bounds[3] - bounds[1];
  const tallies = {
    "axial-h": 0,
    "axial-v": 0,
    "diagonal-wall": 0,
    "door-swing": 0,
    drop: 0,
    "drop-tweener": 0,
  };
  const diagonalSamples = [];
  function emit(x1, y1, x2, y2) {
    const c = classify(x1, y1, x2, y2);
    tallies[c.kind]++;
    if (c.kind === "diagonal-wall" && diagonalSamples.length < 12) {
      diagonalSamples.push({
        x1,
        y1,
        x2,
        y2,
        len: c.len,
        angleDeg: c.angleDeg,
      });
    }
  }
  function collect(p, ctm) {
    let cx = 0,
      cy = 0,
      sx = 0,
      sy = 0;
    p.walk({
      moveTo: (x, y) => {
        [cx, cy] = txp(ctm, x, y);
        sx = cx;
        sy = cy;
      },
      lineTo: (x, y) => {
        const [nx, ny] = txp(ctm, x, y);
        emit(cx, cy, nx, ny);
        cx = nx;
        cy = ny;
      },
      curveTo: () => {
        // bezier — page-extract treats these as door swings, not walls
      },
      closePath: () => {
        emit(cx, cy, sx, sy);
        cx = sx;
        cy = sy;
      },
    });
  }
  const device = new mupdf.Device({
    fillPath: (p, _, ctm) => collect(p, ctm),
    strokePath: (p, _, ctm) => collect(p, ctm),
  });
  page.run(device, mupdf.Matrix.identity);
  return { pageWidth, pageHeight, tallies, diagonalSamples };
}

async function probe(file, focusPages) {
  const buf = await readFile(path.join(root, file));
  console.log(`\n=== ${file} ===  size=${buf.length} bytes`);
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(
    new Uint8Array(buf),
    "application/pdf",
  );
  const pageCount = doc.countPages();
  console.log(`pages: ${pageCount}`);
  const headers = "page | axisH | axisV | diag | door | <5pt | tweener | size";
  console.log(headers);
  console.log("-".repeat(headers.length));
  const summaries = [];
  for (let i = 0; i < pageCount; i++) {
    const r = await probePage(mupdf, doc, i);
    summaries.push({ pageNumber: i + 1, ...r });
    const t = r.tallies;
    console.log(
      ` ${String(i + 1).padStart(3)} | ${String(t["axial-h"]).padStart(5)} | ` +
        `${String(t["axial-v"]).padStart(5)} | ${String(t["diagonal-wall"]).padStart(4)} | ` +
        `${String(t["door-swing"]).padStart(4)} | ${String(t.drop).padStart(4)} | ` +
        `${String(t["drop-tweener"]).padStart(7)} | ${r.pageWidth.toFixed(0)}x${r.pageHeight.toFixed(0)}pt`,
    );
  }
  const interesting = focusPages
    ? summaries.filter((s) => focusPages.includes(s.pageNumber))
    : summaries
        .filter((s) => s.tallies["diagonal-wall"] > 0)
        .sort(
          (a, b) => b.tallies["diagonal-wall"] - a.tallies["diagonal-wall"],
        );
  for (const s of interesting) {
    if (s.tallies["diagonal-wall"] === 0) continue;
    console.log(
      `\n  -- page ${s.pageNumber} diagonals (${s.tallies["diagonal-wall"]} total, first ${s.diagonalSamples.length}): --`,
    );
    for (const d of s.diagonalSamples) {
      console.log(
        `    (${d.x1.toFixed(1)},${d.y1.toFixed(1)}) → ` +
          `(${d.x2.toFixed(1)},${d.y2.toFixed(1)})  ` +
          `len=${d.len.toFixed(1)}pt  angle=${d.angleDeg.toFixed(1)}°`,
      );
    }
  }
}

for (const { file, focusPages } of FIXTURES) {
  await probe(file, focusPages);
}
