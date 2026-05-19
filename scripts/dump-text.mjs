import { readFile } from "node:fs/promises";
const file = "/Users/almas/Documents/construction-ai/tests/fixtures/friend-commercial-plan.pdf";
const buf = await readFile(file);
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const doc = await pdfjs.getDocument({
  data: new Uint8Array(buf), useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true,
}).promise;
const pages = parseInt(process.argv[2] ?? "1", 10);
const list = process.argv.slice(2).map(s => parseInt(s, 10));
for (const p of list) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  // Sort items roughly top-to-bottom then left-to-right.
  const items = tc.items.map(it => ({
    text: (it.str ?? ""),
    x: it.transform[4],
    y: it.transform[5],
  })).filter(i => i.text.trim().length > 0);
  // Group items by y-band (within 5 pt)
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  console.log(`\n========== PAGE ${p} ==========`);
  let prevY = null;
  const line = [];
  function flush() {
    if (line.length > 0) console.log(line.join(" "));
    line.length = 0;
  }
  for (const it of items) {
    if (prevY === null || Math.abs(it.y - prevY) > 5) {
      flush();
      prevY = it.y;
    }
    line.push(it.text.trim());
  }
  flush();
}
