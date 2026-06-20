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

/** Paint wall height to a finished ceiling (ft). Friend's Sales/Service:
 *  1,540.9 sqft ÷ 171 lf = 9.0 ft. */
export const CEILING_HEIGHT_FT = 9;
/** Paint wall height for walls painted "to underside of deck" / "to 13'-0
 *  A.F.F." — the plan's stockroom finish notes. Approximate (the exact deck
 *  height needs the wall-section/elevation); friend's Overstock reconciles at
 *  840 ÷ 73 lf ≈ 11.5 ft, consistent with a to-deck retail stockroom. Rooms
 *  using it are flagged so the height stays user-confirmable. */
export const DECK_HEIGHT_FT = 11.5;
/** Back-compat alias. */
export const DEFAULT_WALL_HEIGHT_FT = CEILING_HEIGHT_FT;

/** Room categories whose walls are painted to deck (taller than a ceiling).
 *  Stockroom/BOH walls run "to U/S of deck" per the finish notes. */
const TO_DECK_CATEGORIES = new Set(["stockroom"]);

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
  /** Where the height came from: a finished ceiling, or painted to deck. */
  heightBasis: "ceiling" | "to-deck";
  /** Painted wall area (sqft) = perimeter × height. 0 for excluded rooms. */
  paintAreaSqft: number;
  /** Room floor area (sqft), for reference. */
  floorAreaSqft: number;
  /** Boundary polygon, PDF pt (y-down) — for the overlay fill. */
  polygonPt: { x: number; y: number }[];
}

export interface ScopedTakeoff {
  paintRooms: ScopedRoom[];
  excludedRooms: ScopedRoom[];
  /** Sum of painted wall perimeter (lf) and area (sqft). */
  paintLf: number;
  paintSqft: number;
  /** Finished-ceiling height used for ceiling-height rooms (ft). */
  ceilingHeightFt: number;
}

export interface ScopedTakeoffOptions {
  ptPerFoot?: number;
  pageWidthPt: number;
  pageHeightPt: number;
  /** Finished-ceiling paint height (ft). Defaults to CEILING_HEIGHT_FT. */
  heightFt?: number;
  /** To-deck paint height (ft). Defaults to DECK_HEIGHT_FT. */
  deckHeightFt?: number;
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
  const ceilingFt = opts.heightFt ?? CEILING_HEIGHT_FT;
  const deckFt = opts.deckHeightFt ?? DECK_HEIGHT_FT;

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
    const toDeck = TO_DECK_CATEGORIES.has(sc.category);
    const heightFt = toDeck ? deckFt : ceilingFt;
    return {
      label: sc.label,
      decision: sc.decision,
      basis: sc.basis,
      confidence: sc.confidence,
      // To-deck height is approximate (needs the elevation) → keep it
      // user-confirmable even when the scope decision is certain.
      needsReview: sc.needsReview || (isPaint && toDeck),
      reason: toDeck
        ? `${sc.reason}; painted to deck (~${heightFt}ft, confirm vs elevation)`
        : sc.reason,
      wallPerimeterFt: perim,
      heightFt,
      heightBasis: toDeck ? "to-deck" : "ceiling",
      paintAreaSqft: isPaint ? perim * heightFt : 0,
      floorAreaSqft: floor,
      polygonPt: room?.polygonPt ?? [],
    };
  });

  const paintRooms = scoped.filter((r) => r.decision === "paint");
  const excludedRooms = scoped.filter((r) => r.decision === "excluded");
  const paintLf = paintRooms.reduce((a, r) => a + r.wallPerimeterFt, 0);
  const paintSqft = paintRooms.reduce((a, r) => a + r.paintAreaSqft, 0);

  return {
    paintRooms,
    excludedRooms,
    paintLf,
    paintSqft,
    ceilingHeightFt: ceilingFt,
  };
}
