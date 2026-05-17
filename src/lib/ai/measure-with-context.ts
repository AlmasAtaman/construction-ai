/**
 * High-accuracy per-room measurement with deterministic context.
 *
 * The vector pipeline gives us:
 *   - Room label + approximate position (good identification)
 *   - The plan's scale anchor (1/8" = 1'-0", etc.)
 *   - Every dimension callout printed on the plan (with positions)
 *
 * Instead of asking the AI to guess room size from pixels, we feed it
 * the architect's printed measurements that are inside or near the
 * room. The AI's job becomes: "given these printed numbers, identify
 * the room's overall length and width, and report area in square feet."
 *
 * Why this works:
 *   - The architect's printed dimensions are GROUND TRUTH. The AI
 *     doesn't measure pixels; it reads numbers.
 *   - The scale anchor lets us cross-check: a wall the AI claims is
 *     12'-6" must occupy ~112 pt at 9 pt/ft, plausibility-check.
 *   - Vision is still needed because the AI must DECIDE which
 *     printed dimensions belong to this room vs. neighboring rooms
 *     and which are interior partitions vs. overall building extents.
 *
 * Model: Claude Opus 4.7. It's ~6× more expensive than Sonnet but
 * dramatically better at small-text floor-plan reading.
 */

import { getAnthropic } from "@/lib/anthropic";
import { cropImageAroundPoint } from "@/lib/pdf-crop";

const MEASUREMENT_MODEL = "claude-opus-4-7";
const CROP_SIZE_NORM = 0.32;
const CROP_OUTPUT_LONG_EDGE_PX = 1568;

export interface ContextualCallout {
  rawText: string;
  lengthFt: number;
  /** Position relative to the CROP center (-1..1 in each axis). */
  xOffsetNorm: number;
  yOffsetNorm: number;
  orientation: "h" | "v" | null;
}

export interface MeasureRoomInput {
  pageImageBase64: string;
  pageImageMediaType: "image/jpeg" | "image/png";
  pageWidthPx: number;
  pageHeightPx: number;
  /** Room label as printed (e.g., "CORRIDOR CE-3"). */
  label: string;
  /** Label position on the full page, normalized 0..1. */
  xNorm: number;
  yNorm: number;
  /** Plan scale: PDF points per real foot. */
  ptPerFoot: number;
  /**
   * Plan-scale label for the AI (e.g., "1/8\" = 1'-0\"" or
   * "1/4\" = 1'-0\""). Pulled from the scale anchor.
   */
  scaleLabel: string;
  /**
   * Dimension callouts within the crop area, with offsets relative to
   * the crop center. The AI uses these as the architect's printed
   * source of truth.
   */
  nearbyCallouts: ContextualCallout[];
  /**
   * Optional first-pass area guess in sqft (e.g., from planar-graph
   * geometry). The AI cross-checks against this; large disagreement
   * raises a warning.
   */
  geometricAreaHint?: number;
}

