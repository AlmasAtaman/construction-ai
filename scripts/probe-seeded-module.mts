import fs from "fs";
import { scanSegmentsByLayer } from "../src/lib/extract/layer-scan";
import { classifyLayers, WALL_ROLES } from "../src/lib/extract/layer-classify";
import { extractRoomSeeds } from "../src/lib/extract/room-seeds";
import { segmentRoomsBySeeds } from "../src/lib/extract/seeded-rooms";

const PT = 18;
const buf = fs.readFileSync("tests/fixtures/friend-commercial-plan.pdf");
const scan = await scanSegmentsByLayer(buf, 5);
const roles = Object.fromEntries(classifyLayers(Object.keys(scan.segmentsPerLayer)).map(c=>[c.name,c.role]));
const walls = scan.segments.filter(s => s.layer && WALL_ROLES.has(roles[s.layer]) && !s.diagonal)
  .map(s => ({x1:s.x1,y1:s.y1,x2:s.x2,y2:s.y2}));
const seeds = await extractRoomSeeds(buf, 5);
console.log("seeds:", seeds.map(s=>`${s.label}(${s.x|0},${s.y|0})`).join(" "));

const res = segmentRoomsBySeeds(walls, seeds, { ptPerFoot: PT, pageWidthPt: scan.pageWidthPt, pageHeightPt: scan.pageHeightPt });
if (!res) { console.log("NULL — fell back"); process.exit(0); }
console.log("\nview:", JSON.stringify({x0:res.viewBounds.x0|0,y0:res.viewBounds.y0|0,x1:res.viewBounds.x1|0,y1:res.viewBounds.y1|0}));
console.log("rooms:");
for (const r of res.rooms.sort((a,b)=>b.areaSqft-a.areaSqft))
  console.log(`  ${(r.label??"?").padEnd(12)} area=${r.areaSqft.toFixed(0).padStart(5)}sqft  wallPerim=${r.wallPerimeterFt.toFixed(0).padStart(4)}lf  poly=${r.polygonPt.length}pts`);
console.log("\nfriend: Overstock 93lf, Sales+Service 171lf");

// render room polygons over the plan
import * as mupdf from "mupdf";
const doc=(mupdf as any).Document.openDocument(new Uint8Array(buf),"application/pdf");
const S=2;
const pix=doc.loadPage(4).toPixmap((mupdf as any).Matrix.scale(S,S),(mupdf as any).ColorSpace.DeviceRGB,false,true);
fs.writeFileSync("/tmp/layers/seg-base.png", pix.asPNG());
fs.writeFileSync("/tmp/layers/seg-rooms.json", JSON.stringify({S, rooms: res.rooms.map(r=>({label:r.label, poly:r.polygonPt}))}));
console.log("dumped");
