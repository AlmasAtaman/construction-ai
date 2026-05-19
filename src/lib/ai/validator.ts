import { getAnthropic } from "@/lib/anthropic";
import { CLASSIFIER_MODEL } from "./page-classifier";
import type { TakeoffToolResult } from "./takeoff-prompt";

/**
 * Cheap validator pass — uses Haiku 4.5 with vision to look at the same
 * image and a compact list of the takeoff's claims, and flag entries
 * that look obviously wrong. Lifts accuracy meaningfully for ~1.2x total
 * cost (Haiku is 1/3 the price of Sonnet on input, 1/3 on output, and we
 * send a trimmed claim list rather than the full schema).
 */

export interface ValidationFinding {
  kind: "wall" | "ceiling" | "trim" | "door" | "window" | "missing_room";
  room_label: string;
  issue: string;
  severity: "low" | "medium" | "high";
  suggested_area_sqft?: number;
  suggested_count?: number;
}

export interface ValidationResult {
  findings: ValidationFinding[];
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

const SYSTEM_PROMPT_CACHED = `You are reviewing a painting takeoff produced by another AI. You see the same floor plan image and a structured list of what the AI claimed.

Your job is to flag entries that are obviously wrong, and rooms that are visible on the plan but missing from the claims. Be conservative: only flag findings where you're > 70% sure something is wrong.

# What "obviously wrong" looks like

- Wall area_sqft drastically out of plausible range for the room size (e.g., a 5×5 powder room reporting 400 sqft of walls).
- Ceiling area_sqft does not match the room footprint visible in the image.
- A room label in the claims that doesn't appear anywhere on the plan.
- A room clearly visible on the plan, with a real label, that has no surfaces claimed for it.

# What is NOT a finding

- Slight number differences (< 15%). The original AI is doing the math; you're catching big errors.
- Substrate disagreements. Those are judgment calls.
- Differences between your guess and the printed dimension table. Trust the table.

Use the validate_takeoff tool. Return an empty findings array if nothing looks wrong.`;

const VALIDATE_TOOL = {
  name: "validate_takeoff",
  description: "Flag obvious errors in a painting takeoff.",
  input_schema: {
    type: "object" as const,
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: [
                "wall",
                "ceiling",
                "trim",
                "door",
                "window",
                "missing_room",
              ],
            },
            room_label: { type: "string" },
            issue: {
              type: "string",
              description: "One short sentence describing what's wrong.",
            },
            severity: { type: "string", enum: ["low", "medium", "high"] },
            suggested_area_sqft: {
              type: "number",
              description:
                "If you have a much better area estimate, include it. Otherwise omit.",
            },
            suggested_count: { type: "integer" },
          },
          required: ["kind", "room_label", "issue", "severity"],
        },
      },
    },
    required: ["findings"],
  },
};

/**
 * Build a compact summary of the takeoff's claims for the validator. We
 * deliberately strip polygons (waste of tokens for a sanity check) and
 * collapse to one line per room.
 */
function summarizeClaims(result: TakeoffToolResult): string {
  const byRoom = new Map<
    string,
    {
      wallSqft: number;
      wallLf: number;
      ceilSqft: number;
      trimLf: number;
      doors: number;
      windows: number;
    }
  >();
  function bucket(room: string) {
    if (!byRoom.has(room)) {
      byRoom.set(room, {
        wallSqft: 0,
        wallLf: 0,
        ceilSqft: 0,
        trimLf: 0,
        doors: 0,
        windows: 0,
      });
    }
    return byRoom.get(room)!;
  }
  for (const w of result.walls ?? []) {
    const b = bucket(w.room_label);
    b.wallSqft += w.area_sqft ?? 0;
    b.wallLf += w.linear_ft ?? 0;
  }
  for (const c of result.ceilings ?? []) {
    bucket(c.room_label).ceilSqft += c.area_sqft ?? 0;
  }
  for (const t of result.trim ?? []) {
    bucket(t.room_label).trimLf += t.linear_ft ?? 0;
  }
  for (const d of result.doors ?? []) {
    bucket(d.room_label).doors += d.count;
  }
  for (const w of result.windows ?? []) {
    bucket(w.room_label).windows += w.count;
  }
  const lines: string[] = [];
  for (const [room, t] of byRoom) {
    lines.push(
      `${room}: walls=${Math.round(t.wallSqft)} sqft (perimeter ${Math.round(t.wallLf)} lf), ceil=${Math.round(t.ceilSqft)} sqft, trim=${Math.round(t.trimLf)} lf, doors=${t.doors}, windows=${t.windows}`,
    );
  }
  if (result.scale_anchor) {
    lines.unshift(
      `Scale anchor: ${result.scale_anchor.found ? `"${result.scale_anchor.reference_text}", ceiling ${result.scale_anchor.ceiling_height_ft} ft` : "none found, assumed 9 ft ceiling"}`,
    );
  }
  return lines.join("\n");
}

