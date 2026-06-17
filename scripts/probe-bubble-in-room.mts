/** Decisive test: do finish bubbles fall inside detected room faces,
 * and do washroom-ish rooms get tile (CT) while others get paint (P)? */
import fs from "fs";
import { extractTextLayer } from "../src/lib/pdf-render";
import { scanVectorPaths, detectPageScale } from "../src/lib/extract/page-extract";
import { detectRooms } from "../src/lib/planar-graph";

const buf = fs.readFileSync("tests/fixtures/friend-commercial-plan.pdf");
const { textFragments, pageWidthPt, pageHeightPt } = await extractTextLayer(buf, 5);

const CODE = /^(P-?\d|CT-?\d|FRP-?\d?)$/i;
const finishOf = (c: string) => {
  const u = c.toUpperCase();
  return u.startsWith("CT") ? "tile" : u.startsWith("FRP") ? "frp" : u.startsWith("P") ? "paint" : "?";
};
// bubbles in scan space (pt, y-down) — text layer already y-down
const bubbles = textFragments
  .map((f) => ({ t: f.text.trim().replace(/\s+/g, ""), x: f.xNorm * pageWidthPt, y: f.yNorm * pageHeightPt }))
  .filter((f) => CODE.test(f.t))
  .map((b) => ({ ...b, finish: finishOf(b.t) }));

// room faces (scan space). detectRooms uses scanVectorPaths walls.
const { scan } = await scanVectorPaths(buf, 5);
const faces = detectRooms(scan.walls.map((s) => ({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 })), pageWidthPt, pageHeightPt, {});

// room labels from text
const labelFrags = textFragments
  .map((f) => ({ t: f.text.trim(), x: f.xNorm * pageWidthPt, y: f.yNorm * pageHeightPt }))
  .filter((f) => /WASHROOM|VESTIBULE|OVERSTOCK|SALES|SERVICE|ELECTRICAL|STORAGE|OFFICE|KITCHEN/i.test(f.t));

function inPoly(poly: {x:number;y:number}[], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

console.log(`${faces.length} room faces, ${bubbles.length} bubbles, ${labelFrags.length} room labels\n`);
let assigned = 0;
for (const f of faces) {
  const areaSqft = Math.abs(f.area) / 324;
  if (areaSqft < 20) continue;
  const poly = f.polygon;
  const inB = bubbles.filter((b) => inPoly(poly, b.x, b.y));
  const inL = labelFrags.filter((l) => inPoly(poly, l.x, l.y));
  if (inB.length === 0 && inL.length === 0) continue;
  assigned++;
  const fin = inB.reduce((m: Record<string,number>, b) => { m[b.finish]=(m[b.finish]??0)+1; return m; }, {});
  console.log(`face ${areaSqft.toFixed(0)}sqft: labels=[${inL.map(l=>l.t).join(",")}] bubbles=${JSON.stringify(fin)} codes=[${inB.map(b=>b.t).join(",")}]`);
}
console.log(`\n${assigned} faces got a label or bubble`);
