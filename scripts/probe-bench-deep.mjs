// Check if benchmark-plan's floor plan area is a raster image.
import { readFile } from "node:fs/promises";
const buf = await readFile("tests/fixtures/benchmark-plan.pdf");
const mupdf = await import("mupdf");
const doc = mupdf.Document.openDocument(new Uint8Array(buf), "application/pdf");

for (let p = 1; p <= 3; p++) {
  const page = doc.loadPage(p - 1);
  const bounds = page.getBounds();
  console.log(`\n=== page ${p}: ${bounds[2]-bounds[0]}x${bounds[3]-bounds[1]}pt ===`);
  let fillPathCount = 0, strokePathCount = 0, fillImageCount = 0;
  let imageBboxes = [];
  let ignoredCount = 0;
  const handlers = {
    fillPath: () => fillPathCount++,
    strokePath: () => strokePathCount++,
    fillImage: (image, ctm) => {
      fillImageCount++;
      // image's render rect is determined by the CTM applied to a unit square.
      const x0 = ctm[4], y0 = ctm[5];
      const x1 = ctm[0] + ctm[2] + ctm[4];
      const y1 = ctm[1] + ctm[3] + ctm[5];
      imageBboxes.push({ x: Math.min(x0,x1), y: Math.min(y0,y1), w: Math.abs(ctm[0]+ctm[2]), h: Math.abs(ctm[1]+ctm[3]) });
    },
    fillImageMask: () => ignoredCount++,
    clipPath: () => ignoredCount++,
    clipStrokePath: () => ignoredCount++,
    clipImageMask: () => ignoredCount++,
    fillText: () => ignoredCount++,
    strokeText: () => ignoredCount++,
    clipText: () => ignoredCount++,
    clipStrokeText: () => ignoredCount++,
    ignoreText: () => ignoredCount++,
    popClip: () => {},
    beginGroup: () => {},
    endGroup: () => {},
    beginTile: () => {},
    endTile: () => {},
    beginLayer: () => {},
    endLayer: () => {},
    beginStructure: () => {},
    endStructure: () => {},
    beginMetatext: () => {},
    endMetatext: () => {},
  };
  const dev = new mupdf.Device(handlers);
  page.run(dev, mupdf.Matrix.identity);
  console.log(`  fillPath=${fillPathCount} strokePath=${strokePathCount} fillImage=${fillImageCount} other=${ignoredCount}`);
  for (const b of imageBboxes) {
    console.log(`    image bbox: (${Math.round(b.x)},${Math.round(b.y)}) ${Math.round(b.w)}x${Math.round(b.h)}pt`);
  }
}
