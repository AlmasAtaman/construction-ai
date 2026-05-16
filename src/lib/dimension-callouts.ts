/**
 * Dimension callout parser.
 *
 * Architectural plans print wall lengths directly on the drawing:
 *   12'-6"   (12 feet 6 inches)
 *   10'-0"
 *   12'        (whole feet only)
 *   4'-3"
 *   3"          (inches only — rare, usually wall thicknesses)
 *   2'-6 1/2"   (with fractional inches)
 *   12-6"       (some plans drop the foot mark)
 *
 * These are the architect's own numbers — ground truth, not estimates.
 * Parsing them and assigning each to the wall it measures gives us
 * deterministic dimensions, the same approach that landed residential
 * accuracy at 100%.
 *
 * Output: each callout carries its parsed length in feet plus its
 * position and orientation guess (whether it measures a horizontal or
 * vertical wall, inferred from the text rotation or surrounding
 * context).
 */

export interface DimensionCallout {
  /** Raw text e.g. "12'-6\"" */
  rawText: string;
  /** Total length in real-world feet. e.g. 12'-6" → 12.5 */
  lengthFt: number;
  /** Position of the text in PDF page space. */
  x: number;
  y: number;
  /**
   * Inferred orientation: "h" = measures a horizontal wall (text is
   * usually rotated 0° on top/bottom of the wall), "v" = vertical wall
   * (text is rotated 90°). Best-effort; null if unknown.
   */
  orientation: "h" | "v" | null;
  /** Confidence in the parse (1.0 = exact match of the canonical form). */
  confidence: number;
}

export interface ParseInput {
  text: string;
  x: number;
  y: number;
  /** Rotation in radians. ~0 = horizontal text; ~PI/2 = vertical. */
  rotation?: number;
}

/**
 * Match all dimension callouts in the text fragment list.
 */
export function parseDimensionCallouts(
  fragments: ParseInput[],
): DimensionCallout[] {
  const out: DimensionCallout[] = [];
  for (const f of fragments) {
    const parsed = parseOne(f.text);
    if (!parsed) continue;
    out.push({
      rawText: f.text,
      lengthFt: parsed.lengthFt,
      x: f.x,
      y: f.y,
      orientation: orientFromRotation(f.rotation),
      confidence: parsed.confidence,
    });
  }
  return out;
}

function orientFromRotation(rot?: number): "h" | "v" | null {
  if (rot === undefined || !Number.isFinite(rot)) return null;
  // Normalize to [0, 2π)
  let r = rot % (Math.PI * 2);
  if (r < 0) r += Math.PI * 2;
  // ~0 or ~PI = horizontal text. ~PI/2 or ~3PI/2 = vertical.
  const tol = 0.3;
  if (r < tol || Math.abs(r - Math.PI) < tol || Math.abs(r - 2 * Math.PI) < tol)
    return "h";
  if (Math.abs(r - Math.PI / 2) < tol || Math.abs(r - 3 * Math.PI / 2) < tol)
    return "v";
  return null;
}

/**
 * Parse a single dimension-callout string. Returns the length in feet,
 * or null if the text doesn't match a recognized form.
 */
