/**
 * High-resolution single-call floor plan takeoff using Opus 4.7's
 * native 2576-pixel image support + Set-of-Marks prompting.
 *
 * Why this exists: we were resizing pages to 1568px to "save tokens"
 * — but at that resolution, printed dimension callouts on a typical
 * commercial floor plan are 4-6 pixels tall, which the model can't
 * reliably read. Opus 4.7 supports images up to 2576px on the long
 * edge (2.7× more pixels = ~7× better small-text legibility), and
 * Anthropic specifically calls out that this unlocks accuracy on
 * "architecture diagrams and other visual input where fine detail
 * matters" (CharXiv 68.7% → 82.1%).
 *
 * Approach:
 *   1. Render the page at high enough DPI to put it at 2576px max edge.
 *   2. Overlay a coordinate grid (Set-of-Marks) so the model can refer
 *      to spatial regions by grid cell.
 *   3. ALSO overlay numbered markers at every detected room label
 *      position (dense labeling at "decision points" — the technique
 *      from the floor-plan-VLM paper).
 *   4. Send ONE call to Opus 4.7 asking the model to READ the printed
 *      dimensions on the plan and produce a room schedule. We do NOT
 *      ask it to estimate from pixels — we ask it to read the
 *      architect's printed numbers.
 *
 * Cost: ~$0.15/page (one call) vs $1.50/page (15 per-room calls).
 *
 * Accuracy hypothesis: when the AI can READ printed dimensions
 * directly (rather than visually estimating room sizes), it produces
 * architect-grade measurements. The bottleneck has been small text
 * being too small to read at low resolution.
 */

import type { Anthropic } from "@anthropic-ai/sdk";
import { getAnthropic } from "@/lib/anthropic";

export interface HighResRoomMeasurement {
  /** Room label as printed on the plan. */
  label: string;
  /** Floor area in sqft. */
  floorAreaSqft: number;
  /** Width in feet, if a dimension callout was readable. */
  widthFt: number | null;
  /** Height in feet, if a dimension callout was readable. */
  heightFt: number | null;
  /** Wall area = perimeter × ceiling height − openings, in sqft. */
  wallAreaSqft: number | null;
  /** Ceiling height in feet. Default 9 ft if not labeled. */
  ceilingHeightFt: number;
  /** Number of doors visible in this room. */
  doors: number;
  /** Number of windows. */
  windows: number;
  /**
   * How the dimensions were derived. "printed-dimensions" is highest
   * accuracy (read directly from architect's callouts); "scaled-pixels"
   * means the AI measured pixel distances using the scale notation;
   * "estimate" means visual size estimate.
   */
  basis: "printed-dimensions" | "scaled-pixels" | "estimate";
  confidence: number;
  /** Approximate grid cell position (Set-of-Marks reference). */
  gridCell: string;
  notes?: string;
}

export interface HighResTakeoffResult {
  /** Plan scale as detected (e.g., "1/8\" = 1'-0\""). */
  scale: string | null;
  /** Rooms found, sorted by area descending. */
  rooms: HighResRoomMeasurement[];
  /** Total building footprint estimate. */
  totalSqft: number;
  /** Optional cross-check: count of doors/windows/fixtures. */
  symbols: { type: string; count: number }[];
  /** Pixel dimensions of the rendered + annotated image. */
  imageWidthPx: number;
  imageHeightPx: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  elapsedMs: number;
  /** What the AI noted at the end of the run (limitations, etc). */
  aiNotes?: string;
}

export interface HighResTakeoffInput {
  pdfBuffer: Buffer;
  pageNumber: number;
  /** Target long-edge pixels. Default 2576 (Opus 4.7 max). */
  maxImagePx?: number;
  /** Grid divisions for Set-of-Marks overlay. Default 10×10. */
  gridDivisions?: number;
  /** Use Opus 4.7 (best accuracy) vs Sonnet 4.6 (~5× cheaper). */
  model?: "claude-opus-4-7" | "claude-sonnet-4-5";
  /**
   * Optional list of room-label positions (from PDF text layer) for
   * Set-of-Marks dense labeling.
   */
  roomLabelPositions?: { label: string; xNorm: number; yNorm: number }[];
}

