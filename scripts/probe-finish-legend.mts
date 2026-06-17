/** Read the finish-code legend: what does each P-n / CT-n mean? */
import fs from "fs";
import { extractTextLayer } from "../src/lib/pdf-render";

const buf = fs.readFileSync("tests/fixtures/friend-commercial-plan.pdf");

for (const pg of [3, 12]) {
  console.log(`\n===== PAGE ${pg} finish text (in reading order, code-adjacent) =====`);
  const { textFragments, pageWidthPt, pageHeightPt } = await extractTextLayer(buf, pg);
  // Sort top-to-bottom, left-to-right (yNorm is already y-down)
  const frags = textFragments
    .filter((f) => f.text.trim().length > 0)
    .map((f) => ({ t: f.text.trim(), x: f.xNorm, y: f.yNorm }))
    .sort((a, b) => (Math.abs(a.y - b.y) > 0.004 ? a.y - b.y : a.x - b.x));
  // Print lines: group fragments on ~same y
  let line: string[] = [];
  let lastY = -1;
  const codeRe = /\b(P-?\d|CT-?\d|VCT|FRP|EPOXY)\b/i;
  for (const f of frags) {
    if (lastY >= 0 && Math.abs(f.y - lastY) > 0.006) {
      const s = line.join(" ");
      if (codeRe.test(s) || /tile|paint|finish|wall|ceiling|floor|base/i.test(s))
        console.log(s.slice(0, 130));
      line = [];
    }
    line.push(f.t);
    lastY = f.y;
  }
}
