/** Feasibility: does the Beaver Tails plan carry parseable finish data
 * (a finish schedule/legend mapping rooms → wall finishes)? */
import fs from "fs";
import { extractTextLayer } from "../src/lib/pdf-render";

const buf = fs.readFileSync("tests/fixtures/friend-commercial-plan.pdf");

// Scan every page for finish-related vocabulary.
const FINISH_WORDS = /\b(FINISH|PAINT|\bP-?\d|FRP|TILE|CT-?\d|PT-?\d|EPOXY|VINYL|WALL TYPE|SCHEDULE|FINISH PLAN|FINISH LEGEND)\b/i;
for (let pg = 1; pg <= 34; pg++) {
  try {
    const { textFragments } = await extractTextLayer(buf, pg);
    const hits = textFragments.filter((f) => FINISH_WORDS.test(f.text));
    if (hits.length >= 3) {
      const sample = [...new Set(hits.map((h) => h.text.trim()))].slice(0, 16);
      console.log(`p${pg}: ${hits.length} finish-ish fragments | ${sample.join(" · ")}`);
    }
  } catch {}
}
