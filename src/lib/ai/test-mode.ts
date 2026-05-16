export interface TakeoffSurface {
  type: "wall" | "ceiling" | "trim" | "door" | "window";
  polygon: { x: number; y: number }[];
  roomLabel?: string | null;
  estimatedSquareFootage?: number | null;
  estimatedLinearFootage?: number | null;
  count?: number | null;
  substrate?: string | null;
  confidence: number;
}

export interface TakeoffResponse {
  surfaces: TakeoffSurface[];
  rooms?: { label: string; polygon: { x: number; y: number }[] }[];
  scale?: {
    detected: boolean;
    ratioPxPerFoot: number | null;
    notes: string;
  };
  warnings?: string[];
}

export function isTestMode(): boolean {
  return process.env.TEST_MODE === "1" || process.env.NODE_ENV === "test";
}

export function stubTakeoff(): {
  response: TakeoffResponse;
  inputTokens: number;
  outputTokens: number;
} {
  const response: TakeoffResponse = {
    surfaces: [
      {
        type: "wall",
        polygon: [
          { x: 0.1, y: 0.1 },
          { x: 0.45, y: 0.1 },
          { x: 0.45, y: 0.4 },
          { x: 0.1, y: 0.4 },
        ],
        roomLabel: "Bathroom 101",
        estimatedSquareFootage: 220,
        substrate: "drywall",
        confidence: 0.91,
      },
      {
        type: "wall",
        polygon: [
          { x: 0.55, y: 0.1 },
          { x: 0.9, y: 0.1 },
          { x: 0.9, y: 0.4 },
          { x: 0.55, y: 0.4 },
        ],
        roomLabel: "Bathroom 102",
        estimatedSquareFootage: 240,
        substrate: "drywall",
        confidence: 0.88,
      },
      {
        type: "ceiling",
        polygon: [
          { x: 0.1, y: 0.5 },
          { x: 0.45, y: 0.5 },
          { x: 0.45, y: 0.85 },
          { x: 0.1, y: 0.85 },
        ],
        roomLabel: "Lobby",
        estimatedSquareFootage: 480,
        substrate: "drywall",
        confidence: 0.74,
      },
      {
        type: "trim",
        polygon: [
          { x: 0.55, y: 0.5 },
          { x: 0.9, y: 0.5 },
          { x: 0.9, y: 0.55 },
          { x: 0.55, y: 0.55 },
        ],
        roomLabel: "Corridor",
        estimatedLinearFootage: 64,
        substrate: "wood",
        confidence: 0.52,
      },
      {
        type: "door",
        polygon: [
          { x: 0.7, y: 0.7 },
          { x: 0.78, y: 0.7 },
          { x: 0.78, y: 0.85 },
          { x: 0.7, y: 0.85 },
        ],
        roomLabel: "Corridor",
        count: 1,
        substrate: "wood",
        confidence: 0.83,
      },
    ],
    rooms: [
      {
        label: "Bathroom 101",
        polygon: [
          { x: 0.08, y: 0.08 },
          { x: 0.47, y: 0.08 },
          { x: 0.47, y: 0.42 },
          { x: 0.08, y: 0.42 },
        ],
      },
    ],
    scale: { detected: false, ratioPxPerFoot: null, notes: "TEST_MODE stub" },
    warnings: [],
  };
  return { response, inputTokens: 2400, outputTokens: 480 };
}

export function stubSpecAnalysis(): {
  response: SpecAnalysisResponse;
  inputTokens: number;
  outputTokens: number;
} {
  const response: SpecAnalysisResponse = {
    paintScope: [
      {
        area: "Patient Rooms 101-120",
        surface: "walls",
        paintType: "eggshell latex",
        sheen: "eggshell",
        coats: 2,
        color: "manufacturer's standard light gray",
      },
      {
        area: "Bathrooms (all)",
        surface: "walls",
        paintType: "semi-gloss epoxy",
        sheen: "semi-gloss",
        coats: 2,
        color: "white",
      },
    ],
    finishSchedule: [
      { room: "Patient Rooms 101-120", paintType: "eggshell latex" },
      { room: "Bathrooms (all)", paintType: "semi-gloss epoxy" },
    ],
    flaggedRequirements: [
      {
        item: "Low-VOC requirement",
        quote: "All paints shall meet GreenSeal GS-11 standard, < 50 g/L VOC.",
        risk: "medium",
      },
      {
        item: "Anti-microbial coating in patient rooms",
        quote:
          "Apply anti-microbial primer in all patient room walls per section 09 91 23.",
        risk: "high",
      },
    ],
    productionRateAdjustments: [
      "Anti-microbial primer adds ~15% labor time per coat",
      "Color changes at door frames in patient rooms — adjust trim rate +10%",
    ],
    safetyRequirements: [
      "Confined space PPE for mechanical room paint work",
      "Scaffolding required for lobby ceiling (24' high)",
    ],
    materialRequirements: ["Sherwin-Williams ProMar 200 or approved equal"],
    exclusions: [
      "Floors, ceilings finished by others, exposed structural steel",
    ],
  };
  return { response, inputTokens: 3200, outputTokens: 720 };
}

export interface SpecAnalysisResponse {
  paintScope: {
    area: string;
    surface: string;
    paintType: string;
    sheen?: string;
    coats: number;
    color?: string;
  }[];
  finishSchedule: { room: string; paintType: string }[];
  flaggedRequirements: { item: string; quote: string; risk: string }[];
  productionRateAdjustments: string[];
  safetyRequirements: string[];
  materialRequirements: string[];
  exclusions: string[];
}
