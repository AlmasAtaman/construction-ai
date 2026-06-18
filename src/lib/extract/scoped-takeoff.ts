/**
 * Step E — scoped per-room paint takeoff.
 *
 * Ties the whole deterministic-first pipeline together and produces the
 * contractor-style deliverable: each PAINTED room measured (wall perimeter ×
 * ceiling height), the non-painted rooms tracked-but-excluded, and a paint
 * total to check against the real takeoff.
 *
 *   layer walls → room seeds → seeded rooms (measured) →
 *   finish scope (A) → bind (B) → decide (C) → [optional AI advisory (D)]
 *
 * Because the scope decision EXCLUDES exactly the wet/utility rooms whose seeded
 * polygons trace poorly (washroom/vestibule/electrical), the paint total only
 * sums the well-traced rooms — the scope and the geometry reinforce each other.
 */

import { scanSegmentsByLayer } from "./layer-scan";
import { classifyLayers, WALL_ROLES } from "./layer-classify";
import { extractRoomSeeds } from "./room-seeds";
import { segmentRoomsBySeeds, type SeededRoom } from "./seeded-rooms";
import { extractFinishScope } from "./finish-scope";
import { bindFinishToRooms } from "./bind-finish";
import { decidePaintScope, type RoomScope, type ScopeDecision } from "./paint-scope";

/** Default paint wall height (ft). Friend's reference: 840 ÷ 93.3 lf = 9.00. */
export const DEFAULT_WALL_HEIGHT_FT = 9;

export interface ScopedRoom {
  label: string;
  decision: ScopeDecision;
  basis: RoomScope["basis"];
  confidence: number;
  needsReview: boolean;
  reason: string;
  /** Paintable wall perimeter (ft) from the seeded room (excludes opening cuts). */
  wallPerimeterFt: number;
  heightFt: number;
  /** Painted wall area (sqft) = perimeter × height. 0 for excluded rooms. */
  paintAreaSqft: number;
  /** Room floor area (sqft), for reference. */
  floorAreaSqft: number;
}

export interface ScopedTakeoff {
  paintRooms: ScopedRoom[];
  excludedRooms: ScopedRoom[];
  /** Sum of painted wall perimeter (lf) and area (sqft). */
  paintLf: number;
  paintSqft: number;
  heightFt: number;
}

export interface ScopedTakeoffOptions {
  ptPerFoot?: number;
  pageWidthPt: number;
  pageHeightPt: number;
  heightFt?: number;
  /** Run the Claude-vision advisory pass on flagged rooms. Off by default —
   *  deterministic alone reproduces the reference scope. */
  useAi?: boolean;
}

function normLabel(l: string | null): string {
  return (l ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

/**
 * Compute the scoped paint takeoff for one page. Returns null if the page lacks
 * the inputs (wall layers + ≥2 room seeds) for seeded segmentation.
 */
export async function computeScopedPaintTakeoff(
  pdfBuffer: Buffer,
  pageNumber: number,
  opts: ScopedTakeoffOptions,
): Promise<ScopedTakeoff | null> {
  const ptPerFoot = opts.ptPerFoot ?? 18;
  const heightFt = opts.heightFt ?? DEFAULT_WALL_HEIGHT_FT;

  // Walls from the correct CAD layers (non-diagonal).
  const layerScan = await scanSegmentsByLayer(pdfBuffer, pageNumber);
  if (layerScan.layerNames.length === 0) return null;
  const roles = Object.fromEntries(
    classifyLayers(Object.keys(layerScan.segmentsPerLayer)).map((c) => [
      c.name,
      c.role,
    ]),
  );
  const walls = layerScan.segments
    .filter((s) => s.layer && WALL_ROLES.has(roles[s.layer]) && !s.diagonal)
    .map((s) => ({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 }));
  if (walls.length === 0) return null;

  const seeds = await extractRoomSeeds(pdfBuffer, pageNumber);
  if (seeds.length < 2) return null;

  const seg = segmentRoomsBySeeds(walls, seeds, {
    ptPerFoot,
    pageWidthPt: opts.pageWidthPt,
    pageHeightPt: opts.pageHeightPt,
  });
  if (!seg || seg.rooms.length < 2) return null;

  const finish = await extractFinishScope(pdfBuffer, pageNumber);
  const binding = bindFinishToRooms(seg.rooms, seeds, finish);
  let scopes = decidePaintScope(binding);

  if (opts.useAi && scopes.some((s) => s.needsReview)) {
    const { resolveLowConfidence } = await import("@/lib/ai/verify-finish");
    const res = await resolveLowConfidence(
      scopes,
      seg.rooms,
      seeds,
      pdfBuffer,
      pageNumber,
    );
    scopes = res.scopes;
  }

  // Join scope decisions to the measured (seeded) rooms by label.
  const roomByLabel = new Map<string, SeededRoom>(
    seg.rooms.map((r) => [normLabel(r.label), r]),
  );
  const scoped: ScopedRoom[] = scopes.map((sc) => {
    const room = roomByLabel.get(sc.label);
    const perim = room?.wallPerimeterFt ?? 0;
    const floor = room?.areaSqft ?? 0;
    const isPaint = sc.decision === "paint";
    return {
      label: sc.label,
      decision: sc.decision,
      basis: sc.basis,
      confidence: sc.confidence,
      needsReview: sc.needsReview,
      reason: sc.reason,
      wallPerimeterFt: perim,
      heightFt,
      paintAreaSqft: isPaint ? perim * heightFt : 0,
      floorAreaSqft: floor,
    };
  });

  const paintRooms = scoped.filter((r) => r.decision === "paint");
  const excludedRooms = scoped.filter((r) => r.decision === "excluded");
  const paintLf = paintRooms.reduce((a, r) => a + r.wallPerimeterFt, 0);
  const paintSqft = paintRooms.reduce((a, r) => a + r.paintAreaSqft, 0);

  return { paintRooms, excludedRooms, paintLf, paintSqft, heightFt };
}
