// Reproduce the page-extract flow on LOFT p4 with extra logging.
import { readFile } from "node:fs/promises";

const buf = await readFile("tests/fixtures/LOFT-Collection-OCT-16.pdf");
const PAGE = 4;
const { detectRooms } = await import("../src/lib/planar-graph.ts");

// Inline the vector scan / text extract from page-extract.ts logic.
const mupdf = await import("mupdf");
const doc = mupdf.Document.openDocument(new Uint8Array(buf), "application/pdf");
const mpage = doc.loadPage(PAGE - 1);
const bounds = mpage.getBounds();
const pageW = bounds[2] - bounds[0];
const pageH = bounds[3] - bounds[1];

const walls = [];
const doorCands = [];
function tx(ctm, x, y) {
  return [ctm[0]*x + ctm[2]*y + ctm[4], ctm[1]*x + ctm[3]*y + ctm[5]];
}
function emit(x1, y1, x2, y2) {
  const dx = Math.abs(x2-x1), dy = Math.abs(y2-y1);
  const len = Math.hypot(dx, dy);
  if (len < 5) return;
  if (dy < 1.5 && dx > 1.5) walls.push({x1,y1,x2,y2:y1});
  else if (dx < 1.5 && dy > 1.5) walls.push({x1,y1,x2:x1,y2});
  else if (len >= 18 && len <= 45) doorCands.push({x:(x1+x2)/2,y:(y1+y2)/2,size:len});
}
function collect(p, ctm) {
  let cx=0,cy=0,sx=0,sy=0;
  p.walk({
    moveTo: (x,y) => { [cx,cy]=tx(ctm,x,y); sx=cx; sy=cy; },
    lineTo: (x,y) => { const [nx,ny]=tx(ctm,x,y); emit(cx,cy,nx,ny); cx=nx; cy=ny; },
    curveTo: () => {},
    closePath: () => { emit(cx,cy,sx,sy); cx=sx; cy=sy; },
  });
}
const dev = new mupdf.Device({
  fillPath: (p,_e,ctm) => collect(p, ctm),
  strokePath: (p,_e,ctm) => collect(p, ctm),
});
mpage.run(dev, mupdf.Matrix.identity);
console.log(`walls=${walls.length} doors=${doorCands.length}`);

const faces = detectRooms(walls, pageW, pageH, {
  snapTolerance: 1.5,
  minRoomArea: 800,
  maxRoomArea: 0.85 * pageW * pageH,
  maxAspectRatio: 30,
  maxVertices: 80,
  maxDoorGap: 60,
  doorCandidates: doorCands,
  doorMatchRadius: 30,
});
console.log(`faces=${faces.length}`);
for (let i = 0; i < faces.length; i++) {
  const f = faces[i];
  const cx = (f.bbox.x0+f.bbox.x1)/2;
  const cy = (f.bbox.y0+f.bbox.y1)/2;
  console.log(`  f${i}: bbox (${Math.round(f.bbox.x0)},${Math.round(f.bbox.y0)}) → (${Math.round(f.bbox.x1)},${Math.round(f.bbox.y1)}) area=${Math.round(f.area)} center=(${Math.round(cx)},${Math.round(cy)})`);
}

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const pdoc = await pdfjs.getDocument({ data: new Uint8Array(buf), useWorkerFetch:false, isEvalSupported:false, useSystemFonts:true }).promise;
const ppage = await pdoc.getPage(PAGE);
const tc = await ppage.getTextContent();
const labels = [];
for (const it of tc.items) {
  const s = (it.str ?? "").trim();
  if (!s) continue;
  const t = s;
  if (!/\b(FOYER|LIVING|DINING|KITCHEN|BEDROOM|BALCONY|WIC|DEN|ENSUITE|PRIMARY|FLEX|WORK|HALL|ENTRY|FOYER|BATH|RESTROOM|OFFICE|STAIR|ELEV|LOBBY|STORAGE|MECH|CLOSET)\b/i.test(t)) continue;
  if (t.length > 40) continue;
  if (/^[•·\-*]/.test(t)) continue;
  if (t.split(/\s+/).length > 4) continue;
  const w = it.width ?? 0;
  const h = it.height ?? Math.abs(it.transform?.[3] ?? 10);
  labels.push({ text: t, x: it.transform[4], y: it.transform[5], w, h });
}
console.log(`\nlabels=${labels.length}`);
function pointInPolygon(p, poly) {
  let inside = false;
  for (let i=0, j=poly.length-1; i<poly.length; j=i++) {
    const xi=poly[i].x, yi=poly[i].y, xj=poly[j].x, yj=poly[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj-xi)*(p.y-yi))/(yj-yi)+xi) inside=!inside;
  }
  return inside;
}
const radius = Math.min(pageW, pageH) * 0.06;
for (const lbl of labels) {
  const cx = lbl.x + lbl.w/2;
  const cy = lbl.y + lbl.h/2;
  let p1 = -1;
  let p2 = -1;
  let p3 = -1, p3Dist = radius;
  for (let i = 0; i < faces.length; i++) {
    if (pointInPolygon({x:cx,y:cy}, faces[i].polygon)) { if (p1===-1) p1 = i; }
    const corners = [{x:lbl.x,y:lbl.y},{x:lbl.x+lbl.w,y:lbl.y},{x:lbl.x,y:lbl.y+lbl.h},{x:lbl.x+lbl.w,y:lbl.y+lbl.h}];
    if (corners.some((c) => pointInPolygon(c, faces[i].polygon))) { if (p2===-1) p2 = i; }
    const fcx = (faces[i].bbox.x0+faces[i].bbox.x1)/2, fcy=(faces[i].bbox.y0+faces[i].bbox.y1)/2;
    const d = Math.hypot(fcx-cx, fcy-cy);
    if (d < p3Dist) { p3Dist=d; p3=i; }
  }
  console.log(`  "${lbl.text}" center=(${Math.round(cx)},${Math.round(cy)}) pass1=${p1} pass2=${p2} pass3=${p3}@${Math.round(p3Dist)}pt`);
}