export interface MeasureRoomResult {
  roomLabel: string;
  /** Architect-printed width (long dimension) in feet, if AI could read one. */
  widthFt: number | null;
  /** Architect-printed depth (short dimension) in feet, if available. */
  heightFt: number | null;
  /** Floor area = width × height, in sqft. Or null if AI couldn't measure. */
  floorAreaSqft: number | null;
  /** Inferred ceiling height (default 9 ft if no plan note overrides). */
  ceilingHeightFt: number;
  /** Wall area in sqft = perimeter × ceiling height (with opening adjustment). */
  wallAreaSqft: number | null;
  /** Number of doors visible. */
  doors: number;
  /** Number of windows visible. */
  windows: number;
  /** How the AI sourced the measurement. */
  measurementBasis: "printed-dimensions" | "scaled-geometry" | "estimated";
  /** Confidence 0..1. > 0.85 typically means the AI read printed numbers. */
  confidence: number;
  /** Optional note from the AI. */
  notes?: string;
  /** Token usage for cost tracking. */
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

const MEASUREMENT_TOOL = {
  name: "report_room_measurement",
  description:
    "Report the room's measurements based on the architect's printed dimensions visible in the cropped floor plan.",
  input_schema: {
    type: "object" as const,
    properties: {
      room_label: { type: "string" },
      width_ft: {
        type: ["number", "null"] as const,
        description: "Long-axis dimension of the room in feet, parsed from a printed dimension callout. Null if no callout covers this dimension.",
      },
      height_ft: {
        type: ["number", "null"] as const,
        description: "Short-axis dimension of the room in feet, from a printed callout. Null if unavailable.",
      },
      floor_area_sqft: {
        type: ["number", "null"] as const,
        description: "Computed floor area = width × height in square feet. Null if you couldn't determine both dimensions.",
      },
      ceiling_height_ft: {
        type: "number",
        minimum: 6,
        maximum: 30,
        description: "Ceiling height in feet. Default 9 unless the plan explicitly says otherwise.",
      },
      wall_area_sqft: {
        type: ["number", "null"] as const,
        description: "Wall paintable area = perimeter × ceiling height, minus ~7% for openings. Null if you don't have both dimensions.",
      },
      doors: { type: "integer", minimum: 0 },
      windows: { type: "integer", minimum: 0 },
      measurement_basis: {
        type: "string",
        enum: ["printed-dimensions", "scaled-geometry", "estimated"],
        description: "How you derived the measurement. 'printed-dimensions' = read the architect's callouts directly (highest accuracy). 'scaled-geometry' = measured pixels and converted via scale. 'estimated' = visual guess (lowest accuracy).",
      },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      notes: { type: "string" },
    },
    required: [
      "room_label",
      "width_ft",
      "height_ft",
      "floor_area_sqft",
      "ceiling_height_ft",
      "wall_area_sqft",
      "doors",
      "windows",
      "measurement_basis",
      "confidence",
    ],
  },
};

const SYSTEM_PROMPT = `You are an experienced architectural estimator measuring ONE specific room from a cropped floor plan image.

Your job is to determine the room's width × height (and therefore floor area) using the architect's PRINTED DIMENSIONS as the source of truth — not by guessing from pixels.

You will be given:
1. The image crop centered on a room label.
2. The plan's scale (e.g., 1/8" = 1'-0", which means 9 PDF points = 1 foot).
3. A list of dimension callouts found NEAR this room, with their positions and orientations.

Your method:
1. Identify the room. It's the wall-enclosed region containing the labeled position.
2. From the dimension callouts provided + any printed callouts visible in the image, identify which two callouts represent THIS room's overall length and width.
3. If you can confidently match callouts to this room's outer dimensions, set measurement_basis = "printed-dimensions" and confidence ≥ 0.9.
4. If callouts cover only part of the room or are ambiguous, measure visually using the scale and set measurement_basis = "scaled-geometry" with confidence 0.6-0.8.
5. If neither works (room walls aren't clear, no dimensions), set measurement_basis = "estimated" with confidence < 0.6 and explain in notes.

Rules:
- Always prefer printed dimensions over pixel measurement.
- Don't confuse OVERALL BUILDING dimensions (large numbers spanning the whole plan) with single-room dimensions.
- Don't confuse interior partition dimensions with overall room dimensions.
- A door opening is typically 2'-8" to 3'-0" — useful for sanity checking your scale interpretation.
- Default ceiling height: 9 ft for residential and most commercial, 10 ft for retail/lobby, 12 ft for industrial. Override only if the plan says so.
- Wall area = perimeter × ceiling_height_ft × 0.93 (7% opening deduction for doors/windows).

Always call report_room_measurement. Never return free text.`;

export async function measureRoomWithContext(
  input: MeasureRoomInput,
): Promise<MeasureRoomResult> {
  // 1. Crop the page image around the room label.
  const crop = await cropImageAroundPoint(
    input.pageImageBase64,
    input.pageImageMediaType,
    input.pageWidthPx,
    input.pageHeightPx,
    {
      xNorm: input.xNorm,
      yNorm: input.yNorm,
      sizeNorm: CROP_SIZE_NORM,
      outputLongEdgePx: CROP_OUTPUT_LONG_EDGE_PX,
    },
  );

  // 2. Build the callouts context table.
  const calloutsTable = input.nearbyCallouts.length === 0
    ? "(no dimension callouts found in this crop)"
    : input.nearbyCallouts
        .map(
          (c, i) =>
            `  ${i + 1}. "${c.rawText}" = ${c.lengthFt.toFixed(2)} ft, orientation: ${c.orientation ?? "unknown"}, offset from crop center: (${c.xOffsetNorm.toFixed(2)}, ${c.yOffsetNorm.toFixed(2)})`,
        )
        .join("\n");

  const userText = `Measure the room labeled "${input.label}" at the center of this crop.

Plan scale: ${input.scaleLabel} — ${input.ptPerFoot.toFixed(1)} PDF points per real foot.

Dimension callouts found near this room (from the PDF text layer, the architect's exact numbers):
${calloutsTable}

${input.geometricAreaHint ? `First-pass geometric estimate: ${input.geometricAreaHint.toFixed(0)} sqft. Use this only as a sanity check — printed dimensions take priority.` : ""}

Return your measurement using the report_room_measurement tool. Prefer printed dimensions whenever you can match callouts to this room's overall length and width.`;

  // 3. Call Opus 4.7.
  const anthropic = getAnthropic();
  const msg = await anthropic.messages.create({
    model: MEASUREMENT_MODEL,
    max_tokens: 2048,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [MEASUREMENT_TOOL],
    tool_choice: { type: "tool", name: "report_room_measurement" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: crop.imageMediaType,
              data: crop.imageBase64,
            },
          },
          { type: "text", text: userText },
        ],
      },
    ],
  });

  let toolInput: Record<string, unknown> | null = null;
  for (const block of msg.content) {
    if (block.type === "tool_use" && block.name === "report_room_measurement") {
      toolInput = block.input as Record<string, unknown>;
    }
  }
  if (!toolInput) {
    throw new Error(`Measurement failed for room "${input.label}"`);
  }

  return {
    roomLabel: (toolInput.room_label as string) ?? input.label,
    widthFt: (toolInput.width_ft as number | null) ?? null,
    heightFt: (toolInput.height_ft as number | null) ?? null,
    floorAreaSqft: (toolInput.floor_area_sqft as number | null) ?? null,
    ceilingHeightFt: (toolInput.ceiling_height_ft as number) ?? 9,
    wallAreaSqft: (toolInput.wall_area_sqft as number | null) ?? null,
    doors: (toolInput.doors as number) ?? 0,
    windows: (toolInput.windows as number) ?? 0,
    measurementBasis:
      (toolInput.measurement_basis as MeasureRoomResult["measurementBasis"]) ??
      "estimated",
    confidence: (toolInput.confidence as number) ?? 0.5,
    notes: toolInput.notes as string | undefined,
    inputTokens: msg.usage.input_tokens,
    outputTokens: msg.usage.output_tokens,
    cacheReadInputTokens: msg.usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: msg.usage.cache_creation_input_tokens ?? 0,
  };
}
