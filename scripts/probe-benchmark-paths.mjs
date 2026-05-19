// Dump every closed path's bbox on page 1 of benchmark-plan, to see if
// the rooms are drawn as rectangles we can capture.
import { readFile } from "node:fs/promises";

const buf = await readFile("tests/fixtures/benchmark-plan.pdf");
const mupdf = await import("mupdf");
const doc = mupdf.Document.openDocument(new Uint8Array(buf), "application/pdf");

for (let p = 1; p <= 3; p++) {
  const page = doc.loadPage(p - 1);
  const bounds = page.getBounds();
  console.log(`\n=== page ${p} (${bounds[2]-bounds[0]}x${bounds[3]-bounds[1]}pt) ===`);

  const closedPaths = [];
  let pathIdx = 0;

  function txMat(ctm, x, y) {
    return [ctm[0]*x + ctm[2]*y + ctm[4], ctm[1]*x + ctm[3]*y + ctm[5]];
  }

  function walk(path, ctm, op) {
    let cx = 0, cy = 0, sx = 0, sy = 0;
    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    let lineCount = 0, hasClose = false;
    const verts = [];
    function bump(x, y) {
      if (x < xMin) xMin = x;
      if (y < yMin) yMin = y;
      if (x > xMax) xMax = x;
      if (y > yMax) yMax = y;
      verts.push([x, y]);
    }
    path.walk({
      moveTo: (x, y) => { [cx, cy] = txMat(ctm, x, y); sx = cx; sy = cy; bump(cx, cy); },
      lineTo: (x, y) => { const [nx, ny] = txMat(ctm, x, y); bump(nx, ny); cx = nx; cy = ny; lineCount++; },
      curveTo: () => { /* skip */ },
      closePath: () => { hasClose = true; },
    });
    if (verts.length >= 3) {
      closedPaths.push({
        idx: pathIdx++,
        op,
        bbox: { x: xMin, y: yMin, w: xMax-xMin, h: yMax-yMin },
        lineCount,
        hasClose,
        vertCount: verts.length,
      });
    }
  }

  const dev = new mupdf.Device({
    fillPath:   (p, _e, ctm) => walk(p, ctm, "fill"),
    strokePath: (p, _e, ctm) => walk(p, ctm, "stroke"),
  });
  page.run(dev, mupdf.Matrix.identity);

  console.log(`  total paths: ${closedPaths.length}`);
  for (const p of closedPaths.slice(0, 30)) {
    console.log(
      `    #${p.idx} ${p.op} bbox=(${Math.round(p.bbox.x)},${Math.round(p.bbox.y)}) ${Math.round(p.bbox.w)}x${Math.round(p.bbox.h)} (lines=${p.lineCount}, close=${p.hasClose}, verts=${p.vertCount})`,
    );
  }
}
