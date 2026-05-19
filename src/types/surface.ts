export type SurfaceType = "wall" | "ceiling" | "trim" | "door" | "window";
export type SurfaceStatus = "proposed" | "accepted" | "manual" | "excluded";
export type SurfaceSource = "ai" | "manual";

// How the polygon's coordinates AND measurements were produced. Distinct
// from `source` (which is who created the surface — AI or manual).
// Contractors use this to judge how much to trust a single number.
//
// Trust order, best → worst:
//   scale-measured       — real geometry × plan scale (engine's primary)
//   table-cross-checked  — printed table × scale agree within ±10 %
//   traced               — real face polygon but no scale-derived measurement
//   sized-from-dimensions — rectangle sized from printed dims, label-anchored
//   table-only           — table value with no on-plan placement (no marker)
//   virtual-partition    — boundary COMPUTED by partitioning an open zone
//                          between adjacent room labels (open-plan fallback).
//                          The polygon is bounded by real walls where they
//                          exist and virtual cut lines where they don't.
//                          Honestly tagged so the estimator knows to review.
//   scale-needed         — vector room found, but scale not yet established
//   geometry-uncertain   — label found, but the extracted face is implausibly
//                          small (a sliver inside the room, not the room) AND
//                          no printed callout grounds the dimensions. Better
//                          honest absence than a confident sliver number.
//   ai-fallback          — last-resort AI estimate (legacy)
//   manual               — drawn by the user
export type SurfaceDerivation =
  | "scale-measured"
  | "table-cross-checked"
  | "traced"
  | "sized-from-dimensions"
  | "table-only"
  | "virtual-partition"
  | "scale-needed"
  | "geometry-uncertain"
  | "ai-fallback"
  | "manual";

export interface SurfacePoint {
  x: number;
  y: number;
}

export interface SurfaceDTO {
  id: string;
  projectId: string;
  planPageId: string;
  type: SurfaceType;
  paintType: string | null;
  coats: number;
  substrate: string | null;
  roomLabel: string | null;
  polygon: SurfacePoint[];
  squareFootage: number | null;
  linearFootage: number | null;
  count: number | null;
  confidence: number;
  status: SurfaceStatus;
  source: SurfaceSource;
  derivation: SurfaceDerivation | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export const SURFACE_COLORS: Record<SurfaceType, string> = {
  wall: "#3b82f6",
  ceiling: "#a855f7",
  trim: "#22c55e",
  door: "#f97316",
  window: "#eab308",
};

export const SURFACE_TYPE_LABELS: Record<SurfaceType, string> = {
  wall: "Wall",
  ceiling: "Ceiling",
  trim: "Trim",
  door: "Door",
  window: "Window",
};

export function confidenceLabel(c: number): "high" | "medium" | "low" {
  if (c >= 0.8) return "high";
  if (c >= 0.6) return "medium";
  return "low";
}
