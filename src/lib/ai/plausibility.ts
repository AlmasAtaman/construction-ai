import type { TakeoffToolResult } from "./takeoff-prompt";

/**
 * Deterministic plausibility checks. No AI, no cost. Catches the obvious
 * math errors:
 *   - wall area must be ~perimeter × ceiling height. If it's 3x that,
 *     someone reported floor area as wall area.
 *   - ceiling area must roughly equal an enclosed rectangle of side
 *     perimeter/4. If it's 2x bigger, someone is double-counting.
 *   - super-small rooms (5×5 powder room) with 200+ sqft of walls are a
 *     clear sign the AI confused floor area for wall area.
 *
 * Returned `flags` are attached to surfaces as low-confidence warnings.
 */

export interface PlausibilityFlag {
  kind: "wall_area_vs_perimeter" | "ceiling_oversize" | "tiny_room_huge_walls";
  room_label: string;
  surface_kind: "wall" | "ceiling";
  measured: number;
  expected_min: number;
  expected_max: number;
  note: string;
}

const ASSUMED_CEILING_FT = 9;

export function plausibilityCheck(
  result: TakeoffToolResult,
): { flags: PlausibilityFlag[]; corrected: TakeoffToolResult } {
  const flags: PlausibilityFlag[] = [];
  const corrected: TakeoffToolResult = {
    ...result,
    walls: result.walls.map((w) => ({ ...w })),
    ceilings: result.ceilings.map((c) => ({ ...c })),
    trim: result.trim.map((t) => ({ ...t })),
    doors: result.doors.map((d) => ({ ...d })),
    windows: result.windows.map((w) => ({ ...w })),
    warnings: [...(result.warnings ?? [])],
  };

  const ceilingHeight =
    result.scale_anchor?.ceiling_height_ft ?? ASSUMED_CEILING_FT;

  for (let i = 0; i < corrected.walls.length; i++) {
    const w = corrected.walls[i];
    const lf = w.linear_ft;
    const sqft = w.area_sqft;
    if (lf <= 0) continue;

    // Wall area should be perimeter × ceiling-height, give or take 20% for
    // openings and odd geometry.
    const expectMin = lf * ceilingHeight * 0.7;
    const expectMax = lf * ceilingHeight * 1.15;
    if (sqft < expectMin || sqft > expectMax) {
      flags.push({
        kind: "wall_area_vs_perimeter",
        room_label: w.room_label,
        surface_kind: "wall",
        measured: sqft,
        expected_min: expectMin,
        expected_max: expectMax,
        note: `Wall area ${Math.round(sqft)} sqft is outside the plausible range ${Math.round(expectMin)}-${Math.round(expectMax)} sqft for a ${Math.round(lf)} ft perimeter room with a ${ceilingHeight} ft ceiling.`,
      });
      // Auto-correct using perimeter × ceiling (95% of which is paintable
      // after openings).
      corrected.walls[i] = {
        ...w,
        area_sqft: lf * ceilingHeight * 0.93,
        confidence: Math.min(w.confidence, 0.55),
      };
    }

    // Tiny room with huge walls — the most common failure mode we
    // observed: a 5'×5' bathroom returning 270 sqft of walls instead of
    // 180 sqft.
    if (lf < 30 && sqft > 250) {
      flags.push({
        kind: "tiny_room_huge_walls",
        room_label: w.room_label,
        surface_kind: "wall",
        measured: sqft,
        expected_min: lf * ceilingHeight * 0.7,
        expected_max: lf * ceilingHeight,
        note: `Small room (${Math.round(lf)} ft perimeter) but ${Math.round(sqft)} sqft of walls — likely confused with floor area.`,
      });
    }
  }

  // Ceiling area should match floor area; we don't have perimeter directly
  // for ceiling entries, so cross-reference against same-room walls.
  for (let i = 0; i < corrected.ceilings.length; i++) {
    const c = corrected.ceilings[i];
    const matchingWall = corrected.walls.find(
      (w) =>
        w.room_label.toLowerCase().trim() ===
        c.room_label.toLowerCase().trim(),
    );
    if (!matchingWall) continue;
    const lf = matchingWall.linear_ft;
    if (lf <= 0) continue;

    // Maximum floor area for a given perimeter is the square (lf/4)^2;
    // typical rooms are between half and full of that.
    const expectMax = (lf / 4) * (lf / 4) * 1.2;
    if (c.area_sqft > expectMax) {
      flags.push({
        kind: "ceiling_oversize",
        room_label: c.room_label,
        surface_kind: "ceiling",
        measured: c.area_sqft,
        expected_min: (lf / 4) * (lf / 4) * 0.4,
        expected_max: expectMax,
        note: `Ceiling area ${Math.round(c.area_sqft)} sqft is larger than geometrically possible for a ${Math.round(lf)} ft perimeter room (max ~${Math.round(expectMax)} sqft).`,
      });
      // Auto-correct to the geometric maximum (slightly conservative).
      const better = (lf / 4) * (lf / 4) * 0.9;
      corrected.ceilings[i] = {
        ...c,
        area_sqft: better,
        confidence: Math.min(c.confidence, 0.5),
      };
    }
  }

  for (const f of flags) {
    corrected.warnings.push(`[plausibility] ${f.room_label}: ${f.note}`);
  }

  return { flags, corrected };
}
