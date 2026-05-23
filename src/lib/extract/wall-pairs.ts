/**
 * Double-line wall detection — the "what is a wall" pre-filter.
 *
 * On real architectural plans a wall is drawn as TWO parallel faces a
 * wall-thickness apart; furniture, dimension witness lines, text and most
 * symbols are single lines. So a segment that has a parallel partner at
 * wall-thickness distance is (almost certainly) a wall face, and a segment
 * that has none is (almost certainly) not.
 *
 * We confirmed empirically (scripts/probe-poche.mts on the commercial wall
 * plan p5) that:
 *   - stroke lineweight does NOT separate walls from noise (median 0.24pt both)
 *   - poché solid-fill is NOT used (38 of 5,864 fills are wall-shaped)
 *   - double-line pairs DO trace the walls (772 H + 320 V paired segments
 *     land on the building outline; tables/text/most dimensions do not)
 *
 * `detectWallCenterlines` pairs the faces and returns ONE centerline segment
 * per pair (the midline of the two faces, trimmed to their overlap). Using
 * the centerline — not both faces — keeps linear footage correct (tracing
 * both faces would double-count) and yields a single clean line per wall.
 *
 * This module is deliberately standalone: it runs BEFORE buildWallGraph and
 * does not touch room detection, the overlay, scale, or bid math.
 */

export interface PairSeg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Faces closer than this are a duplicate stroke, not two wall faces. */
export const WALL_PAIR_MIN_GAP_PT = 2.5;
/** Wall-thickness ceiling. ~12pt ≈ 8in at 18pt/ft — wider gaps are rooms,
 *  not wall cavities. Tuned on the commercial fixture (median pair gap 6pt). */
export const WALL_PAIR_MAX_GAP_PT = 12;
/** Two faces must run alongside each other at least this far to count. */
export const WALL_PAIR_MIN_OVERLAP_PT = 16;
/** Parallel tolerance for diagonal faces (~4.6°). */
export const WALL_PAIR_ANGLE_TOL_RAD = 0.08;
/** A segment within this of an axis is treated as horizontal/vertical. */
export const WALL_PAIR_AXIS_TOL_PT = 1.5;
/**
 * A centerline is trimmed to where its two faces overlap, which stops it
 * short of corners by ~half a wall thickness. We extend each end by this
 * much so perpendicular walls actually cross at corners and the graph can
 * stitch them into one connected network (otherwise the wall pieces stay
 * fragmented and lose to the dimension-line chain in component pruning).
 * Kept ≤ buildWallGraph's stub-prune length so leftover overhangs are
 * trimmed back off after the corners are formed.
 */
export const WALL_PAIR_EXTEND_PT = 7;

export interface WallPairOptions {
  minGapPt?: number;
  maxGapPt?: number;
  minOverlapPt?: number;
  angleTolRad?: number;
  axisTolPt?: number;
  extendPt?: number;
}

