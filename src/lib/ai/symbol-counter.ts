/**
 * AI-powered architectural symbol counting.
 *
 * Scans a rendered floor plan and counts every instance of standard
 * architectural symbols — outlets, light fixtures, plumbing fixtures,
 * HVAC diffusers, sprinklers, fire equipment, doors, windows.
 *
 * For painting estimation, the symbols that matter are:
 *   - Doors (with type classification — affects trim, knockout area)
 *   - Windows (knockout area)
 *   - Cased openings (no trim, no knockout)
 * The other categories are tracked because:
 *   - Plumbing/electrical fixtures = obstructions painters work around
 *   - HVAC diffusers/sprinklers = ceiling obstructions
 *   - Pulling these as counts also enables cross-trade workflows later
 *
 * Strategy: ONE Sonnet 4.5 vision call on the rendered page with a
 * strict tool_use schema. The AI returns counts per symbol type, with
 * an optional per-room breakdown when room polygons are provided.
 *
 * Cost: ~$0.015 per page (one Sonnet call with ~1500 vision tokens).
 *
 * Why not CV template matching: architectural symbols vary widely
 * across firms — a duplex outlet might be drawn as a circle+line or
 * as a hexagon depending on the office's CAD library. AI vision
 * handles this variability; template matching does not.
 *
 * For high-volume symbols (200+ outlets in a big office), see
 * `cv-symbol-matcher.ts` which adds template matching on top.
 */

import type { Anthropic } from "@anthropic-ai/sdk";
import { getAnthropic } from "@/lib/anthropic";
import {
  glossaryAsPrompt,
  SYMBOL_GLOSSARY,
  type SymbolType,
  type SymbolDefinition,
} from "@/lib/symbol-glossary";

export interface CountedSymbol {
  type: SymbolType;
  category: SymbolDefinition["category"];
  /** Total count on this page. */
  count: number;
  /** Optional per-room breakdown. */
  byRoom?: Array<{ roomLabel: string; count: number }>;
  /** AI's confidence 0..1. */
  confidence: number;
  /** Notes from the AI (e.g., "most are in the corridor"). */
  notes?: string;
}

export interface SymbolCountResult {
  symbols: CountedSymbol[];
  /** Totals by category — convenience. */
  totals: Record<SymbolDefinition["category"], number>;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  elapsedMs: number;
}

export interface CountSymbolsInput {
  pageImageBase64: string;
  pageImageMediaType: "image/jpeg" | "image/png";
  /** Optional list of room labels for per-room breakdown. */
  roomLabels?: string[];
  /** Restrict to specific categories. Default: all painting-relevant. */
  categories?: SymbolDefinition["category"][];
  /**
   * If true, count furniture too. Default false (furniture isn't
   * painting-relevant; including it adds AI cost for marginal value).
   */
  includeFurniture?: boolean;
}

const MODEL = "claude-sonnet-4-5";

function buildSchema(
  categories: SymbolDefinition["category"][],
): Anthropic.Messages.Tool {
  const types = SYMBOL_GLOSSARY.filter((s) =>
    categories.includes(s.category),
  ).map((s) => s.type);
  return {
    name: "report_symbol_counts",
    description:
      "Report every counted architectural symbol on the floor plan.",
    input_schema: {
      type: "object",
      properties: {
        symbols: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: types },
              count: { type: "integer", minimum: 0 },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              by_room: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    room_label: { type: "string" },
                    count: { type: "integer", minimum: 0 },
                  },
                  required: ["room_label", "count"],
                },
              },
              notes: { type: "string" },
            },
            required: ["type", "count", "confidence"],
          },
        },
      },
      required: ["symbols"],
    },
  };
}

function buildSystemPrompt(
  categories: SymbolDefinition["category"][],
): string {
  return `You are an experienced construction estimator scanning a floor plan to count architectural symbols.

Reference glossary of standard symbols to look for (you only count these types):

${glossaryAsPrompt(categories)}

Rules:
1. Count EVERY visible instance, not just a sample. If you see 47 ceiling lights, return 47.
2. If a symbol could plausibly be one of two types, prefer the more specific (e.g., gfci_outlet over duplex_outlet if you see GFCI annotation).
3. If a category has zero of a symbol type, OMIT it from the response — don't return count: 0.
4. Use the room labels (if provided) to give per-room breakdowns where useful. Per-room breakdown isn't required for every symbol type.
5. Report your confidence honestly — count accuracy on dense plans is hard. Confidence ≥ 0.85 only when the symbols are visually clear and not ambiguous.

Always call report_symbol_counts. Never return free-form text.`;
}

function buildUserText(
  roomLabels: string[] | undefined,
): string {
  let text =
    "Count every standard architectural symbol visible on this floor plan, by type.";
  if (roomLabels && roomLabels.length > 0 && roomLabels.length <= 50) {
    text += `\n\nThe rooms on this plan are:\n${roomLabels.map((l, i) => `  ${i + 1}. ${l}`).join("\n")}\n\nProvide per-room breakdowns where they help.`;
  }
  return text;
}

export async function countSymbolsOnPage(
  input: CountSymbolsInput,
): Promise<SymbolCountResult> {
  const t0 = Date.now();
  const categories: SymbolDefinition["category"][] =
    input.categories ??
    (input.includeFurniture
      ? ["electrical", "plumbing", "hvac", "fire_safety", "openings", "furniture"]
      : ["electrical", "plumbing", "hvac", "fire_safety", "openings"]);

  const tool = buildSchema(categories);
  const system = buildSystemPrompt(categories);

  const anthropic = getAnthropic();
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: system,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [tool],
    tool_choice: { type: "tool", name: "report_symbol_counts" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: input.pageImageMediaType,
              data: input.pageImageBase64,
            },
          },
          { type: "text", text: buildUserText(input.roomLabels) },
        ],
      },
    ],
  });

  let toolInput: { symbols?: Array<{
    type: SymbolType;
    count: number;
    confidence: number;
    by_room?: Array<{ room_label: string; count: number }>;
    notes?: string;
  }> } | null = null;
  for (const block of msg.content) {
    if (block.type === "tool_use" && block.name === "report_symbol_counts") {
      toolInput = block.input as typeof toolInput;
    }
  }

  const rawSymbols = toolInput?.symbols ?? [];
  const symbols: CountedSymbol[] = rawSymbols
    .filter((s) => s.count > 0)
    .map((s) => {
      const def = SYMBOL_GLOSSARY.find((d) => d.type === s.type);
      return {
        type: s.type,
        category: def?.category ?? "furniture",
        count: s.count,
        confidence: s.confidence,
        byRoom: s.by_room?.map((r) => ({
          roomLabel: r.room_label,
          count: r.count,
        })),
        notes: s.notes,
      };
    });

  const totals: Record<SymbolDefinition["category"], number> = {
    electrical: 0,
    plumbing: 0,
    hvac: 0,
    fire_safety: 0,
    openings: 0,
    furniture: 0,
  };
  for (const s of symbols) totals[s.category] += s.count;

  return {
    symbols,
    totals,
    inputTokens: msg.usage.input_tokens,
    outputTokens: msg.usage.output_tokens,
    cacheReadInputTokens: msg.usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: msg.usage.cache_creation_input_tokens ?? 0,
    elapsedMs: Date.now() - t0,
  };
}
