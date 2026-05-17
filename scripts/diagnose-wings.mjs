/**
 * Diagnostic: are the unfilled left/right wings of commercial-bench.pdf
 * (a) scope-limited (no labels printed there) or (b) resolution-limited
 * (labels exist but the 1568px takeoff render can't read them)?
 *
 * Renders page 1 at 2576px (Opus 4.7's max), crops three vertical strips
 * (left wing 0-30%, center 30-70%, right wing 70-100%), and asks Claude
 * to list every room label visible in each strip. Compare with the
 * labels the AI takeoff currently produces (all in the center band) to
 * decide which fix is appropriate.
 *
 * Cost: one Opus 4.7 call with 3 images, ~$0.10. Run with:
 *   node scripts/diagnose-wings.mjs
 *
 * Requires ANTHROPIC_API_KEY in .env.local (already set).
 */
import fs from "node:fs";
import path from "node:path";

const PDF = path.join(
  process.cwd(),
  "tests/fixtures/commercial-bench.pdf",
);
const TARGET_PX = 2576;

// Manual .env.local load — keeping the script dependency-free.
function loadEnv() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY missing from .env.local");
  process.exit(1);
}

const pdfBuf = fs.readFileSync(PDF);

// --- Render the page at high DPI -------------------------------------
const mupdf = await import("mupdf");
const doc = mupdf.Document.openDocument(
  new Uint8Array(pdfBuf),
  "application/pdf",
);
const page = doc.loadPage(0); // page 1
const bounds = page.getBounds();
const pageW = bounds[2] - bounds[0];
const pageH = bounds[3] - bounds[1];
const longer = Math.max(pageW, pageH);
const scale = TARGET_PX / longer;
const matrix = mupdf.Matrix.scale(scale, scale);
const cs = mupdf.ColorSpace.DeviceRGB;
const pixmap = page.toPixmap(matrix, cs);
const fullPng = Buffer.from(pixmap.asPNG());
const pxW = pixmap.getWidth();
const pxH = pixmap.getHeight();
console.log(`Rendered page 1 at ${pxW}×${pxH}px`);

// --- Crop into three vertical strips ---------------------------------
const sharp = (await import("sharp")).default;
const stripWidth = Math.floor(pxW / 3);
const crops = {
  left: await sharp(fullPng)
    .extract({ left: 0, top: 0, width: stripWidth, height: pxH })
    .jpeg({ quality: 88 })
    .toBuffer(),
  center: await sharp(fullPng)
    .extract({ left: stripWidth, top: 0, width: stripWidth, height: pxH })
    .jpeg({ quality: 88 })
    .toBuffer(),
  right: await sharp(fullPng)
    .extract({
      left: stripWidth * 2,
      top: 0,
      width: pxW - stripWidth * 2,
      height: pxH,
    })
    .jpeg({ quality: 88 })
    .toBuffer(),
};
for (const [k, b] of Object.entries(crops)) {
  console.log(
    `  ${k}: ${(b.length / 1024).toFixed(0)} KB JPEG`,
  );
}

// --- Ask Claude --------------------------------------------------------
const Anthropic = (await import("@anthropic-ai/sdk")).default;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const sysPrompt = `You are reading an architectural floor plan. For each image I send, list EVERY room label you can read printed on the plan — room names, room numbers, or both. One label per line, no commentary.

If a strip clearly has no rooms (just title block, schedule table, or blank space), say "NO ROOMS VISIBLE" and nothing else.`;

console.log("\nAsking Claude what labels exist in each strip...\n");
const resp = await client.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 2048,
  system: sysPrompt,
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "STRIP 1 — LEFT third of the page:" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: crops.left.toString("base64"),
          },
        },
        { type: "text", text: "STRIP 2 — CENTER third of the page:" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: crops.center.toString("base64"),
          },
        },
        { type: "text", text: "STRIP 3 — RIGHT third of the page:" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: crops.right.toString("base64"),
          },
        },
        {
          type: "text",
          text: "For each strip, list every visible room label in this format:\n\nSTRIP 1 LEFT:\n- LABEL\n- LABEL\n\nSTRIP 2 CENTER:\n- LABEL\n\nSTRIP 3 RIGHT:\n- LABEL",
        },
      ],
    },
  ],
});

const out = resp.content
  .filter((b) => b.type === "text")
  .map((b) => b.text)
  .join("\n");

console.log(out);
console.log(
  `\n--- usage --- input: ${resp.usage.input_tokens} tok, output: ${resp.usage.output_tokens} tok`,
);
const estCost =
  (resp.usage.input_tokens * 15) / 1_000_000 +
  (resp.usage.output_tokens * 75) / 1_000_000;
console.log(`Estimated cost: $${estCost.toFixed(3)}`);