interface Out {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const yMid = (s: PairSeg): number => (s.y1 + s.y2) / 2;
const xMid = (s: PairSeg): number => (s.x1 + s.x2) / 2;

/**
 * Perpendicular distance under which two parallel centerlines count as
 * "stacked". A real wall collapses to ONE centerline with no parallel
 * neighbor this close; a dimension ladder or hatch produces a STACK of
 * closely-spaced parallel centerlines. Set just above the wall-pair gap so
 * a wall's single centerline is never flagged, but the ~8-12pt rungs of a
 * dimension ladder are. Two genuinely separate walls are >= ~2ft (~36pt)
 * apart, well clear of this. */
export const WALL_STACK_DIST_PT = 16;

/**
 * Drops centerlines that belong to a stack of 3+ closely-spaced parallel
 * lines (dimension ladders, hatching) — the noise an AI wall-region box
 * cannot exclude because it rings the building. A centerline is dropped
 * only if it has parallel, overlapping neighbors within `stackDistPt` on
 * BOTH... no — if it has any such neighbor AND that neighbor itself has
 * another, i.e. the line sits in a multi-line band rather than being one
 * isolated wall line. We approximate with: drop if it has >= 2 parallel
 * overlapping neighbors within stackDistPt (a ladder rung), keep otherwise.
 */
export function dropParallelStacks<T extends PairSeg>(
  centerlines: T[],
  opts: { stackDistPt?: number; minOverlapPt?: number; axisTolPt?: number } = {},
): T[] {
  const stack = opts.stackDistPt ?? WALL_STACK_DIST_PT;
  const minOverlap = opts.minOverlapPt ?? WALL_PAIR_MIN_OVERLAP_PT;
  const axisTol = opts.axisTolPt ?? WALL_PAIR_AXIS_TOL_PT;

  const idxH: number[] = [];
  const idxV: number[] = [];
  centerlines.forEach((s, i) => {
    const dx = Math.abs(s.x2 - s.x1);
    const dy = Math.abs(s.y2 - s.y1);
    if (dy <= axisTol && dx > axisTol) idxH.push(i);
    else if (dx <= axisTol && dy > axisTol) idxV.push(i);
  });

  const overlap1D = (a0: number, a1: number, b0: number, b1: number): number =>
    Math.min(Math.max(a0, a1), Math.max(b0, b1)) -
    Math.max(Math.min(a0, a1), Math.min(b0, b1));

  const neighborCount = new Array(centerlines.length).fill(0);

  const tally = (idx: number[], horiz: boolean): void => {
    for (let a = 0; a < idx.length; a++) {
      const sa = centerlines[idx[a]];
      const offA = horiz ? yMid(sa) : xMid(sa);
      for (let b = a + 1; b < idx.length; b++) {
        const sb = centerlines[idx[b]];
        const offB = horiz ? yMid(sb) : xMid(sb);
        const d = Math.abs(offA - offB);
        // Skip near-collinear lines (same wall, deduped fragments) and lines
        // farther than a ladder rung.
        if (d < 3 || d > stack) continue;
        const ov = horiz
          ? overlap1D(sa.x1, sa.x2, sb.x1, sb.x2)
          : overlap1D(sa.y1, sa.y2, sb.y1, sb.y2);
        if (ov < minOverlap) continue;
        neighborCount[idx[a]]++;
        neighborCount[idx[b]]++;
      }
    }
  };
  tally(idxH, true);
  tally(idxV, false);

  // A ladder rung has neighbors on both sides (>=2); a wall-and-one-stray
  // pairing (count 1) is kept to avoid eating real walls near a lone dim line.
  return centerlines.filter((_, i) => neighborCount[i] < 2);
}

/**
 * Returns one centerline segment per detected double-line wall. Segments
 * without a parallel partner at wall-thickness distance are dropped.
 */
export function detectWallCenterlines<T extends PairSeg>(
  segments: T[],
  opts: WallPairOptions = {},
): Out[] {
  const minGap = opts.minGapPt ?? WALL_PAIR_MIN_GAP_PT;
  const maxGap = opts.maxGapPt ?? WALL_PAIR_MAX_GAP_PT;
  const minOverlap = opts.minOverlapPt ?? WALL_PAIR_MIN_OVERLAP_PT;
  const angleTol = opts.angleTolRad ?? WALL_PAIR_ANGLE_TOL_RAD;
  const axisTol = opts.axisTolPt ?? WALL_PAIR_AXIS_TOL_PT;
  const ext = opts.extendPt ?? WALL_PAIR_EXTEND_PT;

  const horiz: T[] = [];
  const vert: T[] = [];
  const diag: T[] = [];
  for (const s of segments) {
    const dx = Math.abs(s.x2 - s.x1);
    const dy = Math.abs(s.y2 - s.y1);
    if (dy <= axisTol && dx > axisTol) horiz.push(s);
    else if (dx <= axisTol && dy > axisTol) vert.push(s);
    else if (dx > axisTol && dy > axisTol) diag.push(s);
  }

  const out: Out[] = [];

  // --- Horizontal walls: partner differs in y by [minGap,maxGap], x-overlap ---
  horiz.sort((a, b) => yMid(a) - yMid(b));
  for (let i = 0; i < horiz.length; i++) {
    const yi = yMid(horiz[i]);
    const aL = Math.min(horiz[i].x1, horiz[i].x2);
    const aR = Math.max(horiz[i].x1, horiz[i].x2);
    for (let j = i + 1; j < horiz.length; j++) {
      const gap = yMid(horiz[j]) - yi; // >= 0, ascending
      if (gap > maxGap) break;
      if (gap < minGap) continue;
      const bL = Math.min(horiz[j].x1, horiz[j].x2);
      const bR = Math.max(horiz[j].x1, horiz[j].x2);
      const left = Math.max(aL, bL);
      const right = Math.min(aR, bR);
      if (right - left < minOverlap) continue;
      const ym = (yi + yMid(horiz[j])) / 2;
      out.push({ x1: left - ext, y1: ym, x2: right + ext, y2: ym });
    }
  }

  // --- Vertical walls: partner differs in x by [minGap,maxGap], y-overlap ---
  vert.sort((a, b) => xMid(a) - xMid(b));
  for (let i = 0; i < vert.length; i++) {
    const xi = xMid(vert[i]);
    const aB = Math.min(vert[i].y1, vert[i].y2);
    const aT = Math.max(vert[i].y1, vert[i].y2);
    for (let j = i + 1; j < vert.length; j++) {
      const gap = xMid(vert[j]) - xi;
      if (gap > maxGap) break;
      if (gap < minGap) continue;
      const bB = Math.min(vert[j].y1, vert[j].y2);
      const bT = Math.max(vert[j].y1, vert[j].y2);
      const bottom = Math.max(aB, bB);
      const top = Math.min(aT, bT);
      if (top - bottom < minOverlap) continue;
      const xm = (xi + xMid(vert[j])) / 2;
      out.push({ x1: xm, y1: bottom - ext, x2: xm, y2: top + ext });
    }
  }

  // --- Diagonal walls: parallel + perpendicular gap + projected overlap ---
  // Diagonals are few on real plans, so a naive O(m^2) pass is fine.
  for (let i = 0; i < diag.length; i++) {
    const a = diag[i];
    const adx = a.x2 - a.x1;
    const ady = a.y2 - a.y1;
    const aLen = Math.hypot(adx, ady);
    if (aLen === 0) continue;
    const ux = adx / aLen;
    const uy = ady / aLen;
    const aProj1 = 0;
    const aProj2 = aLen;
    const aMin = Math.min(aProj1, aProj2);
    const aMax = Math.max(aProj1, aProj2);
    for (let j = i + 1; j < diag.length; j++) {
      const b = diag[j];
      const bdx = b.x2 - b.x1;
      const bdy = b.y2 - b.y1;
      const bLen = Math.hypot(bdx, bdy);
      if (bLen === 0) continue;
      // Parallel test (cross of unit directions, ignore sign).
      const cross = Math.abs(ux * (bdy / bLen) - uy * (bdx / bLen));
      if (cross > Math.sin(angleTol)) continue;
      // Perpendicular gap from a's line to b's start point.
      const wx = b.x1 - a.x1;
      const wy = b.y1 - a.y1;
      const perp = Math.abs(wx * -uy + wy * ux);
      if (perp < minGap || perp > maxGap) continue;
      // Projected overlap of b onto a's axis.
      const b1 = (b.x1 - a.x1) * ux + (b.y1 - a.y1) * uy;
      const b2 = (b.x2 - a.x1) * ux + (b.y2 - a.y1) * uy;
      const bMin = Math.min(b1, b2);
      const bMax = Math.max(b1, b2);
      const lo = Math.max(aMin, bMin) - ext;
      const hi = Math.min(aMax, bMax) + ext;
      if (hi - lo < minOverlap) continue;
      // Centerline = a's overlap span shifted half the perpendicular offset
      // toward b. Offset direction is the perpendicular (−uy, ux).
      const sign = wx * -uy + wy * ux >= 0 ? 1 : -1;
      const ox = (-uy * perp * sign) / 2;
      const oy = (ux * perp * sign) / 2;
      out.push({
        x1: a.x1 + ux * lo + ox,
        y1: a.y1 + uy * lo + oy,
        x2: a.x1 + ux * hi + ox,
        y2: a.y1 + uy * hi + oy,
      });
    }
  }

  return out;
}
