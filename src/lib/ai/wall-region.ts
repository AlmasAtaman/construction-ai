import { getAnthropic } from "@/lib/anthropic";

/**
 * Vision-based wall-region classifier — the "which lines are walls" step
 * that pure geometry could not solve on noisy commercial plans.
 *
 * The model NEVER produces measurements or wall coordinates. It only does
 * what vision models are good at and geometry is bad at: looking at the
 * rendered sheet and saying WHERE the building footprint is — the rectangle
 * bounded by the outermost walls — so we can discard the dimension ladders,
 * leader lines, schedules, notes, title block and detail drawings that the
 * double-line detector cannot tell apart from walls.
 *
 * Downstream we keep only the double-line centerlines whose midpoint falls
 * inside a returned region, then measure with deterministic geometry. So:
 * AI = classification (coarse region), geometry = every number.
 *
 * Coordinates are normalized 0..1 with the ORIGIN AT TOP-LEFT (image space,
 * y-down) — matching how the page is rendered to the model.
 */

export interface WallRegion {
  /** Short label the model assigned, e.g. "construction plan". */
  label: string;
  /** Normalized 0..1, top-left origin (y-down). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface WallRegionResult {
  regions: WallRegion[];
  inputTokens: number;
  outputTokens: number;
}

/** Sonnet: coarse region detection needs reliable vision, one call/page. */
export const WALL_REGION_MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are analyzing one sheet from an architectural plan set for a wall-takeoff tool.

A sheet often contains several drawings: floor plans, but also schedules (tables), general notes, detail drawings, a partition legend, and a title block. The takeoff only cares about the FLOOR-PLAN drawings.

Your single job: for EACH floor-plan drawing on the sheet, return a tight rectangle around the BUILDING FOOTPRINT — the area bounded by the building's outermost walls.

Critical rules:
- The four edges of your box must sit ON the building's outermost wall lines. Think of it as the smallest rectangle that still contains every wall.
- Dimension strings — rows of small numbers with tick marks and thin extension lines — appear in a BAND just OUTSIDE the outer walls (most often below and to the sides of the building). These, along with room tags, leader lines, and section/elevation markers, MUST fall OUTSIDE your box. They are exactly the noise we are excluding. When unsure, it is better to clip slightly INTO the building than to let the dimension band leak inside the box.
- Return ONE box per distinct floor-plan drawing. A sheet may show the same building twice (e.g. a "construction plan" and a "finish plan"); return both as separate boxes.
- Do NOT return boxes for schedules, tables, notes, legends, detail/section drawings, elevations, or the title block. If the sheet has no floor plan at all, return an empty list.
- Coordinates are fractions from 0 to 1. Origin is the TOP-LEFT corner: x increases rightward, y increases downward.`;

const reportTool = {
  name: "report_wall_regions",
  description:
    "Report the building-footprint rectangle for each floor-plan drawing on the sheet.",
  input_schema: {
    type: "object" as const,
    properties: {
      regions: {
        type: "array",
        description:
          "One entry per floor-plan drawing. Empty if the sheet has no floor plan.",
        items: {
          type: "object",
          properties: {
            label: {
              type: "string",
              description:
                'Short name of the drawing, e.g. "construction plan", "finish plan", "level 1".',
            },
            x0: { type: "number", minimum: 0, maximum: 1, description: "left" },
            y0: { type: "number", minimum: 0, maximum: 1, description: "top" },
            x1: { type: "number", minimum: 0, maximum: 1, description: "right" },
            y1: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "bottom",
            },
          },
          required: ["label", "x0", "y0", "x1", "y1"],
        },
      },
    },
    required: ["regions"],
  },
};

interface RawRegion {
  label?: unknown;
  x0?: unknown;
  y0?: unknown;
  x1?: unknown;
  y1?: unknown;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function detectWallRegions(opts: {
  imageBase64: string;
  imageMediaType: "image/jpeg" | "image/png";
}): Promise<WallRegionResult> {
  const anthropic = getAnthropic();
  const msg = await anthropic.messages.create({
    model: WALL_REGION_MODEL,
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [reportTool],
    tool_choice: { type: "tool", name: "report_wall_regions" },
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
            text: "Return the building-footprint box for each floor plan on this sheet.",
          },
        ],
      },
    ],
  });

  const regions: WallRegion[] = [];
  for (const block of msg.content) {
    if (block.type === "tool_use" && block.name === "report_wall_regions") {
      const input = block.input as { regions?: RawRegion[] };
      for (const r of input.regions ?? []) {
        const x0 = num(r.x0);
        const y0 = num(r.y0);
        const x1 = num(r.x1);
        const y1 = num(r.y1);
        if (x0 === null || y0 === null || x1 === null || y1 === null) continue;
        regions.push({
          label: typeof r.label === "string" ? r.label : "plan",
          x0: Math.min(x0, x1),
          y0: Math.min(y0, y1),
          x1: Math.max(x0, x1),
          y1: Math.max(y0, y1),
        });
      }
    }
  }

  return {
    regions,
    inputTokens: msg.usage.input_tokens,
    outputTokens: msg.usage.output_tokens,
  };
}
