import { getAnthropic } from "@/lib/anthropic";

export type PageType =
  | "floor_plan"
  | "rcp" // reflected ceiling plan
  | "elevation"
  | "section"
  | "schedule"
  | "detail"
  | "site_plan"
  | "cover"
  | "other";

export const PAGE_TYPE_LABELS: Record<PageType, string> = {
  floor_plan: "Floor plan",
  rcp: "Reflected ceiling plan",
  elevation: "Elevation",
  section: "Section",
  schedule: "Schedule",
  detail: "Detail",
  site_plan: "Site plan",
  cover: "Cover / title sheet",
  other: "Other",
};

/** Pages we want to spend Sonnet on. */
export const TAKEOFF_ELIGIBLE: ReadonlySet<PageType> = new Set([
  "floor_plan",
  "rcp",
]);

export interface ClassificationResult {
  type: PageType;
  confidence: number; // 0..1
  reason: string;
  inputTokens: number;
  outputTokens: number;
}

export const CLASSIFIER_MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You are a construction document classifier. Given a single image of a sheet from an architectural plan set, decide what kind of sheet it is so a downstream takeoff pipeline knows whether to spend money analyzing it.

Categories:
- floor_plan: top-down view of a single floor showing rooms, walls, doors. The most valuable for paint takeoff.
- rcp: reflected ceiling plan — ceiling layout with lights/grids. Also takeoff-eligible.
- elevation: side view of a building façade.
- section: vertical cut through the building.
- schedule: tables of doors, windows, finishes, room names.
- detail: zoomed-in construction details (wall sections, jamb details, etc.).
- site_plan: top-down view of the property with no interior detail.
- cover: title page, sheet index, perspective rendering, project info.
- other: anything else.

Be conservative — when ambiguous, pick "other" with low confidence.`;

const classifyTool = {
  name: "classify_sheet",
  description: "Classify what kind of architectural sheet this is.",
  input_schema: {
    type: "object" as const,
    properties: {
      type: {
        type: "string",
        enum: [
          "floor_plan",
          "rcp",
          "elevation",
          "section",
          "schedule",
          "detail",
          "site_plan",
          "cover",
          "other",
        ],
      },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      reason: {
        type: "string",
        description: "One short sentence explaining the choice.",
      },
    },
    required: ["type", "confidence", "reason"],
  },
};

export async function classifyPage(opts: {
  imageBase64: string;
  imageMediaType: "image/jpeg" | "image/png";
}): Promise<ClassificationResult> {
  const anthropic = getAnthropic();
  const msg = await anthropic.messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 200,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [classifyTool],
    tool_choice: { type: "tool", name: "classify_sheet" },
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
          { type: "text", text: "Classify this sheet." },
        ],
      },
    ],
  });

  let type: PageType = "other";
  let confidence = 0;
  let reason = "";
  for (const block of msg.content) {
    if (block.type === "tool_use" && block.name === "classify_sheet") {
      const input = block.input as {
        type?: PageType;
        confidence?: number;
        reason?: string;
      };
      type = input.type ?? "other";
      confidence = input.confidence ?? 0;
      reason = input.reason ?? "";
    }
  }

  return {
    type,
    confidence,
    reason,
    inputTokens: msg.usage.input_tokens,
    outputTokens: msg.usage.output_tokens,
  };
}
