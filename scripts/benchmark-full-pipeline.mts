// End-to-end benchmark: extract vector room candidates, then for each
// candidate run Opus per-room measurement with scale + callouts context.
// Report per-room accuracy plus total cost.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cr = await import("../src/lib/commercial-rooms.ts");
const mr = await import("../src/lib/ai/measure-with-context.ts");

const pdfPath = process.argv[2];
const pageNumber = parseInt(process.argv[3] ?? "1", 10);
const maxRooms = parseInt(process.argv[4] ?? "20", 10);

if (!pdfPath) {
  console.error("usage: tsx scripts/benchmark-full-pipeline.mts <pdf> [page] [maxRooms]");
  process.exit(1);
}

const buf = readFileSync(pdfPath);
console.log(`\n=== Benchmark: ${path.basename(pdfPath)} page ${pageNumber} ===\n`);

// 1. Vector extraction.
console.log(`Step 1: extracting vector room candidates...`);
const extractT0 = Date.now();
const result = await cr.extractCommercialRoomCandidates(
  Buffer.from(buf),
  pageNumber,
  { enableAiOcr: false },
);
const extractMs = Date.now() - extractT0;
console.log(`  ${result.candidates.length} candidates, ${result.dimensionCallouts.length} callouts in ${extractMs}ms`);
console.log(`  Scale: ${result.scaleAnchor?.label ?? "(none)"}`);

if (!result.scaleAnchor) {
  console.log("ERROR: no scale anchor detected — can't measure accurately");
  process.exit(1);
}

// 2. Render the page once at high DPI for the AI to crop.
console.log(`\nStep 2: rendering page for AI crops...`);
const mupdf = await import("mupdf");
const doc = mupdf.Document.openDocument(new Uint8Array(buf), "application/pdf");
const page = doc.loadPage(pageNumber - 1);
const bounds = page.getBounds();
const pageW = bounds[2] - bounds[0];
const pageH = bounds[3] - bounds[1];
const renderDpi = 150;
const renderScale = renderDpi / 72;
const matrix = mupdf.Matrix.scale(renderScale, renderScale);
const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB);
const pageImagePng = Buffer.from(pixmap.asPNG());
const pageImagePx = { w: pixmap.getWidth(), h: pixmap.getHeight() };
console.log(`  Rendered ${pageImagePx.w}×${pageImagePx.h} px`);

// 3. Select rooms to measure — drop low-confidence Voronoi-only candidates
// (label clusters that didn't land in any face).
const labelGroups = new Map<string, typeof result.candidates>();
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}
for (const c of result.candidates) {
  const key = normalize(c.label);
  if (!labelGroups.has(key)) labelGroups.set(key, []);
  labelGroups.get(key)!.push(c);
}
// Pick the highest-confidence candidate per unique label.
const unique = [...labelGroups.values()].map(
  (group) => group.sort((a, b) => b.confidence - a.confidence)[0],
);

// Sort by confidence desc and take top N.
const toMeasure = unique
  .sort((a, b) => b.confidence - a.confidence)
  .slice(0, maxRooms);
console.log(`\nStep 3: measuring ${toMeasure.length} rooms with Opus + context...`);

// 4. For each candidate, find nearby callouts and run Opus measurement.
const measurements: {
  candidate: typeof result.candidates[number];
  measurement: Awaited<ReturnType<typeof mr.measureRoomWithContext>>;
}[] = [];
let totalInputTokens = 0;
let totalOutputTokens = 0;
const cropHalfPt = 0.16 * Math.max(pageW, pageH); // matches CROP_SIZE_NORM / 2

