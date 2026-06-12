/**
 * CAD layer-name classification.
 *
 * Layer names follow loose conventions (AIA/NCS "FP-N-WALL", vendor styles
 * like "Wall Standard", xref-prefixed "2103118_Base|FP-N-DIMS"). Pure
 * regex covers the conventions we've observed; anything unmatched is
 * "other". Walls additionally carry a phase (new / existing / demo) parsed
 * from the NCS status field or keywords — demo walls are excluded from
 * paint takeoffs by default.
 */

export type LayerRole =
  | "wall-new"
  | "wall-existing"
  | "wall-demo"
  | "dimension"
  | "hatch"
  | "annotation"
  | "room-label"
  | "other";

export interface ClassifiedLayer {
  name: string;
  role: LayerRole;
}

export const WALL_ROLES: ReadonlySet<LayerRole> = new Set([
  "wall-new",
  "wall-existing",
  "wall-demo",
]);

/** Strip the AutoCAD xref prefix: "2103118_Base|FP-N-WALL" → "FP-N-WALL". */
export function baseLayerName(name: string): string {
  const idx = name.lastIndexOf("|");
  return idx >= 0 ? name.slice(idx + 1) : name;
}

/**
 * NCS-style phase/status field: the single letter between hyphens in
 * "FP-N-WALL" / "BB-E-WALL" / "FP-D-WALL" (N = new, E = existing,
 * D = demolition).
 */
function ncsPhase(base: string): "N" | "E" | "D" | null {
  const m = base.toUpperCase().match(/(?:^|-)([NED])-/);
  return (m?.[1] as "N" | "E" | "D" | undefined) ?? null;
}

export function classifyLayerName(name: string): LayerRole {
  const base = baseLayerName(name).toUpperCase();

  if (/H?WALL/.test(base)) {
    const phase = ncsPhase(base);
    if (phase === "D" || /DEMO/.test(base)) return "wall-demo";
    if (phase === "E" || /EXIST/.test(base)) return "wall-existing";
    return "wall-new";
  }
  if (/DIM/.test(base)) return "dimension";
  if (/HATC|PATT/.test(base)) return "hatch";
  if (/RMNM|ROOM/.test(base)) return "room-label";
  if (/TEXT|NOTE|ANNO|TITLE|TBL?K|SYMB|TABLE|NORTH|^REV$/.test(base)) {
    return "annotation";
  }
  return "other";
}

export function classifyLayers(names: string[]): ClassifiedLayer[] {
  return names.map((name) => ({ name, role: classifyLayerName(name) }));
}

/** Wall layers usable for a paint takeoff (demo excluded by default). */
export function defaultWallLayers(names: string[]): string[] {
  return classifyLayers(names)
    .filter((l) => l.role === "wall-new" || l.role === "wall-existing")
    .map((l) => l.name);
}
