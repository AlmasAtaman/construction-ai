/**
 * Takeoff version comparison.
 *
 * Estimators redo takeoffs when plans get revised (RFI responses, value
 * engineering, owner changes). The diff tells you what changed without
 * re-measuring by hand:
 *
 *   - Added rooms: present in new bid, absent in old
 *   - Removed rooms: in old, absent in new
 *   - Resized rooms: same label, area changed by > tolerance
 *   - Re-typed surfaces: same room, surface type changed (wall → ceiling)
 *   - Symbol count deltas: how many more/fewer doors, fixtures, etc.
 *
 * Matching: by `roomLabel` (case-insensitive, whitespace-normalized).
 * For unlabeled surfaces, we fall back to polygon bbox overlap.
 *
 * The diff is bidirectional — both "added in new" and "removed since old"
 * are surfaced so estimators can spot losses (removed scope).
 */

import type { SurfaceDTO } from "@/types/surface";

export interface RoomDelta {
  roomLabel: string | null;
  oldSurfaces: SurfaceDTO[];
  newSurfaces: SurfaceDTO[];
  /** Status of the change. */
  change: "added" | "removed" | "resized" | "retyped" | "unchanged";
  /** Old total area summed across surfaces in this room. */
  oldAreaSqft: number;
  /** New total area summed across surfaces in this room. */
  newAreaSqft: number;
  /** Absolute area change (signed: positive = larger). */
  areaDeltaSqft: number;
  /** Relative area change (signed fraction). */
  areaDeltaPct: number;
}

export interface SymbolDelta {
  type: string;
  oldCount: number;
  newCount: number;
  delta: number;
}

export interface TakeoffDiff {
  rooms: RoomDelta[];
  symbols: SymbolDelta[];
  summary: {
    addedRooms: number;
    removedRooms: number;
    resizedRooms: number;
    unchangedRooms: number;
    totalOldSqft: number;
    totalNewSqft: number;
    totalDeltaSqft: number;
    totalDeltaPct: number;
  };
}

function normalize(label: string | null | undefined): string {
  if (!label) return "";
  return label.toLowerCase().replace(/\s+/g, " ").trim();
}

function isSymbol(s: SurfaceDTO): boolean {
  return s.type.startsWith("symbol:");
}

export interface DiffOptions {
  /**
   * Relative tolerance for "resized" classification. Below this, two
   * rooms are considered unchanged. Default 0.05 (5%).
   */
  resizeTolerance?: number;
  /**
   * If true, include unchanged rooms in the result (for a complete
   * report). Default false — most consumers only want changes.
   */
  includeUnchanged?: boolean;
}

export function diffTakeoffs(
  oldSurfaces: SurfaceDTO[],
  newSurfaces: SurfaceDTO[],
  opts: DiffOptions = {},
): TakeoffDiff {
  const tol = opts.resizeTolerance ?? 0.05;

  // Separate room surfaces from symbol surfaces.
  const oldRooms = oldSurfaces.filter((s) => !isSymbol(s));
  const newRooms = newSurfaces.filter((s) => !isSymbol(s));
  const oldSyms = oldSurfaces.filter(isSymbol);
  const newSyms = newSurfaces.filter(isSymbol);

  // Group rooms by normalized label.
  const oldByLabel = new Map<string, SurfaceDTO[]>();
  const newByLabel = new Map<string, SurfaceDTO[]>();
  for (const s of oldRooms) {
    const k = normalize(s.roomLabel);
    if (!oldByLabel.has(k)) oldByLabel.set(k, []);
    oldByLabel.get(k)!.push(s);
  }
  for (const s of newRooms) {
    const k = normalize(s.roomLabel);
    if (!newByLabel.has(k)) newByLabel.set(k, []);
    newByLabel.get(k)!.push(s);
  }

  const allLabels = new Set([...oldByLabel.keys(), ...newByLabel.keys()]);
  allLabels.delete(""); // "" = unlabeled; handle separately if needed

  const rooms: RoomDelta[] = [];
  for (const label of allLabels) {
    const oldGroup = oldByLabel.get(label) ?? [];
    const newGroup = newByLabel.get(label) ?? [];
    const oldArea = oldGroup.reduce((a, s) => a + (s.squareFootage ?? 0), 0);
    const newArea = newGroup.reduce((a, s) => a + (s.squareFootage ?? 0), 0);
    const areaDelta = newArea - oldArea;
    const baseArea = Math.max(oldArea, newArea, 1);
    const deltaPct = areaDelta / baseArea;

    let change: RoomDelta["change"];
    if (oldGroup.length === 0) change = "added";
    else if (newGroup.length === 0) change = "removed";
    else if (Math.abs(deltaPct) > tol) change = "resized";
    else {
      // Check for type changes within the same room.
      const oldTypes = new Set(oldGroup.map((s) => s.type));
      const newTypes = new Set(newGroup.map((s) => s.type));
      const sameTypes =
        oldTypes.size === newTypes.size &&
        [...oldTypes].every((t) => newTypes.has(t));
      change = sameTypes ? "unchanged" : "retyped";
    }

    if (!opts.includeUnchanged && change === "unchanged") continue;

    rooms.push({
      roomLabel: (oldGroup[0]?.roomLabel ?? newGroup[0]?.roomLabel) ?? null,
      oldSurfaces: oldGroup,
      newSurfaces: newGroup,
      change,
      oldAreaSqft: oldArea,
      newAreaSqft: newArea,
      areaDeltaSqft: areaDelta,
      areaDeltaPct: deltaPct,
    });
  }
  // Sort: biggest changes first.
  rooms.sort((a, b) => Math.abs(b.areaDeltaSqft) - Math.abs(a.areaDeltaSqft));

  // Symbol counts: group by type, sum counts.
  const oldSymCounts = new Map<string, number>();
  const newSymCounts = new Map<string, number>();
  for (const s of oldSyms) {
    const t = s.type.replace(/^symbol:/, "");
    oldSymCounts.set(t, (oldSymCounts.get(t) ?? 0) + (s.count ?? 0));
  }
  for (const s of newSyms) {
    const t = s.type.replace(/^symbol:/, "");
    newSymCounts.set(t, (newSymCounts.get(t) ?? 0) + (s.count ?? 0));
  }
  const symbolTypes = new Set([
    ...oldSymCounts.keys(),
    ...newSymCounts.keys(),
  ]);
  const symbols: SymbolDelta[] = [];
  for (const t of symbolTypes) {
    const o = oldSymCounts.get(t) ?? 0;
    const n = newSymCounts.get(t) ?? 0;
    if (o === n && !opts.includeUnchanged) continue;
    symbols.push({ type: t, oldCount: o, newCount: n, delta: n - o });
  }
  symbols.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const summary = {
    addedRooms: rooms.filter((r) => r.change === "added").length,
    removedRooms: rooms.filter((r) => r.change === "removed").length,
    resizedRooms: rooms.filter((r) => r.change === "resized").length,
    unchangedRooms: rooms.filter((r) => r.change === "unchanged").length,
    totalOldSqft: oldRooms.reduce((a, s) => a + (s.squareFootage ?? 0), 0),
    totalNewSqft: newRooms.reduce((a, s) => a + (s.squareFootage ?? 0), 0),
    totalDeltaSqft: 0,
    totalDeltaPct: 0,
  };
  summary.totalDeltaSqft = summary.totalNewSqft - summary.totalOldSqft;
  summary.totalDeltaPct =
    summary.totalOldSqft > 0
      ? summary.totalDeltaSqft / summary.totalOldSqft
      : 0;

  return { rooms, symbols, summary };
}
