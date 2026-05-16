export const DEFAULT_COVERAGE_SQFT_PER_GAL = 350;

const SUBSTRATE_COVERAGE_ADJUSTMENT: Record<string, number> = {
  CMU: 1.3,
  cmu: 1.3,
  "heavy texture drywall": 1.2,
  "drywall heavy texture": 1.2,
  drywall: 1.0,
  smooth: 1.0,
  wood: 1.05,
  metal: 1.1,
  concrete: 1.2,
  unknown: 1.0,
};

export function coverageFor(substrate: string | null | undefined): number {
  if (!substrate) return DEFAULT_COVERAGE_SQFT_PER_GAL;
  const key = substrate.toLowerCase();
  for (const [s, mult] of Object.entries(SUBSTRATE_COVERAGE_ADJUSTMENT)) {
    if (key.includes(s.toLowerCase())) {
      return DEFAULT_COVERAGE_SQFT_PER_GAL / mult;
    }
  }
  return DEFAULT_COVERAGE_SQFT_PER_GAL;
}