function parseOne(
  text: string,
): { lengthFt: number; confidence: number } | null {
  const t = text.trim();
  if (t.length === 0 || t.length > 30) return null;

  // Don't match things like "SCALE 1/8" = 1'-0"" — exclude if it has
  // "=" or "SCALE" in it. Those are scale notations.
  if (/[=:]|scale/i.test(t)) return null;

  // Canonical: feet'-inches[ fraction]"
  //   12'-6"
  //   12'-6 1/2"
  //   12'-0"
  //   12-6"  (alternative dash form, no foot mark)
  //   12'6"  (no dash between feet and inches — common in residential)
  //   12'11" (same, two-digit inches)
  let m = /^(\d{1,3})\s*[''’′]\s*[-–]?\s*(\d{1,2})(?:\s+(\d+)\s*\/\s*(\d+))?\s*["”″]?$/.exec(t);
  if (m) {
    const ft = parseInt(m[1], 10);
    const inWhole = parseInt(m[2], 10);
    let inFrac = 0;
    if (m[3] && m[4]) {
      const n = parseInt(m[3], 10);
      const d = parseInt(m[4], 10);
      if (d > 0) inFrac = n / d;
    }
    const totalIn = inWhole + inFrac;
    if (ft >= 0 && ft < 1000 && totalIn >= 0 && totalIn < 12) {
      return { lengthFt: ft + totalIn / 12, confidence: 0.99 };
    }
  }

  // Feet only: 12'  or 12'-0" (caught above)
  m = /^(\d{1,3})\s*[''’′]\s*(?:-?\s*0\s*["”″]?)?$/.exec(t);
  if (m) {
    const ft = parseInt(m[1], 10);
    if (ft > 0 && ft < 1000) return { lengthFt: ft, confidence: 0.95 };
  }

  // Inches only: 6"  or  6 1/2"
  m = /^(\d{1,2})(?:\s+(\d+)\s*\/\s*(\d+))?\s*["”″]$/.exec(t);
  if (m) {
    const whole = parseInt(m[1], 10);
    let frac = 0;
    if (m[2] && m[3]) {
      const n = parseInt(m[2], 10);
      const d = parseInt(m[3], 10);
      if (d > 0) frac = n / d;
    }
    const total = whole + frac;
    if (total > 0 && total < 36) return { lengthFt: total / 12, confidence: 0.7 };
  }

  return null;
}

/**
 * For a given room polygon, find every dimension callout INSIDE or near
 * the polygon. "Near" means within `proximityPt` of the polygon edge.
 *
 * Returns the callouts sorted by distance from polygon center, with the
 * closest first.
 */
export function calloutsForRoom(
  callouts: DimensionCallout[],
  polygon: { x: number; y: number }[],
  proximityPt = 30,
): DimensionCallout[] {
  if (callouts.length === 0 || polygon.length < 3) return [];

  // Quick bbox + a slack region.
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of polygon) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  const xLo = x0 - proximityPt;
  const yLo = y0 - proximityPt;
  const xHi = x1 + proximityPt;
  const yHi = y1 + proximityPt;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;

  const out: DimensionCallout[] = [];
  for (const c of callouts) {
    if (c.x < xLo || c.x > xHi || c.y < yLo || c.y > yHi) continue;
    out.push(c);
  }
  out.sort(
    (a, b) =>
      (a.x - cx) ** 2 + (a.y - cy) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2),
  );
  return out;
}

/**
 * Given a room polygon's bbox and the callouts paired with it, estimate
 * the room's width × height in feet, prefer the two largest callouts of
 * each orientation (those are the room's overall dimensions). Falls back
 * to bbox-derived dimensions (using the scale anchor) when callouts are
 * unavailable.
 */
export function roomDimensionsFromCallouts(
  bbox: { x: number; y: number; width: number; height: number },
  callouts: DimensionCallout[],
  ptPerFoot: number,
): {
  widthFt: number;
  heightFt: number;
  areaSqft: number;
  source: "callouts" | "bbox" | "mixed";
  matchedCallouts: number;
} {
  // Geometry-derived dimensions (bbox in feet).
  const bboxWidthFt = bbox.width / ptPerFoot;
  const bboxHeightFt = bbox.height / ptPerFoot;

  // Orientation-typed callouts.
  const hor = callouts.filter((c) => c.orientation === "h");
  const ver = callouts.filter((c) => c.orientation === "v");

  // Prefer the LARGEST callout in each orientation if its value matches
  // the bbox dimension within ±25% — that's the room's overall length.
  const matchTol = 0.25;
  let widthFt = bboxWidthFt;
  let heightFt = bboxHeightFt;
  let usedH = false;
  let usedV = false;

  if (hor.length > 0) {
    const horSorted = [...hor].sort((a, b) => b.lengthFt - a.lengthFt);
    for (const c of horSorted) {
      const err = Math.abs(c.lengthFt - bboxWidthFt) / Math.max(1, bboxWidthFt);
      if (err <= matchTol) {
        widthFt = c.lengthFt;
        usedH = true;
        break;
      }
    }
  }
  if (ver.length > 0) {
    const verSorted = [...ver].sort((a, b) => b.lengthFt - a.lengthFt);
    for (const c of verSorted) {
      const err = Math.abs(c.lengthFt - bboxHeightFt) / Math.max(1, bboxHeightFt);
      if (err <= matchTol) {
        heightFt = c.lengthFt;
        usedV = true;
        break;
      }
    }
  }

  let source: "callouts" | "bbox" | "mixed";
  if (usedH && usedV) source = "callouts";
  else if (!usedH && !usedV) source = "bbox";
  else source = "mixed";

  return {
    widthFt,
    heightFt,
    areaSqft: widthFt * heightFt,
    source,
    matchedCallouts: hor.length + ver.length,
  };
}
