/** User's idea: anchor finish to the WALLS (which are correct), not rooms.
 * For each finish bubble, find nearest wall; visualize bubbles+walls to see
 * if tile bubbles sit by a coherent wall set and paint by another. */
import fs from "fs";
import * as mupdf from "mupdf";
import { extractTextLayer } from "../src/lib/pdf-render";
import { scanSegmentsByLayer } from "../src/lib/extract/layer-scan";
import { classifyLayers, WALL_ROLES } from "../src/lib/extract/layer-classify";

const buf = fs.readFileSync("tests/fixtures/friend-commercial-plan.pdf");
const { textFragments, pageWidthPt, pageHeightPt } = await extractTextLayer(buf, 5);

const CODE = /^(P-?\d|CT-?\d|FRP-?\d?)$/i;
const finishOf = (c: string) => { const u=c.toUpperCase(); return u.startsWith("CT")?"tile":u.startsWith("FRP")?"frp":"paint"; };
const bubbles = textFragments
  .map((f) => ({ t: f.text.trim().replace(/\s+/g,""), x: f.xNorm*pageWidthPt, y: f.yNorm*pageHeightPt }))
  .filter((f) => CODE.test(f.t))
  .map((b) => ({ ...b, finish: finishOf(b.t) }));

// ALL wall segments (every view), not just the construction cluster
const scan = await scanSegmentsByLayer(buf, 5);
const roles = Object.fromEntries(classifyLayers(Object.keys(scan.segmentsPerLayer)).map(c=>[c.name,c.role]));
const wallSegs = scan.segments.filter(s => s.layer && WALL_ROLES.has(roles[s.layer]) && !s.diagonal);

function segDist(px:number,py:number,s:any){
  const dx=s.x2-s.x1, dy=s.y2-s.y1, l2=dx*dx+dy*dy;
  let t=l2?((px-s.x1)*dx+(py-s.y1)*dy)/l2:0; t=Math.max(0,Math.min(1,t));
  return Math.hypot(px-(s.x1+t*dx), py-(s.y1+t*dy));
}
// For each bubble, nearest wall distance
let near=0;
for (const b of bubbles) {
  let d=1e9; for (const s of wallSegs) { const dd=segDist(b.x,b.y,s); if(dd<d)d=dd; }
  if (d < 60) near++;
  b["nearWallPt"] = +d.toFixed(0);
}
console.log(`${bubbles.length} bubbles, ${wallSegs.length} wall segs`);
console.log(`bubbles within 60pt (3.3ft) of a wall: ${near}/${bubbles.length}`);
console.log("bubble → nearest wall dist:");
for (const b of bubbles.sort((a,c)=>a.nearWallPt-c.nearWallPt))
  console.log(`  ${b.t.padEnd(5)} ${b.finish.padEnd(5)} ${b.nearWallPt}pt  at (${b.x|0},${b.y|0})`);

// render base + overlay
const doc=(mupdf as any).Document.openDocument(new Uint8Array(buf),"application/pdf");
const pix=doc.loadPage(4).toPixmap((mupdf as any).Matrix.scale(1,1),(mupdf as any).ColorSpace.DeviceRGB,false,true);
fs.writeFileSync("/tmp/layers/p5-base.png", pix.asPNG());
fs.writeFileSync("/tmp/layers/wall-bubble.json", JSON.stringify({ bubbles, walls: wallSegs.map(s=>({x1:s.x1,y1:s.y1,x2:s.x2,y2:s.y2})) }));
