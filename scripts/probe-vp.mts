// Trace virtual-partition inputs on page 10.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { virtualPartition } from "../src/lib/extract/virtual-partition.js";
import { parseDimensionCallouts } from "../src/lib/dimension-callouts.js";

const buf = await readFile(path.join(process.cwd(), "tests/fixtures/DP-BP-new-home-sample-drawings.pdf"));

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const doc = await pdfjs.getDocument({
  data: new Uint8Array(buf), useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true,
}).promise;
const page = await doc.getPage(10);
const vp = page.getViewport({ scale: 1 });
const tc = await page.getTextContent();
const fragments = (tc.items as Array<{str:string;transform:number[];width?:number;height?:number}>)
  .map(it => ({
    text: (it.str ?? "").trim(),
    x: it.transform[4],
    y: it.transform[5],
    rotation: Math.atan2(it.transform[1] ?? 0, it.transform[0] ?? 1),
  }))
  .filter(f => f.text);

const callouts = parseDimensionCallouts(fragments);

const mupdf = await import("mupdf");
const mdoc = (mupdf as any).Document.openDocument(new Uint8Array(buf), "application/pdf");
const mpage = mdoc.loadPage(9);
const walls: {x1:number;y1:number;x2:number;y2:number}[] = [];
let bbX0 = Infinity, bbY0 = Infinity, bbX1 = -Infinity, bbY1 = -Infinity;
function emit(x1:number,y1:number,x2:number,y2:number) {
  const dx = Math.abs(x2-x1), dy = Math.abs(y2-y1);
  const len = Math.hypot(dx, dy);
  if (len < 5) return;
  if (dy < 1.5 && dx > 1.5) walls.push({x1,y1,x2,y2:y1});
  else if (dx < 1.5 && dy > 1.5) walls.push({x1,y1,x2:x1,y2});
  for (const x of [x1,x2]) { if (x<bbX0) bbX0=x; if (x>bbX1) bbX1=x; }
  for (const y of [y1,y2]) { if (y<bbY0) bbY0=y; if (y>bbY1) bbY1=y; }
}
function collect(p:any, ctm:number[]) {
  let cx=0, cy=0, sx=0, sy=0;
  function tx(x:number,y:number):[number,number]{return [ctm[0]*x+ctm[2]*y+ctm[4], ctm[1]*x+ctm[3]*y+ctm[5]];}
  p.walk({
    moveTo:(x:number,y:number)=>{[cx,cy]=tx(x,y);sx=cx;sy=cy;},
    lineTo:(x:number,y:number)=>{const[nx,ny]=tx(x,y);emit(cx,cy,nx,ny);cx=nx;cy=ny;},
    curveTo:()=>{},
    closePath:()=>{emit(cx,cy,sx,sy);cx=sx;cy=sy;},
  });
}
const dev = new (mupdf as any).Device({
  fillPath: (p:any, _:any, ctm:number[]) => collect(p, ctm),
  strokePath: (p:any, _:any, ctm:number[]) => collect(p, ctm),
});
mpage.run(dev, (mupdf as any).Matrix.identity);

console.log(`walls: ${walls.length}`);
console.log(`segment bbox: (${Math.round(bbX0)},${Math.round(bbY0)})-(${Math.round(bbX1)},${Math.round(bbY1)})`);

const failed = [
  { id: "lr", text: "LIVING ROOM", cxPt: 313, cyPt: 391, roomsIndex: 0 },
  { id: "bath", text: "BATH", cxPt: 293, cyPt: 564, roomsIndex: 4 },
];
const claimed = [
  { id: "kit", text: "KITCHEN", cxPt: 451, cyPt: 486, bboxPt: {x:335.9,y:431.8,width:224.3,height:113.3}, areaSqft: 139.4, roomsIndex: 3 },
  { id: "nook", text: "NOOK", cxPt: 459, cyPt: 343, bboxPt: {x:339.8,y:292.6,width:174,height:117.5}, areaSqft: 112.2, roomsIndex: 1 },
  { id: "porch", text: "WOOD PORCH", cxPt: 188, cyPt: 464, bboxPt: {x:138,y:416.8,width:85.4,height:67.6}, areaSqft: 31.7, roomsIndex: 2 },
];

const r = virtualPartition({
  failed, claimed, walls, callouts,
  ptPerFt: 13.5,
  pageWidthPt: vp.width, pageHeightPt: vp.height,
  segmentBboxPt: { x0: bbX0, y0: bbY0, x1: bbX1, y1: bbY1 },
  minPlausibleSqft: (l) => {
    const t = l.toUpperCase();
    if (/\bLIVING\b/.test(t)) return 80;
    if (/\b(BATH|TOILET)\b/.test(t)) return 15;
    if (/\bKITCHEN\b/.test(t)) return 60;
    if (/\bNOOK\b/.test(t)) return 30;
    return 0;
  },
});
console.log(`results: ${r.length}`);
for (const x of r) {
  console.log(`  roomsIndex=${x.roomsIndex} label="${x.label}" bbox=(${Math.round(x.bboxPt.x)},${Math.round(x.bboxPt.y)})+${Math.round(x.bboxPt.width)}×${Math.round(x.bboxPt.height)} ${x.widthFt}×${x.heightFt}ft area=${x.areaSqft} replacedClaimed=${x.replacedClaimed}`);
  console.log(`     warning: ${x.measurementWarning}`);
}
