export type SurfaceType = "wall" | "ceiling" | "trim" | "door" | "window";
export type SurfaceStatus = "proposed" | "accepted" | "manual" | "excluded";
export type SurfaceSource = "ai" | "manual";

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
