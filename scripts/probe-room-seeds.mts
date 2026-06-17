/** Decisive feasibility gate for seeded region-growing: do we have clean
 * room-label seeds placed INSIDE distinct rooms on p5? */
import fs from "fs";
import { extractTextLayer } from "../src/lib/pdf-render";

const buf = fs.readFileSync("tests/fixtures/friend-commercial-plan.pdf");
const { textFragments, pageWidthPt, pageHeightPt } = await extractTextLayer(buf, 5);

// Room-name vocabulary (multi-word kept as-is). Include room NUMBERS too.
const ROOM = /^(UNIVERSAL WASHROOM|WASHROOM VESTIBULE|WASHROOM|VESTIBULE|OVERSTOCK|SALES AREA|SERVICE AREA|ELECTRICAL ROOM|SALES|SERVICE|ELECTRICAL|STORAGE|OFFICE|ENTRY|EXTERIOR)$/i;
const NUM = /^\d{3}$/; // room numbers like 101,102,104

const all = textFragments.map((f) => ({
  t: f.text.trim(),
  x: Math.round(f.xNorm * pageWidthPt),
  y: Math.round(f.yNorm * pageHeightPt),
}));
const names = all.filter((f) => ROOM.test(f.t));
const nums = all.filter((f) => NUM.test(f.t));

// Two plan views on this sheet (from overlay): construction y~185-585,
// finish y~800-1170. Bucket labels by view.
const band = (y: number) => (y >= 150 && y <= 600 ? "construction" : y >= 780 && y <= 1200 ? "finish" : "other");
console.log("ROOM-NAME labels by view band:");
for (const v of ["construction", "finish", "other"]) {
  const inV = names.filter((f) => band(f.y) === v);
  console.log(`  [${v}] ${inV.length}: ${inV.map((f) => `${f.t}(${f.x},${f.y})`).join("  ")}`);
}
console.log("\nROOM-NUMBER labels (101/102/104…) by view band:");
for (const v of ["construction", "finish", "other"]) {
  const inV = nums.filter((f) => band(f.y) === v);
  console.log(`  [${v}] ${inV.length}: ${inV.map((f) => `${f.t}(${f.x},${f.y})`).join("  ")}`);
}
