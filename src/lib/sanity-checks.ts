import type { SurfaceDTO } from "@/types/surface";

/**
 * Industry-standard sanity checks pro estimators run before signing off
 * on a bid. None of these come from the AI — they're plain arithmetic
 * over the persisted surfaces.
 *
 * Source: PCA P10 standards + 1Build/ConstructConnect empirical
 * heuristics. Verified ranges across typical commercial bids.
 */

export type SanityFlagSeverity = "info" | "warning" | "error";

export interface SanityFlag {
  id: string;
  severity: SanityFlagSeverity;
  /** Plain-English message for the contractor. */
  message: string;
  /** Optional list of surface IDs the flag refers to. */
  surfaceIds?: string[];
}

export interface SanityReport {
  flags: SanityFlag[];
  /** Aggregate: total wall sqft / total ceiling sqft. */
  wallToCeilingRatio: number;
  /** Total floor area = sum of ceiling sqft (since ceilings ≈ floor). */
  totalFloorSqft: number;
  /** Total wall sqft across all surfaces. */
  totalWallSqft: number;
  /**
   * Total wall LINEAR feet (perimeter of all walls). Industry-standard
   * metric for trim contractors and door/window estimators.
   */
  totalWallLinearFt: number;
  /**
   * Net floor SF (interior usable area, walls excluded). For now
   * approximated as totalFloorSqft × 0.93 (typical 7% wall band).
   */
  totalNetFloorSqft: number;
  /**
   * Gross floor SF (building footprint with walls). Approximated as
   * totalFloorSqft + wall thickness band added back.
   */
  totalGrossFloorSqft: number;
}

/**
 * Run all checks against the project's accepted surfaces. Excluded
 * surfaces are ignored (they're not part of the bid).
 */
export function runSanityChecks(surfaces: SurfaceDTO[]): SanityReport {
  const flags: SanityFlag[] = [];
  const active = surfaces.filter((s) => s.status !== "excluded");
  const walls = active.filter((s) => s.type === "wall");
  const ceilings = active.filter((s) => s.type === "ceiling");
  const doors = active.filter((s) => s.type === "door");

  const totalWallSqft = walls.reduce(
    (a, w) => a + (w.squareFootage ?? 0),
    0,
  );
  const totalFloorSqft = ceilings.reduce(
    (a, c) => a + (c.squareFootage ?? 0),
    0,
  );
  const wallToCeilingRatio =
    totalFloorSqft > 0 ? totalWallSqft / totalFloorSqft : 0;

  // ── Check 1: wall:ceiling ratio ─────────────────────────────────────
  // Commercial walls are typically 2.0–3.5× the floor area. Below 1.5
  // suggests missing rooms; above 4 suggests double-counting.
  if (totalFloorSqft > 100) {
    if (wallToCeilingRatio < 1.5) {
      flags.push({
        id: "wall-to-floor-low",
        severity: "warning",
        message: `Wall area is only ${wallToCeilingRatio.toFixed(2)}× the floor area. For commercial spaces this ratio is usually 2.0–3.5. You may be missing walls — check for interior partitions or split rooms.`,
      });
    } else if (wallToCeilingRatio > 4) {
      flags.push({
        id: "wall-to-floor-high",
        severity: "warning",
        message: `Wall area is ${wallToCeilingRatio.toFixed(2)}× the floor area — higher than the typical 2.0–3.5. You may have double-counted shared walls or used floor area in place of wall area.`,
      });
    }
  }

  // ── Check 2: per-room wall plausibility ────────────────────────────
  // For each wall, area_sqft should be ~perimeter × ceiling height.
  // Treat 9 ft as the default; flag rooms more than 40% off.
  const ROOM_CEILING_FT = 9;
  const wildSurfaceIds: string[] = [];
  for (const w of walls) {
    const lf = w.linearFootage ?? 0;
    const sqft = w.squareFootage ?? 0;
    if (lf < 5 || sqft < 5) continue;
    const expected = lf * ROOM_CEILING_FT;
    const ratio = sqft / expected;
    if (ratio < 0.55 || ratio > 1.6) {
      wildSurfaceIds.push(w.id);
    }
  }
  if (wildSurfaceIds.length > 0) {
    flags.push({
      id: "per-room-wall-implausible",
      severity: "warning",
      message: `${wildSurfaceIds.length} wall${wildSurfaceIds.length === 1 ? " has" : "s have"} an area that doesn't match its perimeter × 9 ft. Review these rooms before submitting.`,
      surfaceIds: wildSurfaceIds,
    });
  }

  // ── Check 3: low-confidence surfaces in the bid ────────────────────
  const lowConfIds = active
    .filter((s) => (s.confidence ?? 0) < 0.6)
    .map((s) => s.id);
  if (lowConfIds.length > 0) {
    flags.push({
      id: "low-confidence-in-bid",
      severity: "info",
      message: `${lowConfIds.length} surface${lowConfIds.length === 1 ? "" : "s"} ${lowConfIds.length === 1 ? "has" : "have"} a confidence below 60%. We recommend manually reviewing ${lowConfIds.length === 1 ? "it" : "them"} before submitting the bid.`,
      surfaceIds: lowConfIds,
    });
  }

  // ── Check 4: missing ceilings ──────────────────────────────────────
  // Every interior room with a wall should usually have a ceiling.
  const roomsWithWalls = new Set(walls.map((w) => normalizeRoom(w.roomLabel)));
  const roomsWithCeilings = new Set(
    ceilings.map((c) => normalizeRoom(c.roomLabel)),
  );
  const missingCeilings = [...roomsWithWalls].filter(
    (r) => r && !roomsWithCeilings.has(r),
  );
  if (missingCeilings.length > 0 && roomsWithWalls.size >= 3) {
    flags.push({
      id: "rooms-missing-ceilings",
      severity: "info",
      message: `${missingCeilings.length} room${missingCeilings.length === 1 ? "" : "s"} ${missingCeilings.length === 1 ? "has" : "have"} walls but no ceiling assigned. If those ceilings are being painted, add them; otherwise this is fine.`,
    });
  }

  // ── Check 5: doors without rooms ───────────────────────────────────
  const doorRooms = new Set(doors.map((d) => normalizeRoom(d.roomLabel)));
  const orphanDoors = [...doorRooms].filter(
    (r) => r && !roomsWithWalls.has(r),
  );
  if (orphanDoors.length > 0) {
    flags.push({
      id: "orphan-doors",
      severity: "info",
      message: `${orphanDoors.length} door${orphanDoors.length === 1 ? " is" : "s are"} in a room with no walls in the bid. Check whether the room itself is excluded.`,
    });
  }

  const totalWallLinearFt = walls.reduce(
    (a, w) => a + (w.linearFootage ?? 0),
    0,
  );
  // Net = floor area minus a wall band approximation. For each room with
  // wall LF, deduct LF × 0.25 ft (half of a 6" wall, applied to interior
  // perimeter). Gross = floor + same band added back. These are
  // approximations until polygon-level computation is plumbed everywhere.
  const NET_DEDUCTION = totalWallLinearFt * 0.25;
  const totalNetFloorSqft = Math.max(0, totalFloorSqft - NET_DEDUCTION);
  const totalGrossFloorSqft = totalFloorSqft + NET_DEDUCTION;
  return {
    flags,
    wallToCeilingRatio,
    totalFloorSqft,
    totalWallSqft,
    totalWallLinearFt,
    totalNetFloorSqft,
    totalGrossFloorSqft,
  };
}

function normalizeRoom(label: string | null): string {
  if (!label) return "";
  return label.toLowerCase().replace(/\s+/g, " ").trim();
}
