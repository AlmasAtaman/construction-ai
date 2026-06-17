import fs from "fs";
import { extractTextLayer } from "../src/lib/pdf-render";

const buf = fs.readFileSync("tests/fixtures/friend-commercial-plan.pdf");
// Check which pages carry finish bubbles, and where on the page
const CODE = /^(P-?\d|CT-?\d|FRP-?\d?)$/i;
for (const pg of [5, 7, 8, 10, 11]) {
  const { textFragments, pageWidthPt, pageHeightPt } = await extractTextLayer(buf, pg);
  const bubbles = textFragments
    .map((f) => ({ t: f.text.trim().replace(/\s+/g, ""), x: f.xNorm, y: f.yNorm }))
    .filter((f) => CODE.test(f.t));
  if (bubbles.length < 3) continue;
  // cluster by rough region (quadrant-ish in normalized space)
  const xs = bubbles.map(b=>b.x), ys = bubbles.map(b=>b.y);
  console.log(`p${pg}: ${bubbles.length} bubbles  xNorm[${Math.min(...xs).toFixed(2)}..${Math.max(...xs).toFixed(2)}] yNorm[${Math.min(...ys).toFixed(2)}..${Math.max(...ys).toFixed(2)}]`);
  // print histogram of y-bands to find which plan view they sit on
  const bands: Record<string, string[]> = {};
  for (const b of bubbles) {
    const band = `y${(Math.floor(b.y*10)/10).toFixed(1)}`;
    (bands[band] ??= []).push(b.t);
  }
  for (const [band, codes] of Object.entries(bands).sort())
    console.log(`    ${band}: ${codes.join(" ")}`);
}