for (let i = 0; i < toMeasure.length; i++) {
  const c = toMeasure[i];
  // Callouts whose midpoint is within the crop area
  const nearbyCallouts = result.dimensionCallouts
    .filter((d) => Math.abs(d.x - c.x) < cropHalfPt && Math.abs(d.y - c.y) < cropHalfPt)
    .slice(0, 12)
    .map((d) => ({
      rawText: d.rawText,
      lengthFt: d.lengthFt,
      xOffsetNorm: (d.x - c.x) / (cropHalfPt * 2),
      yOffsetNorm: (d.y - c.y) / (cropHalfPt * 2),
      orientation: d.orientation,
    }));

  process.stdout.write(`  [${i + 1}/${toMeasure.length}] "${c.label.slice(0, 30)}"... `);
  try {
    const m = await mr.measureRoomWithContext({
      pageImageBase64: pageImagePng.toString("base64"),
      pageImageMediaType: "image/png",
      pageWidthPx: pageImagePx.w,
      pageHeightPx: pageImagePx.h,
      label: c.label,
      xNorm: c.x / pageW,
      yNorm: 1 - c.y / pageH, // pdfjs Y is up; image Y is down
      ptPerFoot: result.scaleAnchor.ptPerFoot,
      scaleLabel: result.scaleAnchor.label,
      nearbyCallouts,
      geometricAreaHint: c.areaSqft ?? undefined,
    });
    measurements.push({ candidate: c, measurement: m });
    totalInputTokens += m.inputTokens;
    totalOutputTokens += m.outputTokens;
    console.log(
      `${m.floorAreaSqft?.toFixed(0) ?? "?"} sqft, basis=${m.measurementBasis}, conf=${m.confidence.toFixed(2)}`,
    );
  } catch (err) {
    console.log(`failed: ${(err as Error).message}`);
  }
}

// 5. Cost.
// Opus 4.7 pricing approximation: ~$15/M input, ~$75/M output
const costInput = (totalInputTokens / 1_000_000) * 15;
const costOutput = (totalOutputTokens / 1_000_000) * 75;
console.log(`\n=== Results ===`);
console.log(`Total tokens: ${totalInputTokens} input / ${totalOutputTokens} output`);
console.log(`Estimated cost: $${(costInput + costOutput).toFixed(3)}`);

console.log(`\n=== Per-room measurements ===`);
console.log(`Label                              W ft   H ft   Floor sqft   Basis            Conf`);
console.log(`${"─".repeat(98)}`);
for (const { candidate: c, measurement: m } of measurements) {
  const label = c.label.slice(0, 32).padEnd(33);
  const w = m.widthFt?.toFixed(1).padStart(6) ?? "   ?  ";
  const h = m.heightFt?.toFixed(1).padStart(6) ?? "   ?  ";
  const area = m.floorAreaSqft?.toFixed(0).padStart(10) ?? "        ?";
  const basis = m.measurementBasis.padEnd(17);
  const conf = m.confidence.toFixed(2);
  console.log(`${label}${w} ${h}    ${area}   ${basis}${conf}`);
}

// Summary by measurement basis
const byBasis = new Map<string, number>();
for (const m of measurements) {
  byBasis.set(
    m.measurement.measurementBasis,
    (byBasis.get(m.measurement.measurementBasis) ?? 0) + 1,
  );
}
console.log(`\n=== Measurement basis breakdown ===`);
for (const [basis, count] of byBasis) {
  console.log(`  ${basis.padEnd(20)} ${count}`);
}

// Write out detailed JSON for review
const outPath = path.resolve(
  path.dirname(pdfPath),
  `${path.basename(pdfPath, ".pdf")}-p${pageNumber}-benchmark.json`,
);
writeFileSync(
  outPath,
  JSON.stringify(
    {
      pdf: path.basename(pdfPath),
      page: pageNumber,
      scaleAnchor: result.scaleAnchor,
      candidateCount: result.candidates.length,
      calloutCount: result.dimensionCallouts.length,
      measurements: measurements.map((m) => ({
        label: m.candidate.label,
        labelXNorm: m.candidate.x / pageW,
        labelYNorm: m.candidate.y / pageH,
        widthFt: m.measurement.widthFt,
        heightFt: m.measurement.heightFt,
        floorAreaSqft: m.measurement.floorAreaSqft,
        wallAreaSqft: m.measurement.wallAreaSqft,
        ceilingHeightFt: m.measurement.ceilingHeightFt,
        doors: m.measurement.doors,
        windows: m.measurement.windows,
        basis: m.measurement.measurementBasis,
        confidence: m.measurement.confidence,
        notes: m.measurement.notes,
      })),
      cost: { input: totalInputTokens, output: totalOutputTokens, usd: costInput + costOutput },
    },
    null,
    2,
  ),
);
console.log(`\nDetailed results: ${outPath}`);
