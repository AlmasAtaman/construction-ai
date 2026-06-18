/**
 * Step A — deterministic finish-scope signal extraction.
 *
 * Reads the finish information the architect put on the sheet, with NO OCR and
 * NO ML, straight from the PDF's embedded vector text (mupdf structured text).
 * Two signal types, both with coordinates so Step B can bind them to rooms:
 *
 *   1. NOTES  — scope sentences ("ALL STOCKROOM WALLS TO RECEIVE PAINT FINISH
 *      P-1", "...FULL HEIGHT FRP PANEL FRP-1", "STARTING POINT OF CT-1"). These
 *      are the strongest, least ambiguous scope signal.
 *   2. TAGS   — standalone finish-code bubbles (P-5, CT-1, …) placed in rooms.
 *      Legend lists ("P1 P2 P3 P4 P5" stacked in the key) and part numbers
 *      (P800) are filtered out so only PLACED tags remain.
 *
 * Finish-code families and the paint-vs-not rule are decoded per the plan's
 * legend (P = paint, CT = ceramic WALL tile, FRP = panel, ACT = acoustic
 * CEILING tile, VCT/QT = floor, TB/TS = tile base/trim, WD/SL = wood). The
 * family table is tunable because code prefixes vary by firm (Round-3 research:
 * VA/DoD dictionaries are firm-specific).
 */

export type FinishFamily =
  | "paint"
  | "wall-tile"
  | "frp"
  | "ceiling-tile"
  | "floor"
  | "wood"
  | "tile-base"
  | "tile-trim"
  | "other";

/** Whether a finish family is paint wall-scope (the only thing that bills as
 *  paint). Everything else is tracked-not-billed or out of paint scope. */
export const PAINT_FAMILIES: ReadonlySet<FinishFamily> = new Set(["paint"]);

/** Code-prefix → family. Longest prefixes first so "ACT" wins over "A". */
const FAMILY_BY_PREFIX: ReadonlyArray<[RegExp, FinishFamily]> = [
  [/^ACT$/i, "ceiling-tile"], // acoustic ceiling tile — NOT a wall finish
  [/^FRP$/i, "frp"],
  [/^VCT$/i, "floor"], // vinyl composition tile — floor
  [/^QT$/i, "floor"], // quarry tile — floor
  [/^CT$/i, "wall-tile"], // ceramic wall tile
  [/^TB$/i, "tile-base"],
  [/^TS$/i, "tile-trim"],
  [/^WD$/i, "wood"],
  [/^SL$/i, "wood"], // wood slat
  [/^P$/i, "paint"],
];

function familyForPrefix(prefix: string): FinishFamily {
  for (const [re, fam] of FAMILY_BY_PREFIX) if (re.test(prefix)) return fam;
  return "other";
}

/** Match a finish code: prefix letters + optional dash + 1-2 digits + optional
 *  letter. 1-2 digits excludes part numbers like "P800". */
const CODE_RE = /^(ACT|FRP|VCT|QT|CT|TB|TS|WD|SL|P)-?(\d{1,2})([A-Z])?$/i;

export interface FinishTag {
  /** Normalized code, e.g. "P-5", "CT-1". */
  code: string;
  family: FinishFamily;
  /** Position, PDF pt, y-DOWN (matches wall/room space). */
  x: number;
  y: number;
}

export type NoteScope = "paint" | "frp" | "tile" | "mixed" | "unknown";

export interface FinishNote {
  text: string;
  x: number;
  y: number;
  /** Finish codes mentioned in the sentence (normalized). */
  codes: string[];
  families: FinishFamily[];
  /** Room words mentioned (STOCKROOM, WASHROOM, …) for keyword grounding. */
  roomKeywords: string[];
  scope: NoteScope;
}

export interface FinishScope {
  tags: FinishTag[];
  notes: FinishNote[];
}

interface Frag {
  t: string;
  x: number;
  y: number;
}

/** Room words a scope note may reference, so Step B can ground a note like
 *  "ALL STOCKROOM WALLS → P-1" to the right rooms by name. */
const ROOM_KEYWORDS =
  /\b(STOCKROOM|STOCK|OVERSTOCK|WASHROOM|RESTROOM|BATHROOM|VESTIBULE|SALES|SERVICE|ELECTRICAL|MECHANICAL|STORAGE|OFFICE|KITCHEN|CORRIDOR|RETAIL|BACK\s?OF\s?HOUSE|BOH)\b/gi;

/** A line is a scope NOTE if it carries finish intent and is a real sentence
 *  (not a bare tag). */
const NOTE_INTENT =
  /\b(RECEIVE|APPLY|FINISH|PANEL|TILE|PAINT|WAINSCOT|EXTENT|STARTING POINT)\b/i;
const CODE_IN_SENTENCE = /\b(ACT|FRP|VCT|QT|CT|TB|TS|WD|SL|P)-?\d{1,2}[A-Z]?\b/gi;

function normalizeCode(raw: string): string | null {
  const m = raw.match(CODE_RE);
  if (!m) return null;
  const prefix = m[1].toUpperCase();
  const num = m[2];
  const suffix = (m[3] ?? "").toUpperCase();
  return `${prefix}-${num}${suffix}`;
}

