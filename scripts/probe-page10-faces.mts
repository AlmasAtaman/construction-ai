// Detail probe: faces, labels, ray-cast outcomes per label on page 10.
import { readFile } from "node:fs/promises";
import path from "node:path";

const buf = await readFile(path.join(process.cwd(), "tests/fixtures/DP-BP-new-home-sample-drawings.pdf"));

// 1. Use pdfjs to get text fragments with positions.
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const doc = await pdfjs.getDocument({
  data: new Uint8Array(buf),
  useWorkerFetch: false,
  isEvalSupported: false,
  useSystemFonts: true,
}).promise;
const page = await doc.getPage(10);
const vp = page.getViewport({ scale: 1 });
const tc = await page.getTextContent();

interface F { text: string; x: number; y: number; w: number; h: number; }
const frags: F[] = [];
for (const it of tc.items as Array<{str:string;transform:number[];width?:number;height?:number}>) {
  const s = (it.str ?? "").trim();
  if (!s) continue;
  frags.push({
    text: s,
    x: it.transform[4],
    y: it.transform[5],
    w: it.width ?? 0,
    h: it.height ?? Math.abs(it.transform[3] ?? 10),
  });
}
console.log(`page: ${vp.width}x${vp.height} pt, ${frags.length} fragments`);

// Show labels that contain room-keywords
const ROOM_RE = /\b(LIVING|KITCHEN|NOOK|BATH|STAIR|FOYER|ENTRY|PORCH|DECK|ROOM|MASTER|BEDROOM|DINING|FAMILY|GARAGE|LAUNDRY|HALL|WIC|PWDR|CLOSET|MUDROOM|MUD|GREAT|MEDIA|BONUS|REC|DEN|STUDY|GUEST|NURSERY|GYM)\b/i;
console.log(`\n=== Room-keyword fragments ===`);
for (const f of frags) {
  if (!ROOM_RE.test(f.text)) continue;
  console.log(`  "${f.text.padEnd(28)}" pos=(${Math.round(f.x)},${Math.round(f.y)}) bbox=${Math.round(f.w)}x${Math.round(f.h)}`);
}

// 2. Use mupdf to extract walls.
const mupdf = await import("mupdf");
const mdoc = (mupdf as any).Document.openDocument(new Uint8Array(buf), "application/pdf");
const mpage = mdoc.loadPage(9); // page 10 = index 9
const walls: {x1:number;y1:number;x2:number;y2:number}[] = [];
function emit(x1:number,y1:number,x2:number,y2:number) {
  const dx = Math.abs(x2-x1), dy = Math.abs(y2-y1);
  const len = Math.hypot(dx, dy);
  if (len < 5) return;
  if (dy < 1.5 && dx > 1.5) walls.push({x1,y1,x2,y2:y1});
  else if (dx < 1.5 && dy > 1.5) walls.push({x1,y1,x2:x1,y2});
}
function collect(p:any, ctm:number[]) {
  let cx=0, cy=0, sx=0, sy=0;
  function tx(x:number,y:number):[number,number]{return [ctm[0]*x+ctm[2]*y+ctm[4], ctm[1]*x+ctm[3]*y+ctm[5]];}
  p.walk({
    moveTo:(x:number,y:number)=>{[cx,cy]=tx(x,y);sx=cx;sy=cy;},
    lineTo:(x:number,y:number)=>{const[nx,ny]=tx(x,y);emit(cx,cy,nx,ny);cx=nx;cy=ny;},
    curveTo:(_:number)=>{cx=cy=0;},
    closePath:()=>{emit(cx,cy,sx,sy);cx=sx;cy=sy;},
  });
}
const dev = new (mupdf as any).Device({
  fillPath: (p:any, _:any, ctm:number[]) => collect(p, ctm),
  strokePath: (p:any, _:any, ctm:number[]) => collect(p, ctm),
});
mpage.run(dev, (mupdf as any).Matrix.identity);
console.log(`\nwalls: ${walls.length}`);

// 3. For each room-keyword fragment, simulate the ray-cast as in page-extract.ts.
import { detectRooms } from "../src/lib/planar-graph.js";
const faces = detectRooms(walls, vp.width, vp.height, {
  snapTolerance: 1.5, minRoomArea: 1500, maxRoomArea: 0.85*vp.width*vp.height,
  maxAspectRatio: 30, maxVertices: 80, maxDoorGap: 60,
});
console.log(`\nfaces: ${faces.length}`);
for (let i = 0; i < faces.length; i++) {
  const f = faces[i];
  const w = f.bbox.x1 - f.bbox.x0;
  const h = f.bbox.y1 - f.bbox.y0;
  console.log(`  face[${i}] area=${Math.round(f.area)}pt² bbox=(${Math.round(f.bbox.x0)},${Math.round(f.bbox.y0)})-(${Math.round(f.bbox.x1)},${Math.round(f.bbox.y1)}) w=${Math.round(w)}x${Math.round(h)} verts=${f.polygon.length}`);
}

// 4. Find Living Room and Kitchen labels, list faces that enclose them
function pointInPolygon(p:{x:number;y:number}, poly:{x:number;y:number}[]):boolean {
  let inside = false;
  for (let i=0, j=poly.length-1; i<poly.length; j=i++) {
    const xi=poly[i].x, yi=poly[i].y, xj=poly[j].x, yj=poly[j].y;
    if (yi>p.y !== yj>p.y && p.x < (xj-xi)*(p.y-yi)/(yj-yi)+xi) inside = !inside;
  }
  return inside;
}
for (const target of ["LIVING ROOM", "KITCHEN", "NOOK", "BATH", "STAIR", "FOYER", "ENTRY"]) {
  // Find fragments containing the target
  const candidates = frags.filter(f => f.text.toUpperCase().includes(target.split(" ")[0]));
  for (const f of candidates) {
    const cx = f.x + f.w/2, cy = f.y + f.h/2;
    console.log(`\n=== "${f.text}" at (${Math.round(cx)},${Math.round(cy)}) ===`);
    const enclosing: number[] = [];
    for (let i=0; i<faces.length; i++) {
      if (pointInPolygon({x:cx,y:cy}, faces[i].polygon)) enclosing.push(i);
    }
    if (enclosing.length === 0) {
      console.log(`  no enclosing face`);
    } else {
      for (const i of enclosing) {
        const f2 = faces[i];
        const w = Math.round(f2.bbox.x1-f2.bbox.x0);
        const h = Math.round(f2.bbox.y1-f2.bbox.y0);
        console.log(`  face[${i}] area=${Math.round(f2.area)}pt² w=${w}x${h} (${(w/13.5).toFixed(1)}ft x ${(h/13.5).toFixed(1)}ft) verts=${f2.polygon.length}`);
      }
    }
  }
}
