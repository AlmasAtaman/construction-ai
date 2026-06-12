import { getAnthropic, hasApiKey } from "@/lib/anthropic";
import { getCached, setCached, makeCacheKey } from "@/lib/cache";
import type { LayerRole } from "@/lib/extract/layer-classify";

/**
 * Haiku fallback for CAD layer names the regex classifier couldn't place.
 * Text-only (no images) — a full plan set's layer list is ~100 tokens, so
 * this costs a fraction of a cent and runs once per document (cached).
 *
 * Only called when a document HAS layers but regex found no wall layer
 * (foreign-language or exotic naming conventions); when regex already
 * found walls the deterministic answer stands alone.
 */

const MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You classify CAD layer names from architectural floor-plan PDFs. Given layer names (often AutoCAD conventions, possibly non-English), assign each a role:
- wall-new: new-construction walls/partitions
- wall-existing: existing walls to remain (incl. base-building shell)
- wall-demo: walls being demolished
- dimension: dimension lines/strings
- hatch: hatching / fill patterns / floor tiles
- annotation: text, notes, symbols, title block, tables
- room-label: room names/numbers
- other: anything else (plumbing, electrical, furniture, ...)
Only assign wall roles when the name clearly refers to walls/partitions (e.g. WALL, WAND, MUR, MURO, PARED, partition).`;

const classifyTool = {
  name: "classify_layers",
  description: "Assign a role to each CAD layer name.",
  input_schema: {
    type: "object" as const,
    properties: {
      layers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            role: {
              type: "string",
              enum: [
                "wall-new",
                "wall-existing",
                "wall-demo",
                "dimension",
                "hatch",
                "annotation",
                "room-label",
                "other",
              ],
            },
          },
          required: ["name", "role"],
        },
      },
    },
    required: ["layers"],
  },
};

export async function classifyLayerNamesWithAi(
  names: string[],
): Promise<Record<string, LayerRole>> {
  if (names.length === 0 || !hasApiKey()) return {};
  const prompt = names.join("\n");
  const cacheKey = makeCacheKey({
    endpoint: "layer-names-v1",
    model: MODEL,
    prompt,
  });
  const cached = await getCached<Record<string, LayerRole>>(cacheKey);
  if (cached) return cached;

  const anthropic = getAnthropic();
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    tools: [classifyTool],
    tool_choice: { type: "tool", name: "classify_layers" },
    messages: [
      { role: "user", content: `Classify these layer names:\n${prompt}` },
    ],
  });

  const result: Record<string, LayerRole> = {};
  for (const block of msg.content) {
    if (block.type === "tool_use" && block.name === "classify_layers") {
      const input = block.input as {
        layers?: Array<{ name?: string; role?: LayerRole }>;
      };
      for (const l of input.layers ?? []) {
        if (l.name && l.role) result[l.name] = l.role;
      }
    }
  }
  await setCached(cacheKey, "layer-names-v1", result);
  return result;
}
