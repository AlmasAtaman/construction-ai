/**
 * Standard architectural symbols and their visual descriptions.
 *
 * Used as the AI's reference vocabulary when scanning a floor plan to
 * count repeating fixtures, electrical components, and equipment. The
 * symbol shapes referenced here follow common US architectural drafting
 * conventions (AIA standards, AutoCAD electrical symbols, etc.).
 */

export type SymbolType =
  // Electrical
  | "duplex_outlet"
  | "switch"
  | "gfci_outlet"
  | "light_fixture_ceiling"
  | "light_fixture_recessed"
  | "exit_sign"
  | "smoke_detector"
  // Plumbing
  | "toilet"
  | "urinal"
  | "lavatory_sink"
  | "kitchen_sink"
  | "shower"
  | "bathtub"
  | "drinking_fountain"
  | "floor_drain"
  // HVAC
  | "supply_diffuser"
  | "return_grille"
  | "thermostat"
  // Fire/safety
  | "sprinkler_head"
  | "fire_extinguisher"
  | "fire_alarm_pull"
  // Openings
  | "single_door"
  | "double_door"
  | "ada_door"
  | "cased_opening"
  | "window"
  // Furniture/fixtures (counted but not always priced)
  | "desk"
  | "chair"
  | "table"
  | "cabinet";

export interface SymbolDefinition {
  type: SymbolType;
  category:
    | "electrical"
    | "plumbing"
    | "hvac"
    | "fire_safety"
    | "openings"
    | "furniture";
  /** Brief visual description for the AI. */
  description: string;
  /** Typical size in inches, helps the AI confirm it's the right symbol. */
  typicalSizeIn: string;
  /** Whether this is critical for painting takeoff (doors/windows yes, furniture no). */
  paintingRelevant: boolean;
}

