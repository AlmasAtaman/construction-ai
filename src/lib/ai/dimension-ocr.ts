/**
 * AI-vision-based dimension OCR.
 *
 * When dimension callouts are printed on the rasterized portion of a
 * PDF, Tesseract.js misses them — small text at low DPI is unreliable.
 * Claude Haiku 4.5 with vision reads small architectural text far more
 * accurately, at ~$0.005-0.01 per call.
 *
 * Strategy: split the rendered page into N×M grid tiles, send each
 * tile to Haiku, ask for all dimension callouts in the tile with
 * approximate positions. Aggregate.
 *
 * Cost: ~$0.005 × tiles. For a typical commercial plan with a 3×2 grid
 * (6 tiles), that's $0.03/page. With cache, repeats are ~$0.003.
 *
 * We use a strict tool_use schema so the output is structured JSON,
 * not free-form text.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropic } from "@/lib/anthropic";

export interface AiDimensionCallout {
  /** Parsed length in feet. e.g. 12'-6" → 12.5 */
  lengthFt: number;
  /** Original text as printed on the plan. */
  rawText: string;
  /** Inferred orientation. */
  orientation: "horizontal" | "vertical" | "unknown";
  /** Position in PDF page coords (Y up). */
  x: number;
  y: number;
  /** Haiku's self-reported confidence 0..1. */
  confidence: number;
}

export interface OcrTilesResult {
  callouts: AiDimensionCallout[];
  tilesProcessed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  elapsedMs: number;
}

export interface OcrTilesOptions {
  /** Grid size — N columns × M rows of tiles. Default 3×2. */
  cols?: number;
  rows?: number;
  /** Render DPI for the source image. Default 200. */
  dpi?: number;
  /** Tile overlap in PDF points to avoid splitting a callout. Default 30. */
  overlapPt?: number;
  /** Concurrency limit on parallel Haiku calls. Default 4. */
  concurrency?: number;
}

const SYSTEM_PROMPT = `You read architectural drawings. Given an image showing part of a floor plan, extract every dimension callout you can see.

A dimension callout is the architect's printed measurement of a wall, opening, or distance between features. It ALWAYS includes a unit marker:
  - Feet only: prime mark — e.g., "12'", "10'"
  - Feet and inches: prime + double-prime — e.g., "12'-6\\"", "12'11\\"", "10'-0\\""
  - Inches only: double-prime — e.g., "6\\"", "3\\""
  - With fractions: "4'-3 1/2\\""

Visual context: dimension callouts are printed along thin dimension lines that have small ticks at each end pointing to the feature being measured. The text is usually small and either horizontal (measures a horizontal feature) or rotated 90° (measures a vertical feature).

STRICT RULES — DO NOT EXTRACT:
1. Anything WITHOUT a prime or double-prime (', ", ', ") right after the number. Plain numbers like "156" or "134A" are room numbers, NOT dimensions. Reject them.
2. Anything followed by "SF" or "sqft" — those are areas, not lengths.
3. Anything inside or part of a longer string like "1/8\\" = 1'-0\\"" (scale notation).
4. Material codes: P-1, P-2, CPT-1, VCT-1, WSF-1, CG, ST2-1, etc.
5. Sheet numbers, note bullets (1., 2.), or revision marks.
6. Any value < 1' or > 100' unless you're highly confident it's a real dimension.

For each REAL dimension callout you find, return:
  - rawText: exactly as printed (must include the prime/double-prime marker)
  - lengthFt: parsed length in decimal feet (12'-6\\" → 12.5; 4'-3 1/2\\" → 4.292)
  - orientation: "horizontal" (text rotated 0°/180°), "vertical" (rotated 90°/270°), or "unknown"
  - xNorm / yNorm: position in the IMAGE (0..1, origin top-left)
  - confidence: 0..1 — only > 0.7 if you're sure the text has a prime/double-prime marker

If there are no dimension callouts in the image, return an empty array. PRECISION over recall — better to miss a callout than to invent one.`;

