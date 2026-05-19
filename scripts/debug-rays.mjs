// Debug ray-cast for specific labels on LOFT p4.
import { readFile } from "node:fs/promises";
const buf = await readFile("tests/fixtures/LOFT-Collection-OCT-16.pdf");
const PAGE = 4;

const mupdf = await import("mupdf");
const doc = mupdf.Document.openDocument(new Uint8Array(buf), "application/pdf");
const mpage = doc.loadPage(PAGE - 1);
const bounds = mpage.getBounds();
const pageW = bounds[2] - bounds[0];
const pageH = bounds[3] - bounds[1];

const walls = [];
function txMat(ctm, x, y) {
  return [ctm[0]*x + ctm[2]*y + ctm[4], ctm[1]*x + ctm[3]*y + ctm[5]];
}
function emit(x1,y1,x2,y2) {
  const dx=Math.abs(x2-x1), dy=Math.abs(y2-y1);
  const len=Math.hypot(dx,dy);
  if (len < 5) return;
  if (dy < 1.5 && dx > 1.5) walls.push({x1,y1,x2,y2:y1});
  else if (dx < 1.5 && dy > 1.5) walls.push({x1,y1,x2:x1,y2});
}
function collect(p, ctm) {
  let cx=0,cy=0,sx=0,sy=0;
  p.walk({
    moveTo: (x,y) => { [cx,cy]=txMat(ctm,x,y); sx=cx; sy=cy; },
    lineTo: (x,y) => { const [nx,ny]=txMat(ctm,x,y); emit(cx,cy,nx,ny); cx=nx; cy=ny; },
    curveTo: () => {},
    closePath: () => { emit(cx,cy,sx,sy); cx=sx; cy=sy; },
  });
}
const dev = new mupdf.Device({
  fillPath: (p,_e,ctm) => collect(p, ctm),
  strokePath: (p,_e,ctm) => collect(p, ctm),
});
mpage.run(dev, mupdf.Matrix.identity);

console.log(`walls=${walls.length}, page=${pageW}x${pageH}pt`);

// Test labels (center positions from earlier probe)
const tests = [
  { label: "BEDROOM", cx: 374, cy: 628 },
  { label: "FOYER",   cx: 740, cy: 625 },
  { label: "LIVING",  cx: 371, cy: 486 },
  { label: "DINING / KITCHEN", cx: 593, cy: 435 },
  { label: "BALCONY", cx: 187, cy: 340 },
];
for (const t of tests) {
  let topY = pageH, bottomY = 0, leftX = 0, rightX = pageW;
  let hT=false, hB=false, hL=false, hR=false;
  let nH = 0, nV = 0;
  let nearestHabove = null, nearestHbelow = null;
  for (const w of walls) {
    if (w.y1 === w.y2) {
      nH++;
      const wx0 = Math.min(w.x1,w.x2), wx1 = Math.max(w.x1,w.x2);
      if (t.cx < wx0 || t.cx > wx1) continue;
      const wy = w.y1;
      if (wy > t.cy && wy < topY) { topY = wy; hT = true; }
      else if (wy < t.cy && wy > bottomY) { bottomY = wy; hB = true; }
    } else if (w.x1 === w.x2) {
      nV++;
      const wy0 = Math.min(w.y1,w.y2), wy1 = Math.max(w.y1,w.y2);
      if (t.cy < wy0 || t.cy > wy1) continue;
      const wx = w.x1;
      if (wx > t.cx && wx < rightX) { rightX = wx; hR = true; }
      else if (wx < t.cx && wx > leftX) { leftX = wx; hL = true; }
    }
  }
  console.log(`\n${t.label} at (${t.cx},${t.cy}): nHwalls=${nH} nVwalls=${nV}`);
  console.log(`  top=${Math.round(topY)} (hit:${hT}) bottom=${Math.round(bottomY)} (hit:${hB}) left=${Math.round(leftX)} (hit:${hL}) right=${Math.round(rightX)} (hit:${hR})`);
  const w = rightX - leftX, h = topY - bottomY;
  console.log(`  bbox=${Math.round(w)}x${Math.round(h)}pt`);
}
