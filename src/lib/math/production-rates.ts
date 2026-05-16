import type { SurfaceType } from "@/types/surface";

// PCA-standard defaults — sqft/hr for area surfaces, lf/hr for trim, ea/hr for count.
export const DEFAULT_PRODUCTION_RATES: Record<SurfaceType, number> = {
  wall: 175,
  ceiling: 135,
  trim: 60,
  door: 3.6,
  window: 6,
};

export interface ComplexityFlags {
  multiColor?: boolean;
  highGloss?: boolean;
  overhead?: boolean;
  narrowWork?: boolean;
  highTrafficPrep?: boolean;
}

export function complexityMultiplier(flags: ComplexityFlags): number {
  let mult = 1;
  if (flags.multiColor) mult *= 1.5;
  if (flags.highGloss) mult *= 1.5;
  if (flags.overhead) mult *= 1.2;
  if (flags.narrowWork) mult *= 1.1;
  if (flags.highTrafficPrep) mult *= 1.3;
  return mult;
}

export function productionRateFor(
  type: SurfaceType,
  flags: ComplexityFlags = {},
): number {
  const base = DEFAULT_PRODUCTION_RATES[type];
  return base / complexityMultiplier(flags);
}

export function unitFor(type: SurfaceType): "sqft" | "lf" | "ea" {
  if (type === "trim") return "lf";
  if (type === "door" || type === "window") return "ea";
  return "sqft";
}
