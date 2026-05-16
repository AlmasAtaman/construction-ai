import type { Anthropic } from "@anthropic-ai/sdk";
import { getAnthropic } from "@/lib/anthropic";
import { DEFAULT_MODEL } from "@/lib/constants";
import { cropImageAroundPoint, type Crop } from "@/lib/pdf-crop";
import type { TakeoffToolResult } from "./takeoff-prompt";

/**
 * Per-room takeoff for dense commercial plans without a printed dim
 * table. Strategy: for each room label whose AI-detected surface looks
 * implausible (or is missing), crop ~32% of page-dim around that label
 * and ask Sonnet for just that ONE room's surfaces. Single-room frames
 * eliminate the polygon-merge bug.
 *
 * Each per-room call is gated to a single tool with a one-room schema,
 * which (a) caps cost and (b) prevents the model from inventing
 * neighboring rooms.
 */

export const PER_ROOM_TOOL: Anthropic.Messages.Tool = {
  name: "record_one_room",
  description:
    "Report paintable surfaces for the SINGLE room highlighted in the image. Do not report neighboring rooms or unrelated surfaces.",
  input_schema: {
    type: "object",
    properties: {
      room_label: {
        type: "string",
        description: "The exact printed label of the room you're measuring.",
      },
      walls: {
        type: "object",
        properties: {
          linear_ft: { type: "number", minimum: 0 },
          area_sqft: { type: "number", minimum: 0 },
          substrate: {
            type: "string",
            enum: ["drywall", "CMU", "concrete", "wood", "metal", "unknown"],
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["linear_ft", "area_sqft", "substrate", "confidence"],
      },
      ceiling: {
        type: "object",
        properties: {
          area_sqft: { type: "number", minimum: 0 },
          substrate: {
            type: "string",
            enum: [
              "drywall",
              "acoustic_tile",
              "exposed_structure",
              "concrete",
              "unknown",
            ],
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["area_sqft", "substrate", "confidence"],
      },
      trim_lf: { type: "number", minimum: 0 },
      doors: { type: "integer", minimum: 0 },
      windows: { type: "integer", minimum: 0 },
      ceiling_height_ft: { type: "number", minimum: 6, maximum: 30 },
      notes: { type: "string" },
    },
    required: ["room_label", "walls", "ceiling"],
  },
};

const PER_ROOM_SYSTEM = `You are measuring a SINGLE room shown in this cropped image. The image was extracted from an architectural floor plan around the printed label of one specific room.

Rules:
- Report only that one room's surfaces. Ignore everything adjacent in the frame.
- Wall area = wall perimeter × ceiling height (with a 5-8% opening deduction).
- Ceiling area = room floor area (length × width).
- Default ceiling height is 9 ft for offices/residential, 10 ft for retail/lobby, 12 ft for industrial. Use 9 unless the plan tells you otherwise.
- If you can read explicit dimensions printed inside the room, use them.
- Always call the record_one_room tool. Never return free-form text.`;

export interface PerRoomResult {
  roomLabel: string;
  walls: TakeoffToolResult["walls"][number] | null;
  ceiling: TakeoffToolResult["ceilings"][number] | null;
  trim: TakeoffToolResult["trim"][number] | null;
  doors: TakeoffToolResult["doors"][number] | null;
  windows: TakeoffToolResult["windows"][number] | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export async function measureOneRoom(opts: {
  /** Full-page rendered image. */
  pageImageBase64: string;
  pageImageMediaType: "image/jpeg" | "image/png";
  pageWidthPx: number;
  pageHeightPx: number;
  label: string;
  /** Normalized 0..1 position of the room label on the page. */
  xNorm: number;
  yNorm: number;
}): Promise<PerRoomResult> {
  const crop: Crop = await cropImageAroundPoint(
    opts.pageImageBase64,
    opts.pageImageMediaType,
    opts.pageWidthPx,
    opts.pageHeightPx,
    {
      xNorm: opts.xNorm,
      yNorm: opts.yNorm,
      sizeNorm: 0.32,
      // Single-room crops don't need the full 1568px vision-token budget.
      // 1024 = ~50% the image tokens, no observable accuracy loss in
      // testing.
      outputLongEdgePx: 1024,
    },
  );

  const anthropic = getAnthropic();
  const msg = await anthropic.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: PER_ROOM_SYSTEM,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [PER_ROOM_TOOL],
    tool_choice: { type: "tool", name: "record_one_room" },
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
          {
            type: "text",
            text: `The room labeled "${opts.label}" is at the center of this crop. Measure ONLY that room.`,
          },
        ],
      },
    ],
  });

  let toolInput: Record<string, unknown> | null = null;
  for (const block of msg.content) {
    if (block.type === "tool_use" && block.name === "record_one_room") {
      toolInput = block.input as Record<string, unknown>;
    }
  }
  if (!toolInput) {
    throw new Error(`Per-room measurement failed for "${opts.label}"`);
  }

  const placeholderPolygon = [
    { x: opts.xNorm - 0.05, y: opts.yNorm - 0.05 },
    { x: opts.xNorm + 0.05, y: opts.yNorm - 0.05 },
    { x: opts.xNorm + 0.05, y: opts.yNorm + 0.05 },
    { x: opts.xNorm - 0.05, y: opts.yNorm + 0.05 },
  ];

  const wallsIn = toolInput.walls as
    | {
        linear_ft?: number;
        area_sqft?: number;
        substrate?: string;
        confidence?: number;
      }
    | undefined;
  const ceilIn = toolInput.ceiling as
    | { area_sqft?: number; substrate?: string; confidence?: number }
    | undefined;
  const trimLf = (toolInput.trim_lf as number | undefined) ?? 0;
  const doors = (toolInput.doors as number | undefined) ?? 0;
  const windows = (toolInput.windows as number | undefined) ?? 0;

  return {
    roomLabel: (toolInput.room_label as string) ?? opts.label,
    walls: wallsIn
      ? {
          room_label: (toolInput.room_label as string) ?? opts.label,
          linear_ft: wallsIn.linear_ft ?? 0,
          area_sqft: wallsIn.area_sqft ?? 0,
          substrate: wallsIn.substrate ?? "drywall",
          polygon: placeholderPolygon,
          confidence: wallsIn.confidence ?? 0.8,
        }
      : null,
    ceiling: ceilIn
      ? {
          room_label: (toolInput.room_label as string) ?? opts.label,
          area_sqft: ceilIn.area_sqft ?? 0,
          substrate: ceilIn.substrate ?? "drywall",
          polygon: placeholderPolygon,
          confidence: ceilIn.confidence ?? 0.8,
        }
      : null,
    trim:
      trimLf > 0
        ? {
            room_label: (toolInput.room_label as string) ?? opts.label,
            linear_ft: trimLf,
            substrate: "wood",
            polygon: placeholderPolygon,
            confidence: 0.7,
          }
        : null,
    doors:
      doors > 0
        ? {
            room_label: (toolInput.room_label as string) ?? opts.label,
            count: doors,
            substrate: "wood",
            polygon: placeholderPolygon,
            confidence: 0.8,
          }
        : null,
    windows:
      windows > 0
        ? {
            room_label: (toolInput.room_label as string) ?? opts.label,
            count: windows,
            substrate: "metal",
            polygon: placeholderPolygon,
            confidence: 0.8,
          }
        : null,
    inputTokens: msg.usage.input_tokens,
    outputTokens: msg.usage.output_tokens,
    cacheReadInputTokens: msg.usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: msg.usage.cache_creation_input_tokens ?? 0,
  };
}
