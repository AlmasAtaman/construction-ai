/** Are clean ROOM-NAME tags (not notes) findable + co-located with walls? */
import fs from "fs";
import { extractTextLayer } from "../src/lib/pdf-render";

const buf = fs.readFileSync("tests/fixtures/friend-commercial-plan.pdf");
const { textFragments, pageWidthPt, pageHeightPt } = await extractTextLayer(buf, 5);

const ROOM = /^(UNIVERSAL WASHROOM|WASHROOM VESTIBULE|WASHROOM|VESTIBULE|OVERSTOCK|SALES AREA|SERVICE AREA|ELECTRICAL ROOM|SALES|SERVICE|ELECTRICAL)$/i;
const tags = textFragments
  .map((f) => ({ t: f.text.trim(), x: (f.xNorm*pageWidthPt)|0, y: (f.yNorm*pageHeightPt)|0 }))
  .filter((f) => ROOM.test(f.t));
console.log("clean room-name tags on p5 (construction view is x253-1252 y185-585):");
for (const t of tags.sort((a,b)=>a.y-b.y)) {
  const inView = t.x>=253 && t.x<=1252 && t.y>=185 && t.y<=585;
  console.log(`  ${t.t.padEnd(20)} x=${t.x} y=${t.y} ${inView ? "[in construction view]" : ""}`);
}