const SYSTEM_PROMPT = `You are a senior commercial estimator measuring a floor plan. Your goal is to produce a complete ROOM SCHEDULE with floor areas, wall areas, and fixture counts — using the architect's PRINTED dimensions as the source of truth.

The image you are given has:
- The original floor plan rendered at high resolution
- A coordinate grid overlay (numbered columns A-J, rows 0-9) for spatial reference
- Numbered orange markers at every detected room-label position (use these to confirm room count)

YOUR TASK:
1. Identify every named room. Use ONLY actual room labels (KITCHEN, MASTER BEDROOM, BATH, etc.) — ignore detail-callout codes (E1, D19, W18, S5 are NOT rooms; they reference detail sheets).
2. For each room, find dimension callouts INSIDE or adjacent to that room — these are printed measurements like "12'-6"" or "14'-0"". The architect's exact dimensions.
3. Compute floor area = width × height in square feet. If you can read both dimensions from printed callouts, that's "printed-dimensions" basis (highest accuracy). If you have to measure pixels using the plan's scale, that's "scaled-pixels". If you can't get either, "estimate".
4. Report the grid cell where each room is centered (e.g., "C4" or "F7").
5. Count doors, windows, and fixtures (toilets, sinks, lights) — these are extras the painter accounts for.

PRECISION RULES:
- Use printed dimensions whenever available. Do NOT estimate when you can read a number.
- Walls between rooms count for BOTH rooms — don't omit a room just because it shares walls.
- A 3-ft door opening is the standard scale check: door symbols should look ~3 ft wide.
- Default ceiling height: 9 ft residential, 9-10 ft commercial. Override only if the plan states otherwise.

Return EVERY room in the report_takeoff tool. Be EXHAUSTIVE — typical residential plans have 12-20 rooms, commercial plans have 20-60 rooms. Smaller spaces count too: closets, pantries, water-heater enclosures, vestibules, alcoves, mechanical chases. If you can see a wall-bounded space with a label or that's clearly enclosed, list it.

Double-check before finishing: scan the entire image once more, including small spaces near the perimeter. Are you missing any rooms? Common ones to verify: FOYER/ENTRY, every CLOSET, POWDER ROOM, MECHANICAL/UTILITY, WATER HEATER, PANTRY, STAIRWELL, HALLWAY/CORRIDOR(s), W.I.C., GARAGE.`;

const TAKEOFF_TOOL: Anthropic.Messages.Tool = {
  name: "report_takeoff",
  description: "Report every room on the floor plan with measurements.",
  input_schema: {
    type: "object",
    properties: {
      scale: {
        type: "string",
        description: "Plan scale as printed (e.g., '1/8\" = 1'-0\"') or 'unknown' if not visible.",
      },
      rooms: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Room name as printed." },
            floorAreaSqft: { type: "number", minimum: 1 },
            widthFt: { type: ["number", "null"] },
            heightFt: { type: ["number", "null"] },
            wallAreaSqft: { type: ["number", "null"] },
            ceilingHeightFt: { type: "number", minimum: 6, maximum: 30 },
            doors: { type: "integer", minimum: 0 },
            windows: { type: "integer", minimum: 0 },
            basis: { type: "string", enum: ["printed-dimensions", "scaled-pixels", "estimate"] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            gridCell: { type: "string", description: "e.g. C4, F7" },
            notes: { type: "string" },
          },
          required: ["label", "floorAreaSqft", "widthFt", "heightFt", "wallAreaSqft", "ceilingHeightFt", "doors", "windows", "basis", "confidence", "gridCell"],
        },
      },
      symbols: {
        type: "array",
        description: "Counts of fixtures, outlets, etc. visible across the plan.",
        items: {
          type: "object",
          properties: {
            type: { type: "string" },
            count: { type: "integer", minimum: 0 },
          },
          required: ["type", "count"],
        },
      },
      notes: { type: "string", description: "Any caveats — scale was unclear, dimensions cut off, etc." },
    },
    required: ["rooms"],
  },
};

interface MupdfPath {
  walk: (visitor: {
    moveTo: (x: number, y: number) => void;
    lineTo: (x: number, y: number) => void;
    closePath: () => void;
  }) => void;
}

