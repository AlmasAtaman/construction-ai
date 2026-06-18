/**
 * Step B — bind finish signals (tags + notes) to rooms, by geometry only.
 *
 * Deterministic association (Round-3 research: point-in-polygon containment +
 * nearest-room fallback, no ML):
 *
 *   TAGS  → POINT-IN-POLYGON. The sheet draws the plan twice — a construction
 *           view (where we measured the seeded room polygons) and a finish-plan
 *           view ~605pt below it (where the finish tags live). The two views are
 *           a pure vertical translation, recovered from matching room-seed pairs
 *           (same label in both views). We translate each finish-view tag up by
 *           that offset and test which construction-view room polygon contains
 *           it. Containment respects walls, so a tile tag in a small washroom
 *           does NOT leak onto the neighbouring stockroom (nearest-seed did).
 *           A tag in no polygon falls back to nearest seed within a tight
 *           radius, else it is dropped (legend/detail key).
 *   NOTES → matched to rooms by ROOM CATEGORY ("ALL STOCKROOM WALLS → P-1"
 *           applies to the OVERSTOCK room: both are category `stockroom`).
 *
 * Output is keyed by normalized room label so Step C joins cleanly. CT (wall
 * tile) vs TB (tile base) is preserved on each tag — Step C treats them very
 * differently (a tile BASE does not take a wall out of paint scope).
 */

import type { RoomSeed } from "./room-seeds";
import type { SeededRoom } from "./seeded-rooms";
import type { FinishScope, FinishFamily, NoteScope } from "./finish-scope";

/** Fallback radius (pt) for a tag that lands in no room polygon. */
const FALLBACK_BIND_PT = 60;

export interface TagEvidence {
  code: string;
  family: FinishFamily;
  /** How it bound: polygon containment (strong) or nearest-seed (weak). */
  via: "contains" | "nearest";
  /** Distance (pt) to the room seed (for confidence / debugging). */
  dist: number;
}

export interface NoteEvidence {
  text: string;
  scope: NoteScope;
  families: FinishFamily[];
  via: "category";
}

export interface RoomFinishBinding {
  /** Normalized room label (join key to the seeded room). */
  label: string;
  category: string;
  tags: TagEvidence[];
  notes: NoteEvidence[];
}

/** Room-category synonyms. A note keyword and a room label that share a
 *  category are the same room kind. Tunable per market. */
const CATEGORY_WORDS: ReadonlyArray<[string, RegExp]> = [
  ["stockroom", /\b(STOCKROOM|STOCK|OVERSTOCK|STORAGE|RECEIVING|BOH|BACK\s?OF\s?HOUSE)\b/i],
  ["washroom", /\b(WASHROOM|RESTROOM|BATHROOM|WC|TOILET)\b/i],
  ["vestibule", /\b(VESTIBULE|ENTRANCE|FOYER|ENTRY)\b/i],
  ["sales", /\b(SALES|RETAIL|SHOWROOM)\b/i],
  ["service", /\b(SERVICE|COUNTER)\b/i],
  ["electrical", /\b(ELECTRICAL|ELEC)\b/i],
  ["mechanical", /\b(MECHANICAL|MECH)\b/i],
  ["office", /\b(OFFICE)\b/i],
  ["kitchen", /\b(KITCHEN|PANTRY)\b/i],
  ["corridor", /\b(CORRIDOR|HALLWAY|HALL)\b/i],
];

/** Map a room label or note word to its category (or "" if none). */
export function roomCategory(text: string): string {
  for (const [cat, re] of CATEGORY_WORDS) if (re.test(text)) return cat;
  return "";
}

