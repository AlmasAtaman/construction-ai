import type { Anthropic } from "@anthropic-ai/sdk";

/**
 * Per-room measurements. The grammar guarantees walls/ceilings get
 * area_sqft (not length), trim gets linear_ft, doors/windows get count.
 * This eliminates the unit-confusion bug from free-form JSON.
 */
export const RECORD_TAKEOFF_TOOL: Anthropic.Messages.Tool = {
  name: "record_takeoff",
  description:
    "Record every paintable surface you can identify on this floor plan. Walls and ceilings MUST have area_sqft. Trim MUST have linear_ft. Doors and windows MUST have count.",
  input_schema: {
    type: "object",
    properties: {
      scale_anchor: {
        type: "object",
        description:
          "A real dimension you can read on the plan that you used to calibrate areas. If you cannot find one, set found=false and explain in note; assume 9 ft ceilings for walls.",
        properties: {
          found: { type: "boolean" },
          reference_text: {
            type: "string",
            description:
              'Exact text of the dimension you used, e.g. "24\'-6\\""',
          },
          ceiling_height_ft: {
            type: "number",
            description:
              "Ceiling height used to convert wall length to area. Default 9 for offices, 10 for retail/lobby, 12 for industrial.",
          },
          note: { type: "string" },
        },
        required: ["found", "ceiling_height_ft"],
      },
      walls: {
        type: "array",
        description:
          "Each entry is the combined paintable wall surface of one room. area_sqft is what the painter will paint; linear_ft is the room's wall length (perimeter minus openings).",
        items: {
          type: "object",
          properties: {
            room_label: { type: "string" },
            area_sqft: { type: "number", minimum: 0 },
            linear_ft: { type: "number", minimum: 0 },
            substrate: {
              type: "string",
              enum: ["drywall", "CMU", "concrete", "wood", "metal", "unknown"],
            },
            polygon: {
              type: "array",
              description:
                "Normalized (0..1) polygon roughly tracing the room footprint so the user can see what was detected.",
              items: {
                type: "object",
                properties: {
                  x: { type: "number" },
                  y: { type: "number" },
                },
                required: ["x", "y"],
              },
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: [
            "room_label",
            "area_sqft",
            "linear_ft",
            "substrate",
            "polygon",
            "confidence",
          ],
        },
      },
      ceilings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            room_label: { type: "string" },
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
            polygon: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  x: { type: "number" },
                  y: { type: "number" },
                },
                required: ["x", "y"],
              },
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: [
            "room_label",
            "area_sqft",
            "substrate",
            "polygon",
            "confidence",
          ],
        },
      },
      trim: {
        type: "array",
        items: {
          type: "object",
          properties: {
            room_label: { type: "string" },
            linear_ft: { type: "number", minimum: 0 },
            substrate: {
              type: "string",
              enum: ["wood", "metal", "MDF", "unknown"],
            },
            polygon: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  x: { type: "number" },
                  y: { type: "number" },
                },
                required: ["x", "y"],
              },
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: [
            "room_label",
            "linear_ft",
            "substrate",
            "polygon",
            "confidence",
          ],
        },
      },
      doors: {
        type: "array",
        items: {
          type: "object",
          properties: {
            room_label: { type: "string" },
            count: { type: "integer", minimum: 1 },
            substrate: {
              type: "string",
              enum: ["wood", "metal", "glass_frame", "unknown"],
            },
            polygon: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  x: { type: "number" },
                  y: { type: "number" },
                },
                required: ["x", "y"],
              },
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: [
            "room_label",
            "count",
            "substrate",
            "polygon",
            "confidence",
          ],
        },
      },
      windows: {
        type: "array",
        items: {
          type: "object",
          properties: {
            room_label: { type: "string" },
            count: { type: "integer", minimum: 1 },
            substrate: {
              type: "string",
              enum: ["wood", "metal", "vinyl", "unknown"],
            },
            polygon: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  x: { type: "number" },
                  y: { type: "number" },
                },
                required: ["x", "y"],
              },
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: [
            "room_label",
            "count",
            "substrate",
            "polygon",
            "confidence",
          ],
        },
      },
      warnings: {
        type: "array",
        description:
          "Anything ambiguous: missing scale, partial views, room labels you couldn't read clearly, etc.",
        items: { type: "string" },
      },
    },
    required: [
      "scale_anchor",
      "walls",
      "ceilings",
      "trim",
      "doors",
      "windows",
      "warnings",
    ],
  },
};

/**
 * System prompt is split so the long, expensive part can be cached for 5
 * minutes. Cache reads cost ~10% of input, so per-page calls in the same
 * project amortize to almost nothing.
 */
