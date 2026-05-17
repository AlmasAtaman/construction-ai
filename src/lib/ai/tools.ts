import type { Anthropic } from "@anthropic-ai/sdk";

export const CHAT_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "update_surfaces",
    description:
      'Modify paint type, coats, substrate, or status on a set of matching surfaces. The DEFAULT modification tool — use for "change", "set", "make", "update", "switch", "switch out", "swap". DO NOT use this with status="excluded" — always use exclude_surfaces for that case.',
    input_schema: {
      type: "object",
      properties: {
        filter: {
          type: "object",
          description:
            'Which surfaces to match. roomLabelPattern is a substring or regex that must match the room name (use word "|" to OR multiple synonyms — e.g. bathroom|restroom|powder).',
          properties: {
            roomLabelPattern: {
              type: "string",
              description:
                'Substring or pipe-separated synonyms. Examples: "bathroom|restroom|powder", "office", "second floor", "elevator".',
            },
            surfaceType: {
              type: "string",
              enum: ["wall", "ceiling", "trim", "door", "window"],
            },
            currentPaintType: {
              type: "string",
              description:
                "Only match surfaces that currently have this paint type (e.g., to swap one paint for another).",
            },
          },
        },
        changes: {
          type: "object",
          description:
            'What to set on the matched surfaces. Each field is optional. paintType strings are free-form ("semi-gloss", "anti-microbial epoxy"). coats is an integer 1-10.',
          properties: {
            paintType: { type: "string" },
            coats: { type: "integer", minimum: 1, maximum: 10 },
            substrate: { type: "string" },
            status: {
              type: "string",
              enum: ["proposed", "accepted", "manual"],
              description:
                'Do NOT pass "excluded" here — use exclude_surfaces instead.',
            },
          },
        },
      },
      required: ["filter", "changes"],
    },
  },
  {
    name: "exclude_surfaces",
    description:
      'Set the matching surfaces to status="excluded" so they are removed from the bid. Use whenever the user says: skip, don\'t paint, omit, not in scope, remove from bid, exclude, stainless finished, not painted, leave out, mark as not painted.',
    input_schema: {
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: {
            roomLabelPattern: { type: "string" },
            surfaceType: {
              type: "string",
              enum: ["wall", "ceiling", "trim", "door", "window"],
            },
          },
        },
      },
      required: ["filter"],
    },
  },
  {
    name: "set_waste_factor",
    description:
      "Update the project's waste factor (extra paint allowance for spills, drops, etc.). The user typically says it as a percentage; ALWAYS pass that percentage as a number (e.g., 12 for 12%, 8 for 8%). The server divides by 100 to get the decimal.",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description:
            "Optional category (e.g., interior, exterior, trim). Most users mean the project-wide waste — omit unless they specify.",
        },
        percentage: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description:
            'The waste percentage as a number, NOT decimal. "12 percent" → 12. "15%" → 15. Server converts to decimal.',
        },
      },
      required: ["percentage"],
    },
  },
  {
    name: "query_quantities",
    description:
      'Look up current quantities. Use for ANY question the user asks about totals, counts, areas, or "do I have any X". Never guess from memory — always call this tool.',
    input_schema: {
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: {
            roomLabelPattern: { type: "string" },
            surfaceType: {
              type: "string",
              enum: ["wall", "ceiling", "trim", "door", "window"],
            },
          },
        },
      },
    },
  },
  {
    name: "apply_assembly",
    description:
      "Apply a saved Tool Chest assembly (paint + coats preset) to matching surfaces.",
    input_schema: {
      type: "object",
      properties: {
        assemblyId: { type: "string" },
        filter: {
          type: "object",
          properties: {
            roomLabelPattern: { type: "string" },
            surfaceType: {
              type: "string",
              enum: ["wall", "ceiling", "trim", "door", "window"],
            },
          },
        },
      },
      required: ["assemblyId", "filter"],
    },
  },
  {
    name: "set_measurement_mode",
    description:
      "Switch between net (deduct openings), gross (no deductions), or PCA (standard PCA opening rules) measurement modes.",
    input_schema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["net", "gross", "pca"] },
      },
      required: ["mode"],
    },
  },
  {
    name: "recalculate_bid",
    description:
      "Force a worksheet refresh. The UI usually recalculates automatically; only call if the user explicitly asks (e.g., 'redo the math').",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_surfaces",
    description:
      'Search surfaces by room label, paint type, or substrate and return a list of matches. Use for queries like "show me every room with P-1 paint", "list all bathrooms", "find rooms with epoxy". Returns count and a sample of matches.',
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "object",
          properties: {
            roomLabelPattern: {
              type: "string",
              description:
                "Substring or pipe-separated synonyms to match the room name.",
            },
            surfaceType: {
              type: "string",
              enum: ["wall", "ceiling", "trim", "door", "window"],
            },
            paintType: { type: "string" },
            substrate: { type: "string" },
            symbolType: {
              type: "string",
              description:
                "If set, search symbol counts (e.g., 'single_door', 'toilet').",
            },
          },
        },
      },
      required: ["query"],
    },
  },
  {
    name: "count_symbols",
    description:
      "Get the total count of a symbol type across the project (e.g., 'how many doors', 'count toilets').",
    input_schema: {
      type: "object",
      properties: {
        symbolType: {
          type: "string",
          description:
            "Symbol type to count, e.g. 'single_door', 'window', 'toilet', 'sprinkler_head'.",
        },
      },
      required: ["symbolType"],
    },
  },
];

export interface ToolFilter {
  roomLabelPattern?: string;
  surfaceType?: "wall" | "ceiling" | "trim" | "door" | "window";
  currentPaintType?: string;
}

export interface ToolChanges {
  paintType?: string;
  coats?: number;
  substrate?: string;
  status?: "proposed" | "accepted" | "manual" | "excluded";
}
