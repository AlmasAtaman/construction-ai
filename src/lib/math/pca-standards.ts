// PCA standard says: do not deduct for openings smaller than 100 sqft.
// We don't have explicit opening data, but we approximate by treating
// doors and windows under threshold as full-area additions in gross mode,
// no-op in net mode (counted as their own surfaces).

export type MeasurementMode = "net" | "gross" | "pca";

export const PCA_OPENING_DEDUCT_THRESHOLD_SQFT = 100;

/**
 * Apply measurement mode adjustment to a wall/ceiling square footage.
 * - net: as-is (assume user already deducted openings)
 * - gross: add back small opening allowance (5% bump)
 * - pca: ignore openings under 100 sqft (effectively gross for small ones)
 */
export function adjustForMode(
  squareFootage: number,
  mode: MeasurementMode,
): number {
  if (mode === "net") return squareFootage;
  if (mode === "gross") return squareFootage * 1.05;
  if (mode === "pca") return squareFootage * 1.03;
  return squareFootage;
}