function normLabel(label: string | null): string {
  return (label ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

/** Even-odd point-in-polygon (PDF-pt coords). */
function inPoly(poly: { x: number; y: number }[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Recover the vertical offset between the finish-plan view and the construction
 * view from room-seed pairs sharing a label. Returns the median dy (finish.y −
 * construction.y), or 0 if no pair is found (single-view sheet).
 */
function viewOffsetY(seeds: RoomSeed[]): number {
  const byLabel = new Map<string, number[]>();
  for (const s of seeds) {
    const k = normLabel(s.label);
    (byLabel.get(k) ?? byLabel.set(k, []).get(k)!).push(s.y);
  }
  const dys: number[] = [];
  for (const ys of byLabel.values()) {
    if (ys.length < 2) continue;
    ys.sort((a, b) => a - b);
    dys.push(ys[ys.length - 1] - ys[0]); // bottom view − top view
  }
  if (dys.length === 0) return 0;
  dys.sort((a, b) => a - b);
  return dys[Math.floor(dys.length / 2)];
}

/**
 * Bind finish tags + notes to the measured (seeded) rooms.
 *
 * @param rooms  seeded room polygons (construction view) — the measured rooms.
 * @param seeds  room-label seeds (BOTH views) — for the view offset + fallback.
 * @param finish output of extractFinishScope.
 */
export function bindFinishToRooms(
  rooms: SeededRoom[],
  seeds: RoomSeed[],
  finish: FinishScope,
): Map<string, RoomFinishBinding> {
  const byLabel = new Map<string, RoomFinishBinding>();
  const ensure = (label: string | null): RoomFinishBinding => {
    const key = normLabel(label);
    let b = byLabel.get(key);
    if (!b) {
      b = { label: key, category: roomCategory(key), tags: [], notes: [] };
      byLabel.set(key, b);
    }
    return b;
  };
  for (const r of rooms) ensure(r.label);

  const offset = viewOffsetY(seeds);

  // Construction-view seeds only (top view) for the nearest-seed fallback,
  // since room polygons live in that view.
  const topSeeds = (() => {
    // Each label's smaller-y seed is the construction-view one.
    const best = new Map<string, RoomSeed>();
    for (const s of seeds) {
      const k = normLabel(s.label);
      const cur = best.get(k);
      if (!cur || s.y < cur.y) best.set(k, s);
    }
    return [...best.values()];
  })();

  // --- TAGS → point-in-polygon (translated), else nearest seed ---
  for (const tag of finish.tags) {
    // Translate a finish-view tag up into the construction view. A tag already
    // in the top view (y small) translates to a negative offset region and
    // simply won't be contained — handled by trying both raw and shifted.
    const candidates =
      offset > 0
        ? [
            { x: tag.x, y: tag.y - offset }, // finish-view tag → construction view
            { x: tag.x, y: tag.y }, // already a construction-view tag
          ]
        : [{ x: tag.x, y: tag.y }];

    let bound: { label: string | null; via: "contains"; dist: number } | null =
      null;
    for (const c of candidates) {
      const room = rooms.find(
        (r) => r.polygonPt.length >= 3 && inPoly(r.polygonPt, c.x, c.y),
      );
      if (room) {
        const seed = topSeeds.find((s) => normLabel(s.label) === normLabel(room.label));
        bound = {
          label: room.label,
          via: "contains",
          dist: seed ? Math.round(Math.hypot(seed.x - c.x, seed.y - c.y)) : 0,
        };
        break;
      }
    }

    if (bound) {
      ensure(bound.label).tags.push({
        code: tag.code,
        family: tag.family,
        via: "contains",
        dist: bound.dist,
      });
      continue;
    }

    // Fallback: nearest construction-view seed within a tight radius, using the
    // translated tag position.
    const tx = tag.x;
    const ty = offset > 0 ? tag.y - offset : tag.y;
    let bestSeed: RoomSeed | null = null;
    let bestD = Infinity;
    for (const s of topSeeds) {
      const d = Math.hypot(s.x - tx, s.y - ty);
      if (d < bestD) {
        bestD = d;
        bestSeed = s;
      }
    }
    if (bestSeed && bestD <= FALLBACK_BIND_PT) {
      ensure(bestSeed.label).tags.push({
        code: tag.code,
        family: tag.family,
        via: "nearest",
        dist: Math.round(bestD),
      });
    }
    // else: dropped — legend/detail key, not a placed room tag.
  }

  // --- NOTES → rooms sharing the note's room category ---
  for (const note of finish.notes) {
    if (note.roomKeywords.length === 0) continue;
    const noteCats = new Set(
      note.roomKeywords.map((k) => roomCategory(k)).filter(Boolean),
    );
    if (noteCats.size === 0) continue;
    for (const b of byLabel.values()) {
      if (b.category && noteCats.has(b.category)) {
        b.notes.push({
          text: note.text,
          scope: note.scope,
          families: note.families,
          via: "category",
        });
      }
    }
  }

  return byLabel;
}