const TOOL_SCHEMA: Anthropic.Messages.Tool = {
  name: "record_dimensions",
  description: "Record every dimension callout visible in this image tile.",
  input_schema: {
    type: "object",
    properties: {
      callouts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            rawText: { type: "string" },
            lengthFt: { type: "number" },
            orientation: {
              type: "string",
              enum: ["horizontal", "vertical", "unknown"],
            },
            xNorm: { type: "number" },
            yNorm: { type: "number" },
            confidence: { type: "number" },
          },
          required: [
            "rawText",
            "lengthFt",
            "orientation",
            "xNorm",
            "yNorm",
            "confidence",
          ],
        },
      },
    },
    required: ["callouts"],
  },
};

interface MupdfPath {
  walk: (visitor: {
    moveTo: (x: number, y: number) => void;
    lineTo: (x: number, y: number) => void;
    closePath: () => void;
  }) => void;
}

/**
 * Render PDF page, split into tiles, OCR each via Claude Haiku, return
 * unified dimension callouts in PDF page coords.
 */
export async function ocrDimensionsViaAi(
  pdfBuffer: Buffer,
  pageNumber: number,
  opts: OcrTilesOptions = {},
): Promise<OcrTilesResult> {
  const t0 = Date.now();
  const cols = opts.cols ?? 3;
  const rows = opts.rows ?? 2;
  const dpi = opts.dpi ?? 200;
  const overlapPt = opts.overlapPt ?? 30;
  const concurrency = opts.concurrency ?? 4;

  // 1. Render page via MuPDF.
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(
    new Uint8Array(pdfBuffer),
    "application/pdf",
  );
  const page = doc.loadPage(pageNumber - 1);
  const bounds = page.getBounds();
  const pageWidthPt = bounds[2] - bounds[0];
  const pageHeightPt = bounds[3] - bounds[1];

  const scale = dpi / 72;
  const matrix = (mupdf as unknown as {
    Matrix: { scale: (sx: number, sy: number) => number[] };
  }).Matrix.scale(scale, scale);
  const cs = (mupdf as unknown as { ColorSpace: { DeviceRGB: unknown } })
    .ColorSpace.DeviceRGB;
  const fullPx = (page as unknown as {
    toPixmap: (m: number[], c: unknown) => {
      asPNG: () => Uint8Array;
      getWidth: () => number;
      getHeight: () => number;
      destroy?: () => void;
    };
  }).toPixmap(matrix, cs);
  const fullPng = fullPx.asPNG();
  const fullW = fullPx.getWidth();
  const fullH = fullPx.getHeight();
  fullPx.destroy?.();

  // 2. Split into tiles by re-rendering each tile at the tile's clip box.
  // (Re-rendering is cheaper than splitting the PNG client-side.)
  const sharp = (await import("sharp")).default;
  type Tile = {
    col: number;
    row: number;
    /** Tile bounds in PDF pt space (Y up, origin bottom-left). */
    x0Pt: number;
    y0Pt: number;
    x1Pt: number;
    y1Pt: number;
    /** PNG buffer for the tile. */
    png: Buffer;
  };
  const tiles: Tile[] = [];
  const tileWPt = pageWidthPt / cols;
  const tileHPt = pageHeightPt / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.max(0, c * tileWPt - overlapPt);
      const x1 = Math.min(pageWidthPt, (c + 1) * tileWPt + overlapPt);
      const y0 = Math.max(0, r * tileHPt - overlapPt);
      const y1 = Math.min(pageHeightPt, (r + 1) * tileHPt + overlapPt);
      // Convert pt → image px. Image Y is top-down: imageY = (pageH - pdfY) * pxPerPt
      const pxPerPt = dpi / 72;
      const imgX0 = Math.floor(x0 * pxPerPt);
      const imgY0 = Math.floor((pageHeightPt - y1) * pxPerPt);
      const imgX1 = Math.ceil(x1 * pxPerPt);
      const imgY1 = Math.ceil((pageHeightPt - y0) * pxPerPt);
      const width = Math.max(1, imgX1 - imgX0);
      const height = Math.max(1, imgY1 - imgY0);
      const tilePng = await sharp(Buffer.from(fullPng))
        .extract({ left: imgX0, top: imgY0, width, height })
        // Constrain to a long-side <= 1568 to keep Haiku vision tokens low.
        .resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
      tiles.push({
        col: c,
        row: r,
        x0Pt: x0,
        y0Pt: y0,
        x1Pt: x1,
        y1Pt: y1,
        png: tilePng,
      });
    }
  }

  // 3. OCR each tile via Haiku with prompt caching.
  const anthropic = getAnthropic();
  const callouts: AiDimensionCallout[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;

  async function processTile(t: Tile): Promise<void> {
    try {
      const msg = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2048,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: [TOOL_SCHEMA],
        tool_choice: { type: "tool", name: "record_dimensions" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: t.png.toString("base64"),
                },
              },
              {
                type: "text",
                text: `This is tile (${t.col + 1}/${cols}, ${t.row + 1}/${rows}) of an architectural floor plan. Extract every dimension callout. Use xNorm/yNorm in [0, 1] relative to THIS tile.`,
              },
            ],
          },
        ],
      });
      inputTokens += msg.usage.input_tokens;
      outputTokens += msg.usage.output_tokens;
      cacheRead += msg.usage.cache_read_input_tokens ?? 0;
      cacheWrite += msg.usage.cache_creation_input_tokens ?? 0;

      for (const block of msg.content) {
        if (block.type !== "tool_use" || block.name !== "record_dimensions") continue;
        const raw = block.input as {
          callouts?: {
            rawText: string;
            lengthFt: number;
            orientation: "horizontal" | "vertical" | "unknown";
            xNorm: number;
            yNorm: number;
            confidence: number;
          }[];
        };
        for (const c of raw.callouts ?? []) {
          // Server-side safety net: reject "dimensions" that lack a
          // prime mark, end with SF, or have length 0. Haiku occasionally
          // hallucinates these even with the strict prompt.
          if (!/['"’”′″]/.test(c.rawText)) continue;
          if (/\bsf\b|sqft/i.test(c.rawText)) continue;
          if (!Number.isFinite(c.lengthFt) || c.lengthFt <= 0) continue;
          if (c.confidence < 0.5) continue;
          // Convert tile-normalized position to PDF page coords (Y up).
          const xPt = t.x0Pt + c.xNorm * (t.x1Pt - t.x0Pt);
          const yPt = t.y1Pt - c.yNorm * (t.y1Pt - t.y0Pt);
          callouts.push({
            lengthFt: c.lengthFt,
            rawText: c.rawText,
            orientation: c.orientation,
            x: xPt,
            y: yPt,
            confidence: c.confidence,
          });
        }
      }
    } catch {
      // Ignore tile errors — partial results are still useful.
    }
  }

  // Process tiles with bounded concurrency.
  for (let i = 0; i < tiles.length; i += concurrency) {
    await Promise.all(tiles.slice(i, i + concurrency).map(processTile));
  }

  // 4. Dedupe callouts that fell in overlap regions (same lengthFt
  // within ~5 ft AND within 20 pt of each other).
  callouts.sort((a, b) => a.x - b.x || a.y - b.y);
  const deduped: AiDimensionCallout[] = [];
  for (const c of callouts) {
    const close = deduped.find(
      (d) =>
        Math.abs(d.lengthFt - c.lengthFt) < 0.1 &&
        Math.hypot(d.x - c.x, d.y - c.y) < 20,
    );
    if (!close) deduped.push(c);
  }

  return {
    callouts: deduped,
    tilesProcessed: tiles.length,
    inputTokens,
    outputTokens,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheWrite,
    elapsedMs: Date.now() - t0,
  };
}
