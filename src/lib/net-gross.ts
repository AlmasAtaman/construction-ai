/**
 * Net vs Gross square-footage computation for a room polygon.
 *
 * In commercial estimating:
 *   - Gross SF (GSF) = the room's footprint INCLUDING wall thickness.
 *     This is what you measure with a tape on the floor side of the
 *     walls; it's also what shows on a code-compliance area calc.
 *   - Net SF (NSF)   = the interior usable floor area, walls excluded.
 *     This is what carpet/flooring estimates target, and the area you
 *     stand and walk on.
 *
 * The two differ by approximately (perimeter × wall_half_thickness × 2).
 * For a 6-inch wall, that's ~0.5 ft of "wall band" stolen from each
 * side of the perimeter. A 1000 sqft room with 130 ft of perimeter loses
 * ~65 sqft → net ~935.
 *
 * For PAINTING:
 *   - Walls       use linear feet × ceiling height (already correct).
 *   - Ceiling     ≈ net SF (painters don't paint over the wall heads).
 *   - Floor       = net SF if floor coating is in scope.
 *
 * The conversion is approximate — real wall thickness varies (3.5"
 * stud walls vs 8" CMU vs 12" exterior). We assume 6 inches by default;
 * the caller can override for a known wall system.
 */

export interface NetGrossResult {
  /** Gross SF (polygon shoelace area). */
  grossSqft: number;
  /** Net SF after wall-thickness inset. */
  netSqft: number;
  /** Polygon perimeter in linear feet. */
  perimeterLf: number;
  /** Wall thickness used in the calc (feet). */
  wallThicknessFt: number;
}

export interface PolygonPoint {
  /** Either real feet OR normalized 0..1 (caller sets `unit`). */
  x: number;
  y: number;
}

const DEFAULT_WALL_THICKNESS_FT = 0.5; // 6 inches

/**
 * Compute net/gross/perimeter for a polygon already in REAL FEET.
 * If your polygon is in normalized 0..1 coords, multiply by the page's
 * real-foot extents before calling.
 */
export function computeNetGross(
  polygon: PolygonPoint[],
  wallThicknessFt: number = DEFAULT_WALL_THICKNESS_FT,
): NetGrossResult {
  if (polygon.length < 3) {
    return {
      grossSqft: 0,
      netSqft: 0,
      perimeterLf: 0,
      wallThicknessFt,
    };
  }
  const grossSqft = shoelaceArea(polygon);
  const perimeterLf = perimeter(polygon);
  // Net = gross - (perimeter × halfThickness × 2 sides)
  // Half thickness because the wall straddles the polygon boundary.
  const wallBandSqft = perimeterLf * (wallThicknessFt / 2) * 2;
  const netSqft = Math.max(0, grossSqft - wallBandSqft);
  return {
    grossSqft: round1(grossSqft),
    netSqft: round1(netSqft),
    perimeterLf: round1(perimeterLf),
    wallThicknessFt,
  };
}

/**
 * Convenience: compute net/gross from a polygon in NORMALIZED 0..1
 * coordinates plus the page's real-foot extents (from the scale anchor).
 */
export function computeNetGrossFromNorm(
  polygonNorm: PolygonPoint[],
  pageWidthFt: number,
  pageHeightFt: number,
  wallThicknessFt: number = DEFAULT_WALL_THICKNESS_FT,
): NetGrossResult {
  const real = polygonNorm.map((p) => ({
    x: p.x * pageWidthFt,
    y: p.y * pageHeightFt,
  }));
  return computeNetGross(real, wallThicknessFt);
}

function shoelaceArea(poly: PolygonPoint[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum / 2);
}

function perimeter(poly: PolygonPoint[]): number {
  let p = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    p += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return p;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