export const SYMBOL_GLOSSARY: SymbolDefinition[] = [
  // Electrical
  {
    type: "duplex_outlet",
    category: "electrical",
    description:
      "Small circle with horizontal short bar (often labeled with subscript), drawn on a wall line",
    typicalSizeIn: "3 in (drawing symbol)",
    paintingRelevant: false,
  },
  {
    type: "switch",
    category: "electrical",
    description:
      "Letter S (sometimes inside a small circle) on a wall line, near a door",
    typicalSizeIn: "3 in",
    paintingRelevant: false,
  },
  {
    type: "gfci_outlet",
    category: "electrical",
    description: "Circle with bar plus 'GFCI' or 'GFI' annotation",
    typicalSizeIn: "3 in",
    paintingRelevant: false,
  },
  {
    type: "light_fixture_ceiling",
    category: "electrical",
    description:
      "Circle with X inside, or a hexagon shape (varied) at room interior",
    typicalSizeIn: "12 in",
    paintingRelevant: false,
  },
  {
    type: "light_fixture_recessed",
    category: "electrical",
    description: "Square or rectangle with X inside, typical 2x4 or 2x2 grid pattern",
    typicalSizeIn: "24 in",
    paintingRelevant: false,
  },
  {
    type: "exit_sign",
    category: "electrical",
    description:
      "Hexagon or rectangle labeled 'EXIT' or with diagonal arrow",
    typicalSizeIn: "12 in",
    paintingRelevant: false,
  },
  {
    type: "smoke_detector",
    category: "electrical",
    description: "Small circle with 'SD' annotation, on ceiling",
    typicalSizeIn: "5 in",
    paintingRelevant: false,
  },
  // Plumbing
  {
    type: "toilet",
    category: "plumbing",
    description: "Oval or D-shape attached to a rectangle (tank), against a wall",
    typicalSizeIn: "16 in × 28 in",
    paintingRelevant: false,
  },
  {
    type: "urinal",
    category: "plumbing",
    description: "Small rectangle or D-shape on a wall, only in commercial restrooms",
    typicalSizeIn: "14 in × 14 in",
    paintingRelevant: false,
  },
  {
    type: "lavatory_sink",
    category: "plumbing",
    description: "Rectangle with small circle (drain) inside, on a wall counter",
    typicalSizeIn: "20 in × 16 in",
    paintingRelevant: false,
  },
  {
    type: "kitchen_sink",
    category: "plumbing",
    description: "Rectangle with one or two circles (basins) inside, on a counter",
    typicalSizeIn: "33 in × 22 in",
    paintingRelevant: false,
  },
  {
    type: "shower",
    category: "plumbing",
    description: "Square or rectangle 36 in × 36 in or 36 in × 60 in with X across corners",
    typicalSizeIn: "36 in × 36 in",
    paintingRelevant: false,
  },
  {
    type: "bathtub",
    category: "plumbing",
    description: "Rectangle ~30 in × 60 in with a rounded interior shape",
    typicalSizeIn: "30 in × 60 in",
    paintingRelevant: false,
  },
  {
    type: "drinking_fountain",
    category: "plumbing",
    description: "Small rectangle or D against a wall labeled 'DF' or 'EWC'",
    typicalSizeIn: "12 in × 12 in",
    paintingRelevant: false,
  },
  {
    type: "floor_drain",
    category: "plumbing",
    description: "Small circle in floor, often in restrooms or mechanical rooms",
    typicalSizeIn: "6 in",
    paintingRelevant: false,
  },
  // HVAC
  {
    type: "supply_diffuser",
    category: "hvac",
    description:
      "Square with diagonal X or curved lines (showing airflow), in ceiling",
    typicalSizeIn: "24 in × 24 in",
    paintingRelevant: false,
  },
  {
    type: "return_grille",
    category: "hvac",
    description: "Square with parallel horizontal lines (louvers), in ceiling",
    typicalSizeIn: "24 in × 24 in",
    paintingRelevant: false,
  },
  {
    type: "thermostat",
    category: "hvac",
    description: "Small rectangle labeled 'T' or 'TSTAT' on a wall",
    typicalSizeIn: "5 in",
    paintingRelevant: false,
  },
  // Fire/safety
  {
    type: "sprinkler_head",
    category: "fire_safety",
    description: "Small circle with X or cross, on ceiling",
    typicalSizeIn: "2 in",
    paintingRelevant: false,
  },
  {
    type: "fire_extinguisher",
    category: "fire_safety",
    description: "Rectangle labeled 'FE' or 'FEC' on a wall",
    typicalSizeIn: "10 in",
    paintingRelevant: false,
  },
  {
    type: "fire_alarm_pull",
    category: "fire_safety",
    description: "Small box labeled 'FA' or 'PS' on a wall, near exits",
    typicalSizeIn: "5 in",
    paintingRelevant: false,
  },
  // Openings (painting relevant — already counted by takeoff but useful here too)
  {
    type: "single_door",
    category: "openings",
    description:
      "Gap in wall with a swung quarter-arc and a straight panel line — ~3 ft wide opening",
    typicalSizeIn: "36 in",
    paintingRelevant: true,
  },
  {
    type: "double_door",
    category: "openings",
    description:
      "Two adjacent swung arcs in a wider wall opening — ~6 ft total",
    typicalSizeIn: "72 in",
    paintingRelevant: true,
  },
  {
    type: "ada_door",
    category: "openings",
    description: "Single door drawn wider than standard ~3'-6 in to 4'-0 in",
    typicalSizeIn: "42 in",
    paintingRelevant: true,
  },
  {
    type: "cased_opening",
    category: "openings",
    description:
      "Wall opening with NO door (no arc), often between rooms, indicated by short break in the wall line",
    typicalSizeIn: "variable",
    paintingRelevant: true,
  },
  {
    type: "window",
    category: "openings",
    description:
      "Three or four parallel lines in a wall section (the window sash), straight rectangle",
    typicalSizeIn: "variable",
    paintingRelevant: true,
  },
  // Furniture (not painting relevant — we count to verify rooms)
  {
    type: "desk",
    category: "furniture",
    description: "Rectangle, typically 30 in × 60 in, in offices",
    typicalSizeIn: "30 in × 60 in",
    paintingRelevant: false,
  },
  {
    type: "chair",
    category: "furniture",
    description: "Small square or trapezoid",
    typicalSizeIn: "20 in × 20 in",
    paintingRelevant: false,
  },
  {
    type: "table",
    category: "furniture",
    description: "Large rectangle or oval, in meeting rooms",
    typicalSizeIn: "variable",
    paintingRelevant: false,
  },
  {
    type: "cabinet",
    category: "furniture",
    description: "Rectangle on a wall, often with shelves shown inside",
    typicalSizeIn: "variable",
    paintingRelevant: false,
  },
];

/** Quick lookup. */
export function getSymbolDefinition(type: SymbolType): SymbolDefinition {
  const def = SYMBOL_GLOSSARY.find((s) => s.type === type);
  if (!def) throw new Error(`Unknown symbol type: ${type}`);
  return def;
}

/** Format the glossary for the AI system prompt. */
export function glossaryAsPrompt(filter?: SymbolDefinition["category"][]): string {
  const lines = SYMBOL_GLOSSARY.filter(
    (s) => !filter || filter.includes(s.category),
  ).map(
    (s) =>
      `- ${s.type} (${s.category}, ~${s.typicalSizeIn}): ${s.description}`,
  );
  return lines.join("\n");
}
