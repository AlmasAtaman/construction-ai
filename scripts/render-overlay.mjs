// Render a single PDF page with extracted boxes drawn on top.
// Usage: node scripts/render-overlay.mjs <pdf-path> <page-number>
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { pdf } from "pdf-to-img";
import sharp from "sharp";
import path from "node:path";

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("usage: render-overlay.mjs <pdf-path> <page>");
  process.exit(1);
}
const PDF_PATH = args[0];
const PAGE = parseInt(args[1], 10);

const { extractPage } = await import("../src/lib/extract/page-extract.ts");

const buf = await readFile(PDF_PATH);

// Render base PNG.
const doc = await pdf(buf, { scale: 2 });
let rawPng = null;
let i = 0;
for await (const png of doc) {
  i++;
  if (i === PAGE) {
    rawPng = png;
    break;
  }
}
if (!rawPng) {
  console.error(`page ${PAGE} not found`);
  process.exit(1);
}

const meta = await sharp(rawPng).metadata();
const W = meta.width, H = meta.height;
console.log(`rendered page ${PAGE}: ${W}x${H}px`);

const extracted = await extractPage(buf, PAGE);
console.log(`extract: ${extracted.status} strategy=${extracted.strategy} rooms=${extracted.rooms.length}`);

const colors = {
  traced: "#10b981",
  "sized-from-dimensions": "#f59e0b",
  "table-only": "#ef4444",
  "ai-fallback": "#9ca3af",
};

const svgParts = [];
for (const room of extracted.rooms) {
  if (room.polygonNorm.length < 3) continue;
  const pts = room.polygonNorm.map((p) => `${p.x*W},${p.y*H}`).join(" ");
  const color = colors[room.derivation] ?? "#3b82f6";
  svgParts.push(
    `<polygon points="${pts}" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="3"/>`,
  );
  // Label centered on bbox.
  let xMin=1,yMin=1,xMax=0,yMax=0;
  for (const p of room.polygonNorm) {
    if (p.x < xMin) xMin = p.x;
    if (p.y < yMin) yMin = p.y;
    if (p.x > xMax) xMax = p.x;
    if (p.y > yMax) yMax = p.y;
  }
  const cx = ((xMin+xMax)/2)*W;
  const cy = ((yMin+yMax)/2)*H;
  const lbl = room.label.replace(/[<>&]/g, "");
  svgParts.push(`<text x="${cx}" y="${cy}" font-family="Arial, sans-serif" font-size="14" font-weight="700" fill="${color}" text-anchor="middle" stroke="white" stroke-width="3" paint-order="stroke">${lbl}</text>`);
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svgParts.join("")}</svg>`;

const out = await sharp(rawPng)
  .composite([{ input: Buffer.from(svg), blend: "over" }])
  .png({ compressionLevel: 6 })
  .toBuffer();

await mkdir("/tmp/overlays", { recursive: true });
const outPath = `/tmp/overlays/${path.basename(PDF_PATH, ".pdf")}-p${PAGE}.png`;
await writeFile(outPath, out);
console.log(`wrote ${outPath}`);