function classify(raw: string): { code: string; family: FinishFamily } | null {
  const m = raw.match(CODE_RE);
  if (!m) return null;
  const prefix = m[1].toUpperCase();
  return { code: normalizeCode(raw)!, family: familyForPrefix(prefix) };
}

/**
 * Detect legend/key tags: a tag is part of a legend if it sits in a colinear,
 * evenly-spaced run of >=3 same-family tags (the "P1 P2 P3 P4 P5" key column or
 * "CT-3 CT-4 CT-5" key row). Returns the set of indices that are legend tags.
 */
function legendIndices(tags: FinishTag[]): Set<number> {
  const legend = new Set<number>();
  const byFamily = new Map<FinishFamily, number[]>();
  tags.forEach((t, i) => {
    const arr = byFamily.get(t.family) ?? [];
    arr.push(i);
    byFamily.set(t.family, arr);
  });
  const COLINEAR = 8; // pt tolerance for "same row/column"
  const SPACING = 22; // max gap between consecutive legend entries
  for (const idxs of byFamily.values()) {
    if (idxs.length < 3) continue;
    // vertical runs: same x (±COLINEAR), consecutive y within SPACING
    for (const axis of ["v", "h"] as const) {
      const sorted = [...idxs].sort((a, b) =>
        axis === "v" ? tags[a].y - tags[b].y : tags[a].x - tags[b].x,
      );
      let run: number[] = [];
      const flush = () => {
        if (run.length >= 3) for (const i of run) legend.add(i);
        run = [];
      };
      for (const i of sorted) {
        if (run.length === 0) {
          run = [i];
          continue;
        }
        const prev = tags[run[run.length - 1]];
        const cur = tags[i];
        const colinear =
          axis === "v"
            ? Math.abs(cur.x - prev.x) <= COLINEAR
            : Math.abs(cur.y - prev.y) <= COLINEAR;
        const gap = axis === "v" ? cur.y - prev.y : cur.x - prev.x;
        if (colinear && gap >= 0 && gap <= SPACING) run.push(i);
        else flush(), (run = [i]);
      }
      flush();
    }
  }
  return legend;
}

function noteScope(families: FinishFamily[]): NoteScope {
  const hasPaint = families.includes("paint");
  const hasTile = families.some((f) => f === "wall-tile" || f === "tile-base");
  const hasFrp = families.includes("frp");
  const kinds = [hasPaint, hasTile, hasFrp].filter(Boolean).length;
  if (kinds > 1) return "mixed";
  if (hasPaint) return "paint";
  if (hasFrp) return "frp";
  if (hasTile) return "tile";
  return "unknown";
}

/**
 * Extract deterministic finish-scope signals (tags + notes) from a page.
 */
export async function extractFinishScope(
  pdfBuffer: Buffer,
  pageNumber: number,
): Promise<FinishScope> {
  const mupdf = await import("mupdf");
  const doc = (
    mupdf as unknown as {
      Document: {
        openDocument: (d: Uint8Array, mime: string) => {
          loadPage: (i: number) => {
            toStructuredText: () => { asJSON: () => string };
          };
        };
      };
    }
  ).Document.openDocument(new Uint8Array(pdfBuffer), "application/pdf");
  const page = doc.loadPage(pageNumber - 1);
  const st = JSON.parse(page.toStructuredText().asJSON()) as {
    blocks?: Array<{
      lines?: Array<{ text?: string; bbox?: { x: number; y: number; w: number; h: number } }>;
    }>;
  };

  const frags: Frag[] = [];
  for (const block of st.blocks ?? [])
    for (const line of block.lines ?? []) {
      const t = (line.text ?? "").trim();
      const bb = line.bbox;
      if (!t || !bb) continue;
      frags.push({ t, x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 });
    }

  // --- TAGS: standalone finish codes, legend/part-number filtered ---
  const rawTags: FinishTag[] = [];
  for (const f of frags) {
    const c = classify(f.t);
    if (!c) continue;
    rawTags.push({ code: c.code, family: c.family, x: f.x, y: f.y });
  }
  const legend = legendIndices(rawTags);
  const tags = rawTags.filter((_, i) => !legend.has(i));

  // --- NOTES: scope sentences ---
  const notes: FinishNote[] = [];
  for (const f of frags) {
    if (f.t.length <= 10) continue;
    if (!NOTE_INTENT.test(f.t)) continue;
    const codeMatches = [...f.t.matchAll(CODE_IN_SENTENCE)]
      .map((m) => normalizeCode(m[0]))
      .filter((c): c is string => c !== null);
    const roomKeywords = [...f.t.matchAll(ROOM_KEYWORDS)].map((m) =>
      m[0].toUpperCase(),
    );
    // Keep a note only if it actually carries scope: a finish code, or a
    // room+paint/tile/frp intent.
    if (codeMatches.length === 0 && roomKeywords.length === 0) continue;
    const families = [
      ...new Set(
        codeMatches
          .map((c) => classify(c)?.family)
          .filter((x): x is FinishFamily => !!x),
      ),
    ];
    notes.push({
      text: f.t.replace(/\s+/g, " ").trim(),
      x: f.x,
      y: f.y,
      codes: [...new Set(codeMatches)],
      families,
      roomKeywords: [...new Set(roomKeywords)],
      scope: noteScope(families),
    });
  }

  return { tags, notes };
}
