/**
 * Snap engine for the wall-path tool. Given a cursor position in
 * normalized (0..1, y-down) page coords and the cleaned wall network
 * from the walls API, returns either:
 *   - the nearest segment endpoint, if within `endpointRadiusNorm`
 *   - the projection of the cursor onto the nearest segment, if its
 *     perpendicular distance is within `edgeRadiusNorm`
 *   - null if no snap (caller records cursor as-clicked, tagged "free")
 *
 * Endpoint snap is always preferred over edge-projection snap so wall
 * corners join cleanly.
 *
 * Coordinates are normalized for the same reason the rest of the
 * editor uses them — they survive zoom/pan with no transform math.
 * Radii are also in normalized space so the caller converts a screen-
 * pixel radius via `screenRadiusToNorm(zoom, pageDim)` once per
 * pointer move.
 */

import type { WallSegmentNorm } from "@/lib/store/editor-store";
import type { PathSnap } from "@/types/surface";

export interface SnapResult {
  x: number;
  y: number;
  snap: Exclude<PathSnap, "free">;
  /** Index into the input segments array — the segment that produced
   *  the snap. Useful for downstream auto-trace integration. */
  segmentIndex: number;
}

export interface SnapOpts {
  /** Snap to endpoints within this normalized distance. */
  endpointRadiusNorm: number;
  /** Snap to edge projection within this normalized perpendicular distance. */
  edgeRadiusNorm: number;
}

/**
 * Convert a screen-pixel radius into normalized page coords given the
 * current zoom and the natural (zoom=1) rendered page width in CSS px.
 * Both axes share the same scale because the PDF preserves aspect
 * ratio, so we only need the width.
 */
export function screenRadiusToNorm(
  screenPx: number,
  zoom: number,
  contentWidthPx: number,
): number {
  if (contentWidthPx <= 0) return 0;
  return screenPx / (zoom * contentWidthPx);
}

/**
 * Find the closest snap candidate (endpoint or edge-projection) within
 * the given radii. Returns null if nothing snaps. O(N) over segments;
 * fine for the segment counts we see in practice (<1000 cleaned
 * edges per page).
 */
export function snapToWalls(
  cursor: { x: number; y: number },
  segments: WallSegmentNorm[],
  opts: SnapOpts,
): SnapResult | null {
  let bestEndpoint: SnapResult | null = null;
  let bestEndpointDistSq = opts.endpointRadiusNorm * opts.endpointRadiusNorm;
  let bestEdge: SnapResult | null = null;
  let bestEdgePerpSq = opts.edgeRadiusNorm * opts.edgeRadiusNorm;

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    // Endpoint check 1.
    {
      const dx = s.x1 - cursor.x;
      const dy = s.y1 - cursor.y;
      const dSq = dx * dx + dy * dy;
      if (dSq < bestEndpointDistSq) {
        bestEndpointDistSq = dSq;
        bestEndpoint = {
          x: s.x1,
          y: s.y1,
          snap: "endpoint",
          segmentIndex: i,
        };
      }
    }
    // Endpoint check 2.
    {
      const dx = s.x2 - cursor.x;
      const dy = s.y2 - cursor.y;
      const dSq = dx * dx + dy * dy;
      if (dSq < bestEndpointDistSq) {
        bestEndpointDistSq = dSq;
        bestEndpoint = {
          x: s.x2,
          y: s.y2,
          snap: "endpoint",
          segmentIndex: i,
        };
      }
    }
    // Edge-projection check.
    const ax = s.x1;
    const ay = s.y1;
    const bx = s.x2 - s.x1;
    const by = s.y2 - s.y1;
    const lenSq = bx * bx + by * by;
    if (lenSq <= 1e-12) continue;
    const t = ((cursor.x - ax) * bx + (cursor.y - ay) * by) / lenSq;
    if (t <= 0 || t >= 1) continue; // outside segment interior — endpoint
                                    // handlers already cover the ends
    const projX = ax + bx * t;
    const projY = ay + by * t;
    const dx = projX - cursor.x;
    const dy = projY - cursor.y;
    const perpSq = dx * dx + dy * dy;
    if (perpSq < bestEdgePerpSq) {
      bestEdgePerpSq = perpSq;
      bestEdge = {
        x: projX,
        y: projY,
        snap: "edge",
        segmentIndex: i,
      };
    }
  }

  // Endpoint snap wins over edge snap so wall corners join cleanly
  // when the cursor is near a vertex.
  return bestEndpoint ?? bestEdge;
}

/**
 * Linear-foot length of a polyline whose vertices are in normalized
 * (0..1) page coords, given the page's PDF dimensions and ptPerFoot.
 * Exact arithmetic — no rounding until display.
 *
 * total length pt = Σ |vᵢ₊₁ - vᵢ| in pt
 * total length ft = total length pt / ptPerFoot
 */
export function polylineLengthFt(
  points: { x: number; y: number }[],
  pageWidthPt: number,
  pageHeightPt: number,
  ptPerFoot: number,
): number {
  if (points.length < 2 || ptPerFoot <= 0) return 0;
  let totalPt = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const dxPt = (points[i + 1].x - points[i].x) * pageWidthPt;
    const dyPt = (points[i + 1].y - points[i].y) * pageHeightPt;
    totalPt += Math.hypot(dxPt, dyPt);
  }
  return totalPt / ptPerFoot;
}
