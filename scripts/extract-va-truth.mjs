// Extract ground-truth (room label → sqft) from the VA Medical Center
// benchmark plan by scanning the PDF text layer for "NN SF" callouts
// printed directly inside the floor plan drawing.
//
// The plan prints each room's label on one line and its area ("21 SF",
// "557 SF") on a nearby line. We cluster fragments by Y-coordinate
// proximity to pair them up.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pdfPath = path.resolve(
  __dirname,
  "../tests/fixtures/commercial-bench.pdf",
);

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const data = readFileSync(pdfPath);
const doc = await pdfjs.getDocument({
  data: new Uint8Array(data),
  useWorkerFetch: false,
  isEvalSupported: false,
  useSystemFonts: true,
}).promise;

const SF_RE = /^(\d{1,5})\s*SF$/i;

// Collect rooms across all pages.
const groundTruth = { source: "VA Building 28 RRTP — Sheets 3 of 4", url: "http://www.mdm-construction.com/wp-content/uploads/36C26321R0124-0005006-Drawings-3-of-4.pdf", pages: [] };

for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const fragments = [];
  for (const item of content.items) {
    const s = item.str?.trim();
    if (!s) continue;
    const tx = item.transform[4];
    const ty = item.transform[5];
    const h = item.height ?? Math.abs(item.transform[3] ?? 10);
    const cx = tx + (item.width ?? 0) / 2;
    const cy = viewport.height - (ty + h / 2);
    fragments.push({
      text: s,
      xNorm: cx / viewport.width,
      yNorm: cy / viewport.height,
    });
  }
  // Find every "NN SF" fragment, then locate the closest non-SF text
  // fragment within ~3% Y and to the left as the room label.
  const sfFragments = fragments.filter((f) => SF_RE.test(f.text));
  const roomEntries = [];
  for (const sf of sfFragments) {
    const m = SF_RE.exec(sf.text);
    if (!m) continue;
    const sqft = parseInt(m[1], 10);
    if (sqft < 5 || sqft > 100000) continue; // sanity bounds
    // Gather every non-SF fragment within a tight bubble ABOVE/AT the
    // SF callout (room labels stack vertically above the "NN SF" line)
    // and join them as the room label.
    const nearby = [];
    for (const g of fragments) {
      if (g === sf) continue;
      if (SF_RE.test(g.text)) continue;
      if (g.text.length < 2) continue;
      const dx = Math.abs(g.xNorm - sf.xNorm);
      // SF label is at the bottom of the stack — accept fragments
      // above (yNorm smaller) within 0.04, or same-row within 0.015.
      const dy = sf.yNorm - g.yNorm;
      if (dx > 0.08) continue;
      if (dy < -0.005 || dy > 0.05) continue;
      nearby.push(g);
    }
    // Sort top-down so the joined label reads naturally (e.g., "169 OXYGEN ROOM").
    nearby.sort((a, b) => a.yNorm - b.yNorm);
    const label = nearby.map((g) => g.text).join(" ").replace(/\s+/g, " ").trim();
    if (label) {
      roomEntries.push({
        label,
        sqft,
        xNorm: sf.xNorm,
        yNorm: sf.yNorm,
      });
    }
  }
  if (roomEntries.length > 0) {
    groundTruth.pages.push({
      pageNumber: pageNum,
      rooms: roomEntries,
    });
  }
  console.log(`Page ${pageNum}: ${fragments.length} fragments, ${sfFragments.length} SF callouts, ${roomEntries.length} room entries extracted`);
}

// Choose the page with the most room entries as the primary benchmark page.
const primary = [...groundTruth.pages].sort(
  (a, b) => b.rooms.length - a.rooms.length,
)[0];
console.log(`\nPrimary benchmark page: ${primary.pageNumber} with ${primary.rooms.length} rooms`);
console.log("Sample rooms:");
for (const r of primary.rooms.slice(0, 12)) {
  console.log(`  ${r.label.padEnd(40)} ${r.sqft} SF`);
}

writeFileSync(
  path.resolve(__dirname, "../tests/fixtures/commercial-bench-ground-truth.json"),
  JSON.stringify(groundTruth, null, 2),
);
console.log("\nWrote tests/fixtures/commercial-bench-ground-truth.json");
