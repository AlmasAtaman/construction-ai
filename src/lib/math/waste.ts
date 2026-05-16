export const DEFAULT_WASTE_FACTOR = 0.10;

export function applyWaste(gallons: number, wasteFactor: number): number {
  return gallons * (1 + wasteFactor);
}
