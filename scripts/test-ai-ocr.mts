// Test AI-vision OCR for dimensions on the VA plan.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ai = await import("../src/lib/ai/dimension-ocr.ts");
const { ocrDimensionsViaAi } = ai;

const pdfPath =
  process.argv[2] ??
  path.resolve(__dirname, "../tests/fixtures/commercial-bench.pdf");
const pageNumber = parseInt(process.argv[3] ?? "1", 10);
const cols = parseInt(process.argv[4] ?? "3", 10);
const rows = parseInt(process.argv[5] ?? "2", 10);
const buf = readFileSync(pdfPath);

console.log(`AI-OCR'ing ${path.basename(pdfPath)} page ${pageNumber} (${cols}×${rows} tiles)…`);
const result = await ocrDimensionsViaAi(Buffer.from(buf), pageNumber, {
  cols,
  rows,
  concurrency: 4,
});

console.log(`\nTiles processed: ${result.tilesProcessed}`);
console.log(`Callouts extracted: ${result.callouts.length}`);
console.log(`Tokens — input: ${result.inputTokens}, output: ${result.outputTokens}`);
console.log(`Cache — read: ${result.cacheReadInputTokens}, write: ${result.cacheCreationInputTokens}`);
const costInput = (result.inputTokens / 1_000_000) * 1.0; // Haiku input price approx
const costOutput = (result.outputTokens / 1_000_000) * 5.0; // Haiku output price approx
console.log(`Est. cost: $${(costInput + costOutput).toFixed(4)}`);
console.log(`Time: ${result.elapsedMs} ms`);

if (result.callouts.length > 0) {
  console.log(`\nAll callouts:`);
  for (const c of result.callouts) {
    console.log(
      `  ${c.rawText.padEnd(14)} → ${c.lengthFt.toFixed(2)} ft  ${c.orientation.padEnd(10)}  at (${c.x.toFixed(0)}, ${c.y.toFixed(0)})  conf=${c.confidence.toFixed(2)}`,
    );
  }

  // Histogram
  console.log(`\nLength histogram:`);
  const hist = new Map<number, number>();
  for (const c of result.callouts) {
    const r = Math.round(c.lengthFt);
    hist.set(r, (hist.get(r) ?? 0) + 1);
  }
  for (const [ft, n] of [...hist.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${ft.toString().padStart(3)} ft: ${n.toString().padStart(3)} ${"#".repeat(Math.min(40, n))}`);
  }
}
