import { getAnthropic } from "@/lib/anthropic";

/**
 * Second AI pass of the hybrid wall tracer: classify candidate polylines as
 * wall vs dimension/other.
 *
 * Geometry (double-line detection + graph assembly) produces a few dozen
 * candidate wall polylines, but on heavily-dimensioned plans it cannot tell
 * a wall from a dimension string — they share the same line spacing and
 * connectivity. That distinction is a VISUAL judgment, which is what a vision
 * model is good at. So we render each candidate polyline highlighted with a
 * number and ask the model to label each one. The model never produces a
 * coordinate or a measurement; it only assigns wall/dimension/other to an
 * existing geometry id. Geometry keeps every coordinate and length.
 */

export type MarkKind = "wall" | "dimension" | "other";

export interface MarkClassification {
  id: number;
  kind: MarkKind;
}

export interface WallClassifyResult {
  kinds: Map<number, MarkKind>;
  wallIds: number[];
  inputTokens: number;
  outputTokens: number;
}

export const WALL_CLASSIFY_MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are reviewing an automatic wall tracer's output on an architectural floor plan.

Each numbered, colored line on the image is ONE candidate line the tracer found. Your job is to label what each numbered line actually runs along:

- "wall": the line runs along a real building wall (exterior wall or interior partition). Walls bound rooms and meet other walls at corners.
- "dimension": the line is a dimension / measurement line — these sit in bands just outside or between rooms, run parallel to walls, and are accompanied by small numbers, tick marks, and thin extension lines. They do NOT bound a room.
- "other": furniture, fixtures, casework, equipment, leader lines, hatching, schedule/table rules, or anything that is neither a wall nor a dimension.

Judge each numbered line on what it visually lies on in the drawing. Return exactly one label per numbered mark id you are given.`;

const classifyTool = {
  name: "classify_marks",
  description:
    "Label each numbered candidate line as wall, dimension, or other.",
  input_schema: {
    type: "object" as const,
    properties: {
      marks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "number", description: "The mark number." },
            kind: {
              type: "string",
              enum: ["wall", "dimension", "other"],
            },
          },
          required: ["id", "kind"],
        },
      },
    },
    required: ["marks"],
  },
};

interface RawMark {
  id?: unknown;
  kind?: unknown;
}

export async function classifyWallMarks(opts: {
  imageBase64: string;
  imageMediaType: "image/jpeg" | "image/png";
  markIds: number[];
}): Promise<WallClassifyResult> {
  const anthropic = getAnthropic();
  const msg = await anthropic.messages.create({
    model: WALL_CLASSIFY_MODEL,
    max_tokens: 2048,
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    tools: [classifyTool],
    tool_choice: { type: "tool", name: "classify_marks" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: opts.imageMediaType,
              data: opts.imageBase64,
            },
          },
          {
            type: "text",
            text: `Label every numbered line. Mark ids present: ${opts.markIds.join(", ")}.`,
          },
        ],
      },
    ],
  });

  const kinds = new Map<number, MarkKind>();
  for (const block of msg.content) {
    if (block.type === "tool_use" && block.name === "classify_marks") {
      const input = block.input as { marks?: RawMark[] };
      for (const m of input.marks ?? []) {
        if (typeof m.id !== "number") continue;
        const k = m.kind;
        if (k === "wall" || k === "dimension" || k === "other") {
          kinds.set(m.id, k);
        }
      }
    }
  }
  const wallIds = [...kinds.entries()]
    .filter(([, k]) => k === "wall")
    .map(([id]) => id);

  return {
    kinds,
    wallIds,
    inputTokens: msg.usage.input_tokens,
    outputTokens: msg.usage.output_tokens,
  };
}