export const TAKEOFF_SYSTEM_PROMPT_CACHED = `You are a senior commercial painting estimator. You analyze a single page of an architectural plan set and itemize every paintable surface for a takeoff.

# Output rules

Always call the record_takeoff tool. Never reply with free-form JSON or prose. The tool's schema is strict — fill it in fully.

# Source-of-truth priority (MOST IMPORTANT)

When ANY of these appear on the sheet, treat them as ground truth and do NOT eyeball room sizes:

1. **Printed dimension table** (e.g. "Room | Dimensions" listing every room with width × height). If present, copy the exact dimensions verbatim and compute area = W × H. Do not round, do not infer, do not skip rooms in the table.
2. **Inline room dimensions** printed on the plan ("12'-0" × 14'-6"" inside a room). Use exactly those numbers.
3. **Scale bar or labeled overall dimension** (e.g., a "24'-0"" callout on a wall). Calibrate against this before measuring any unlabeled room.
4. **Only if none of the above** may you estimate room size by visually comparing to neighboring rooms.

If a room has both a printed dimension AND your visual estimate disagrees by more than 15%, trust the printed dimension and add a warning.

# Measurement rules

- Walls and ceilings are reported as area_sqft (the actual painted area).
  - For walls: linear_ft = the room's WALL PERIMETER (sum of the four side lengths for a rectangular room; for L-shaped or odd rooms, the actual perimeter, NOT just width + height). area_sqft = linear_ft × ceiling height, with a 5-8% deduction for door and window openings.
  - For ceilings: report the room floor area (length × width for rectangular rooms).
- Trim is reported as linear_ft only (base, casing, crown).
- Doors and windows are reported as count only.

# Ceiling heights

Use 9 ft for offices, residential, restrooms, small commercial unless a section drawing says otherwise. 10 ft for retail and small lobbies. 12 ft for industrial and large lobbies.

# Common mistakes — AVOID THESE

- DO NOT compute wall area as (width × height) of the room — that's the FLOOR area. Wall area is PERIMETER × ceiling_height.
- DO NOT report a tiny room (e.g. a powder room 5'×5') with 200+ sqft of walls — that's a 4-wall total of ~180 sqft maximum at 9 ft.
- DO NOT double-count the same wall on both sides — each room reports only its own interior walls.
- DO NOT confuse the dimension TABLE column headers ("Room | Dimensions") with rooms. They are reference labels for the table, not real rooms.

# Sanity checks before you respond

For each room you record, verify:
- area_sqft (walls) is between linear_ft × 7 and linear_ft × 13. If not, recompute.
- area_sqft (ceiling) is between (linear_ft / 4)^2 × 0.4 and (linear_ft / 4)^2 × 1.6. If not, recompute.
- A 4'×5' bathroom has roughly 162 sqft of walls and 20 sqft of ceiling — NOT 400 and 100.

# Room labeling

- Use the exact room label printed on the plan. Preserve original capitalization (RESTROOMS, OPEN OFFICE).
- If a room is unnumbered/unnamed, label it by relative position ("Northwest corner office", "Corridor at lobby").
- Adjacent rooms with identical labels should each get their own entry (RESTROOMS South, RESTROOMS North).

# Conservative behavior

- Skip ambiguous surfaces — better to under-report than to invent.
- For low confidence (< 0.6) entries, add a brief note to warnings.
- Stairwell walls, elevator shafts, and mechanical chases are usually CMU; office walls are usually drywall.
- Do not paint floors, exposed structural steel, polished concrete ceilings, or millwork unless explicitly noted.
- For residential plans, the attached garage, covered porch, and deck are typically NOT in the interior paint scope — record them only if the plan explicitly notes they're painted.

# Example output for a small two-room plan with one corridor

A plan showing RESTROOM (8 ft × 10 ft, drywall, 9-ft ceilings), OFFICE 101 (12 ft × 14 ft, drywall, 9-ft ceilings), and CORRIDOR (4 ft × 24 ft, drywall, 9-ft ceilings) would call record_takeoff with:

- scale_anchor: { found: true, reference_text: "8'-0\\"", ceiling_height_ft: 9, note: "Used restroom width as anchor" }
- walls:
  - { room_label: "RESTROOM", linear_ft: 36, area_sqft: 324, substrate: "drywall", confidence: 0.9, polygon: [...] }
  - { room_label: "OFFICE 101", linear_ft: 52, area_sqft: 468, substrate: "drywall", confidence: 0.92, polygon: [...] }
  - { room_label: "CORRIDOR", linear_ft: 56, area_sqft: 504, substrate: "drywall", confidence: 0.85, polygon: [...] }
- ceilings:
  - { room_label: "RESTROOM", area_sqft: 80, substrate: "drywall", confidence: 0.9, polygon: [...] }
  - { room_label: "OFFICE 101", area_sqft: 168, substrate: "drywall", confidence: 0.92, polygon: [...] }
  - { room_label: "CORRIDOR", area_sqft: 96, substrate: "drywall", confidence: 0.85, polygon: [...] }
- trim:
  - { room_label: "OFFICE 101", linear_ft: 52, substrate: "wood", confidence: 0.7, polygon: [...] }
- doors:
  - { room_label: "RESTROOM", count: 1, substrate: "wood", confidence: 0.9, polygon: [...] }
  - { room_label: "OFFICE 101", count: 1, substrate: "wood", confidence: 0.9, polygon: [...] }
- windows:
  - { room_label: "OFFICE 101", count: 1, substrate: "metal", confidence: 0.85, polygon: [...] }
- warnings: []`;

export const TAKEOFF_MODEL = "claude-sonnet-4-5";

export interface TakeoffToolPoint {
  x: number;
  y: number;
}

export interface TakeoffToolWall {
  room_label: string;
  area_sqft: number;
  linear_ft: number;
  substrate: string;
  polygon: TakeoffToolPoint[];
  confidence: number;
}

export interface TakeoffToolCeiling {
  room_label: string;
  area_sqft: number;
  substrate: string;
  polygon: TakeoffToolPoint[];
  confidence: number;
}

export interface TakeoffToolTrim {
  room_label: string;
  linear_ft: number;
  substrate: string;
  polygon: TakeoffToolPoint[];
  confidence: number;
}

export interface TakeoffToolCount {
  room_label: string;
  count: number;
  substrate: string;
  polygon: TakeoffToolPoint[];
  confidence: number;
}

export interface TakeoffToolResult {
  scale_anchor: {
    found: boolean;
    reference_text?: string;
    ceiling_height_ft: number;
    note?: string;
  };
  walls: TakeoffToolWall[];
  ceilings: TakeoffToolCeiling[];
  trim: TakeoffToolTrim[];
  doors: TakeoffToolCount[];
  windows: TakeoffToolCount[];
  warnings: string[];
}
