/**
 * Step C — paint-scope decision rules + confidence.
 *
 * Turns the per-room finish binding (Step B) into a per-room paint/excluded
 * decision, following the Round-3 deterministic-first hybrid: rule-based
 * decision from the strongest signal, with a confidence score and a
 * `needsReview` flag that gates the optional AI fallback (Step D).
 *
 * Signal priority (strongest first):
 *   1. AUTHORITATIVE NOTE — an architect's scope note grounded to the room
 *      ("ALL STOCKROOM WALLS TO RECEIVE PAINT FINISH P-1" → paint; an FRP/tile
 *      note → excluded). Highest confidence.
 *   2. ROOM CATEGORY DEFAULT — retail/back-of-house spaces are painted; wet
 *      rooms / vestibules / service chases are not. This alone reproduces the
 *      contractor's scope on the reference plan.
 *   3. TAG EVIDENCE — confirms the decision and, on conflict (a paint room
 *      carrying dense CT *wall* tile, or an excluded room carrying paint tags),
 *      lowers confidence and sets needsReview. Tile BASE (TB) is ignored: a
 *      painted wall commonly has a tile base.
 */

import type { RoomFinishBinding } from "./bind-finish";
import { PAINT_FAMILIES, type FinishFamily } from "./finish-scope";

export type ScopeDecision = "paint" | "excluded";

/** Categories whose walls are painted by default (retail + back-of-house). */
const PAINT_CATEGORIES = new Set([
  "stockroom",
  "sales",
  "service",
  "office",
  "corridor",
]);
/** Categories excluded from paint by default (tile/FRP/unfinished/wet). */
const EXCLUDED_CATEGORIES = new Set([
  "washroom",
  "vestibule",
  "electrical",
  "mechanical",
  "kitchen",
]);

/** CT (wall tile) tags above this count in a paint-default room flag a
 *  conflict worth an AI second look. Tile BASE never counts. */
const WALL_TILE_CONFLICT = 2;

/** What the decision rests on, strongest first. The AI fallback (Step D) may
 *  only OVERRIDE `tag`/`default` rooms; `note`/`category` rooms are stronger
 *  than the model's read of feature-wall finish crops, so the AI is advisory
 *  there. */
export type ScopeBasis = "note" | "category" | "tag" | "default";

export interface RoomScope {
  label: string;
  category: string;
  decision: ScopeDecision;
  /** 0..1 — how sure the deterministic rules are. */
  confidence: number;
  /** What drove the decision (gates whether the AI may override). */
  basis: ScopeBasis;
  /** Human-readable basis for the decision. */
  reason: string;
  /** True when signals conflict or the room is unknown → send to AI fallback. */
  needsReview: boolean;
}

function wallTileCount(b: RoomFinishBinding): number {
  return b.tags.filter((t) => t.family === "wall-tile").length;
}
function paintTagCount(b: RoomFinishBinding): number {
  return b.tags.filter((t) => PAINT_FAMILIES.has(t.family)).length;
}

/**
 * Decide paint scope for every bound room.
 */
export function decidePaintScope(
  binding: Map<string, RoomFinishBinding>,
): RoomScope[] {
  const out: RoomScope[] = [];

  for (const b of binding.values()) {
    const ct = wallTileCount(b);
    const paintTags = paintTagCount(b);

    // 1) Authoritative note.
    const paintNote = b.notes.find((n) => n.scope === "paint");
    const excludeNote = b.notes.find(
      (n) => n.scope === "frp" || n.scope === "tile",
    );

    let decision: ScopeDecision;
    let confidence: number;
    let reason: string;
    let basis: ScopeBasis;
    let needsReview = false;

    if (paintNote) {
      decision = "paint";
      confidence = 0.95;
      basis = "note";
      reason = `plan note: "${paintNote.text.slice(0, 60)}"`;
      // A paint note plus heavy wall tile is a genuine conflict worth flagging,
      // but the note still wins (basis stays `note` → AI stays advisory).
      if (ct >= WALL_TILE_CONFLICT) {
        confidence = 0.7;
        needsReview = true;
        reason += ` (but ${ct} wall-tile tags present)`;
      }
    } else if (excludeNote) {
      decision = "excluded";
      confidence = 0.95;
      basis = "note";
      reason = `plan note: "${excludeNote.text.slice(0, 60)}"`;
    } else if (PAINT_CATEGORIES.has(b.category)) {
      decision = "paint";
      confidence = 0.8;
      basis = "category";
      reason = `room type "${b.category}" is painted by default`;
      if (ct >= WALL_TILE_CONFLICT) {
        confidence = 0.6;
        needsReview = true;
        reason += ` — but ${ct} wall-tile tags present (often a feature wall); flagged`;
      }
    } else if (EXCLUDED_CATEGORIES.has(b.category)) {
      decision = "excluded";
      confidence = 0.8;
      basis = "category";
      reason = `room type "${b.category}" is not painted by default`;
      if (paintTags >= WALL_TILE_CONFLICT) {
        confidence = 0.6;
        needsReview = true;
        reason += ` — but ${paintTags} paint tags present; flagged`;
      }
    } else {
      // Unknown room type — genuinely weak; let tags break the tie, else flag.
      // These are the only rooms the AI fallback may OVERRIDE.
      basis = ct > 0 || paintTags > 0 ? "tag" : "default";
      if (paintTags > ct && paintTags > 0) {
        decision = "paint";
        confidence = 0.45;
        reason = `unknown room type; ${paintTags} paint tags`;
      } else if (ct > 0) {
        decision = "excluded";
        confidence = 0.45;
        reason = `unknown room type; ${ct} wall-tile tags`;
      } else {
        decision = "paint"; // conservative: over-include, user/AI trims
        confidence = 0.3;
        reason = `unknown room type, no finish signal — defaulting to paint`;
      }
      needsReview = true;
    }

    out.push({
      label: b.label,
      category: b.category,
      decision,
      confidence,
      basis,
      reason,
      needsReview,
    });
  }

  return out;
}
