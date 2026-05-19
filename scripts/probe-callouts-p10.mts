import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseDimensionCallouts } from "../src/lib/dimension-callouts.js";

const buf = await readFile(path.join(process.cwd(), "tests/fixtures/DP-BP-new-home-sample-drawings.pdf"));
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const doc = await pdfjs.getDocument({
  data: new Uint8Array(buf), useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true,
}).promise;
const page = await doc.getPage(10);
const tc = await page.getTextContent();
const inputs = (tc.items as Array<{str:string;transform:number[]}>).map(it => ({
  text: (it.str ?? "").trim(),
  x: it.transform[4],
  y: it.transform[5],
  rotation: Math.atan2(it.transform[1] ?? 0, it.transform[0] ?? 1),
}));
const callouts = parseDimensionCallouts(inputs);
console.log(`callouts: ${callouts.length}`);
const summary = new Map<string, number>();
for (const c of callouts) {
  const k = c.orientation ?? "?";
  summary.set(k, (summary.get(k) ?? 0) + 1);
}
console.log(`orientations:`, Object.fromEntries(summary));
// Sample
for (const c of callouts.slice(0, 30)) {
  console.log(`  "${c.rawText.padEnd(12)}" ${c.lengthFt.toFixed(2)}ft  pos=(${Math.round(c.x)},${Math.round(c.y)}) orient=${c.orientation ?? "?"}`);
}

// For each room label, list nearby callouts within 200 pt
const LABELS = [
  { name: "LIVING ROOM", x: 313, y: 391 },
  { name: "NOOK", x: 459, y: 343 },
  { name: "KITCHEN", x: 451, y: 486 },
  { name: "BATH", x: 293, y: 564 },
  { name: "WOOD PORCH", x: 188, y: 464 },
];
for (const L of LABELS) {
  console.log(`\n=== ${L.name} at (${L.x}, ${L.y}) — callouts within 200 pt ===`);
  const near = callouts.filter(c => {
    const dx = c.x - L.x, dy = c.y - L.y;
    return dx*dx + dy*dy <= 200*200;
  }).sort((a,b) => Math.hypot(a.x-L.x, a.y-L.y) - Math.hypot(b.x-L.x, b.y-L.y));
  for (const c of near.slice(0, 15)) {
    const dx = c.x - L.x, dy = c.y - L.y;
    console.log(`  ${c.lengthFt.toFixed(2)}ft  dx=${Math.round(dx).toString().padStart(4)} dy=${Math.round(dy).toString().padStart(4)} dist=${Math.round(Math.hypot(dx,dy)).toString().padStart(3)} orient=${c.orientation ?? "?"} "${c.rawText}"`);
  }
}
