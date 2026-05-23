import { readFile } from "node:fs/promises";
import path from "node:path";
import { detectPageScale } from "../src/lib/extract/page-extract";
import { detectScaleAnchor } from "../src/lib/scale-anchor";

const root = process.cwd();
const file = path.join(root, "uploads", "1779568333798-friend-commercial-plan.pdf");
const PAGE = Number(process.argv[2] ?? 5);

const buf = await readFile(file);

// 1) What detectPageScale returns (the production path).
const detected = await detectPageScale(buf, PAGE);
console.log(`pg${PAGE} detectPageScale:`, JSON.stringify(detected));

// 2) Dump scale-related text fragments to see the notation format on the sheet.
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const doc = await pdfjs.getDocument({
  data: new Uint8Array(buf),
  useWorkerFetch: false,
  isEvalSupported: false,
  useSystemFonts: true,
}).promise;
const page = await doc.getPage(PAGE);
const vp = page.getViewport({ scale: 1 });
const tc = await page.getTextContent();
const SCALE_HINT = /scale|1\s*\/\s*\d|1\s*:\s*\d{2,4}|=\s*\d+\s*['’]|\d+'\s*-\s*\d+"|\d+'/i;
const frags: { text: string; x: number; y: number }[] = [];
for (const item of tc.items as Array<{ str?: string; transform?: number[] }>) {
  const s = (item.str ?? "").trim();
  if (!s || !item.transform) continue;
  frags.push({ text: s, x: item.transform[4], y: item.transform[5] });
}
console.log(`\npg${PAGE} total fragments: ${frags.length}, viewport ${vp.width}x${vp.height}`);
const hits = frags.filter((f) => SCALE_HINT.test(f.text));
console.log(`scale-hint fragments (${hits.length}):`);
for (const h of hits.slice(0, 40)) console.log(`  "${h.text}"  @(${h.x.toFixed(0)},${h.y.toFixed(0)})`);

// 3) Run anchor detection directly to see if it parses any of them.
const anchor = detectScaleAnchor(frags.map((f) => ({ text: f.text, x: f.x, y: f.y })));
console.log(`\ndetectScaleAnchor:`, JSON.stringify(anchor));