export async function runHighResTakeoff(
  input: HighResTakeoffInput,
): Promise<HighResTakeoffResult> {
  const t0 = Date.now();
  const maxPx = input.maxImagePx ?? 2576;
  const gridN = input.gridDivisions ?? 10;
  const model = input.model ?? "claude-opus-4-7";

  // 1. Render the page at the highest useful DPI.
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(
    new Uint8Array(input.pdfBuffer),
    "application/pdf",
  );
  const page = doc.loadPage(input.pageNumber - 1);
  const bounds = page.getBounds();
  const pageW = bounds[2] - bounds[0];
  const pageH = bounds[3] - bounds[1];

  // Pick DPI to land at maxPx on the longer edge.
  const longerPt = Math.max(pageW, pageH);
  const targetPxPerPt = maxPx / longerPt;
  const dpi = targetPxPerPt * 72;
  const matrix = (mupdf as unknown as {
    Matrix: { scale: (sx: number, sy: number) => number[] };
  }).Matrix.scale(targetPxPerPt, targetPxPerPt);
  const cs = (mupdf as unknown as { ColorSpace: { DeviceRGB: unknown } })
    .ColorSpace.DeviceRGB;
  const pixmap = (page as unknown as {
    toPixmap: (m: number[], c: unknown) => {
      asPNG: () => Uint8Array;
      getWidth: () => number;
      getHeight: () => number;
      destroy?: () => void;
    };
  }).toPixmap(matrix, cs);
  const rawPng = Buffer.from(pixmap.asPNG());
  const pxW = pixmap.getWidth();
  const pxH = pixmap.getHeight();
  pixmap.destroy?.();

  // 2. Overlay grid + room-label markers via sharp + SVG.
  const sharp = (await import("sharp")).default;
  const svgOverlay = buildOverlaySvg(
    pxW,
    pxH,
    gridN,
    input.roomLabelPositions ?? [],
  );
  const annotated = await sharp(rawPng)
    .composite([{ input: Buffer.from(svgOverlay), top: 0, left: 0 }])
    .png()
    .toBuffer();

  // Optional debug: save the annotated image so we can see what the AI saw.
  if (process.env.HIGH_RES_DEBUG_DIR) {
    const fs = await import("node:fs");
    const debugPath = `${process.env.HIGH_RES_DEBUG_DIR}/annotated-p${input.pageNumber}.png`;
    fs.writeFileSync(debugPath, annotated);
  }

  // 3. Single Opus call.
  const anthropic = getAnthropic();
  const msg = await anthropic.messages.create({
    model,
    max_tokens: 8192,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [TAKEOFF_TOOL],
    tool_choice: { type: "tool", name: "report_takeoff" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: annotated.toString("base64"),
            },
          },
          {
            type: "text",
            text: `Plan dimensions: ${pageW.toFixed(0)} × ${pageH.toFixed(0)} PDF points, rendered at ${dpi.toFixed(0)} DPI = ${pxW} × ${pxH} pixels. ${input.roomLabelPositions?.length ?? 0} room labels are pre-marked with orange numbered circles. Read every printed dimension callout you can. Use printed dimensions whenever possible.`,
          },
        ],
      },
    ],
  });

  let tool: {
    scale?: string;
    rooms?: HighResRoomMeasurement[];
    symbols?: { type: string; count: number }[];
    notes?: string;
  } | null = null;
  for (const b of msg.content) {
    if (b.type === "tool_use" && b.name === "report_takeoff") {
      tool = b.input as typeof tool;
    }
  }

  const rooms = tool?.rooms ?? [];
  rooms.sort((a, b) => b.floorAreaSqft - a.floorAreaSqft);

  return {
    scale: tool?.scale ?? null,
    rooms,
    totalSqft: rooms.reduce((a, r) => a + r.floorAreaSqft, 0),
    symbols: tool?.symbols ?? [],
    imageWidthPx: pxW,
    imageHeightPx: pxH,
    inputTokens: msg.usage.input_tokens,
    outputTokens: msg.usage.output_tokens,
    cacheReadInputTokens: msg.usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: msg.usage.cache_creation_input_tokens ?? 0,
    elapsedMs: Date.now() - t0,
    aiNotes: tool?.notes,
  };
}

/**
 * Build an SVG that overlays a coordinate grid (columns A-J, rows 0-9)
 * and numbered orange markers at each room-label position. The model
 * can refer to grid cells in its output for spatial verification.
 */
function buildOverlaySvg(
  pxW: number,
  pxH: number,
  gridN: number,
  labels: { label: string; xNorm: number; yNorm: number }[],
): string {
  const cellW = pxW / gridN;
  const cellH = pxH / gridN;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pxW}" height="${pxH}">`,
  );
  // Grid lines (thin, semi-transparent).
  for (let i = 1; i < gridN; i++) {
    const x = Math.round(i * cellW);
    const y = Math.round(i * cellH);
    parts.push(
      `<line x1="${x}" y1="0" x2="${x}" y2="${pxH}" stroke="#3b82f6" stroke-width="1" opacity="0.18"/>`,
    );
    parts.push(
      `<line x1="0" y1="${y}" x2="${pxW}" y2="${y}" stroke="#3b82f6" stroke-width="1" opacity="0.18"/>`,
    );
  }
  // Cell labels (A0, A1, ..., J9) in the top-left corner of each cell.
  for (let row = 0; row < gridN; row++) {
    for (let col = 0; col < gridN; col++) {
      const letter = String.fromCharCode(65 + col);
      const num = row.toString();
      const cx = Math.round(col * cellW + 6);
      const cy = Math.round(row * cellH + 14);
      parts.push(
        `<text x="${cx}" y="${cy}" font-family="monospace" font-size="11" fill="#3b82f6" opacity="0.6">${letter}${num}</text>`,
      );
    }
  }
  // Room-label markers — orange numbered circles at each label position.
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    const cx = Math.round(l.xNorm * pxW);
    const cy = Math.round((1 - l.yNorm) * pxH); // labels are in PDF Y-up, image is Y-down
    const r = 12;
    parts.push(
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#f97316" stroke="white" stroke-width="2" opacity="0.85"/>`,
    );
    parts.push(
      `<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-family="sans-serif" font-size="${r}" font-weight="bold" fill="white">${i + 1}</text>`,
    );
  }
  parts.push("</svg>");
  return parts.join("\n");
}