export async function validateTakeoff(opts: {
  imageBase64: string;
  imageMediaType: "image/jpeg" | "image/png";
  textAnnotations: string;
  result: TakeoffToolResult;
}): Promise<ValidationResult> {
  const anthropic = getAnthropic();
  const claims = summarizeClaims(opts.result);
  const msg = await anthropic.messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT_CACHED,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [VALIDATE_TOOL],
    tool_choice: { type: "tool", name: "validate_takeoff" },
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
          ...(opts.textAnnotations.trim().length > 0
            ? [
                {
                  type: "text" as const,
                  text: `PDF text-layer fragments (room labels, dimensions, etc.):\n${opts.textAnnotations.slice(0, 2000)}`,
                },
              ]
            : []),
          {
            type: "text",
            text: `The previous AI claimed these surfaces:\n${claims}\n\nReview against the floor plan and flag any obvious errors. Return an empty array if nothing looks wrong.`,
          },
        ],
      },
    ],
  });

  let findings: ValidationFinding[] = [];
  for (const block of msg.content) {
    if (block.type === "tool_use" && block.name === "validate_takeoff") {
      const input = block.input as { findings?: ValidationFinding[] };
      findings = input.findings ?? [];
    }
  }

  return {
    findings,
    inputTokens: msg.usage.input_tokens,
    outputTokens: msg.usage.output_tokens,
    cacheReadInputTokens: msg.usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: msg.usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Apply validator findings: corrects clearly-wrong areas using suggested
 * values, and lowers confidence on flagged entries so the user sees them
 * highlighted in the queue.
 */
export function applyValidationFindings(
  result: TakeoffToolResult,
  findings: ValidationFinding[],
): { corrected: TakeoffToolResult; mutations: number } {
  const corrected: TakeoffToolResult = {
    ...result,
    walls: [...result.walls],
    ceilings: [...result.ceilings],
    trim: [...result.trim],
    doors: [...result.doors],
    windows: [...result.windows],
    warnings: [...(result.warnings ?? [])],
  };
  let mutations = 0;
  for (const f of findings) {
    if (f.kind === "missing_room") {
      corrected.warnings.push(
        `Possibly missing room: ${f.room_label} — ${f.issue}`,
      );
      continue;
    }
    const arr = (() => {
      switch (f.kind) {
        case "wall":
          return corrected.walls;
        case "ceiling":
          return corrected.ceilings;
        case "trim":
          return corrected.trim;
        case "door":
          return corrected.doors;
        case "window":
          return corrected.windows;
        default:
          return null;
      }
    })();
    if (!arr) continue;
    const idx = arr.findIndex(
      (s) =>
        typeof s.room_label === "string" &&
        s.room_label.toLowerCase().includes(f.room_label.toLowerCase()),
    );
    if (idx < 0) continue;
    const entry = arr[idx];

    // Drop confidence so the UI surfaces it for review.
    const newConfidence = Math.min(entry.confidence, 0.5);
    arr[idx] = { ...entry, confidence: newConfidence };

    // If validator gave us a much better number, use it.
    if (
      f.severity === "high" &&
      typeof f.suggested_area_sqft === "number" &&
      f.suggested_area_sqft > 0 &&
      "area_sqft" in entry
    ) {
      arr[idx] = {
        ...arr[idx],
        area_sqft: f.suggested_area_sqft,
      } as typeof entry;
      mutations++;
    }
    if (
      f.severity === "high" &&
      typeof f.suggested_count === "number" &&
      "count" in entry
    ) {
      arr[idx] = {
        ...arr[idx],
        count: f.suggested_count,
      } as typeof entry;
      mutations++;
    }
    corrected.warnings.push(
      `[${f.severity}] ${f.room_label} (${f.kind}): ${f.issue}`,
    );
  }
  return { corrected, mutations };
}
