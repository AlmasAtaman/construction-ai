// Test image-based wall detection on the VA commercial benchmark.
// Verify we recover walls in the rasterized regions of the plan.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const iw = await import("../src/lib/image-walls.ts");
const { detectWallsFromImage } = iw;

const pdfPath =
  process.argv[2] ??
  path.resolve(__dirname, "../tests/fixtures/commercial-bench.pdf");
const pageNumber = parseInt(process.argv[3] ?? "1", 10);
const data = readFileSync(pdfPath);

console.log(`Detecting walls from rasterized image…`);
const result = await detectWallsFromImage(Buffer.from(data), pageNumber, {
  dpi: 150,
  threshold: 140,
  minWallPx: 24,
});

console.log(
  `\nPage: ${result.pageWidthPt.toFixed(0)} × ${result.pageHeightPt.toFixed(0)} pt`,
);
console.log(
  `Render: ${result.stats.pixelsWidth} × ${result.stats.pixelsHeight} px @ ${result.dpi} DPI`,
);
console.log(`Ink pixels: ${result.stats.inkPixels.toLocaleString()}`);
console.log(`Horizontal runs: ${result.stats.horizontalRuns.toLocaleString()}`);
console.log(`Vertical runs: ${result.stats.verticalRuns.toLocaleString()}`);
console.log(`Total segments: ${result.segments.length.toLocaleString()}`);
console.log(`Time: ${result.elapsedMs} ms`);

// Check: how many segments are near the OXYGEN ROOM label position?
// Target (1430, 1497) was reported as having 0 vector walls within 200 pt.
function nearTarget(
  segments: { x1: number; y1: number; x2: number; y2: number }[],
  tx: number,
  ty: number,
  r: number,
): number {
  let n = 0;
  for (const s of segments) {
    const mx = (s.x1 + s.x2) / 2;
    const my = (s.y1 + s.y2) / 2;
    if (Math.hypot(mx - tx, my - ty) <= r) n++;
  }
  return n;
}

console.log(
  `\nSegments within 200 pt of OXYGEN label (1430, 1497): ${nearTarget(result.segments, 1430, 1497, 200)}`,
);
console.log(
  `Segments within 200 pt of LOBBY label (1209, 1442): ${nearTarget(result.segments, 1209, 1442, 200)}`,
);
console.log(
  `Segments within 200 pt of LINK CORRIDOR (1011, 1950): ${nearTarget(result.segments, 1011, 1950, 200)}`,
);
