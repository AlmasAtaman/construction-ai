/**
 * Room-label seed extraction for seeded room segmentation.
 *
 * Architects drop a room tag (name + number) inside each room. Those
 * positions are exactly the seeds a region-grower needs to split
 * open-connected space into rooms. We read them with mupdf's structured
 * text — pdfjs returns y=0 for the rotated/transformed tags on dense
 * commercial sheets, which is useless for seeding.
 */

/** A room tag placed inside a room. Coordinates are PDF pt, y-DOWN
 *  (top-left origin), matching the layer/vector scan space. */
export interface RoomSeed {
  label: string;
  x: number;
  y: number;
}

// Room-name vocabulary — generalizes past one plan without catching
// construction notes. A fragment is a room tag if it matches a known room
// word, ends in ROOM/AREA, or is a bare 3-digit room number. Note-prone
// words (ENTRANCE, BREAK as in "C/W BREAK", TENANT="adjacent tenant") are
// intentionally excluded.
const ROOM_WORDS =
  /\b(WASHROOM|RESTROOM|BATHROOM|VESTIBULE|OVERSTOCK|STOCKROOM|SALES|SERVICE|ELECTRICAL|MECHANICAL|STORAGE|OFFICE|KITCHEN|CORRIDOR|HALLWAY|LOBBY|RECEPTION|RECEIVING|JANITOR|CLOSET|STAIRWELL|RETAIL|DINING|PANTRY|UTILITY|LAUNDRY|FOYER|CONFERENCE|MEETING|LOUNGE)\b/i;
const ROOM_SUFFIX = /^[A-Z][A-Z0-9 &'-]{0,16}\b(ROOM|AREA)$/i;
const ROOM_NUMBER = /^\d{3}[A-Z]?$/; // 101, 104, 134A
// Construction-note signatures — reject these outright.
const NOTE_SIGNATURE = /["()\/]|C\/W|\bSIGN\b|\bSIDE\b|\d\s*["']/;

interface MupdfBBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function isRoomTag(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 20) return false;
  if (NOTE_SIGNATURE.test(t)) return false;
  if (ROOM_NUMBER.test(t)) return true;
  // A short standalone room word (allow a leading qualifier like
  // "UNIVERSAL WASHROOM", "OPEN OFFICE"), but not a long note.
  if (ROOM_WORDS.test(t) && t.split(/\s+/).length <= 2) return true;
  // "ELECTRICAL ROOM", "SALES AREA" etc.
  if (ROOM_SUFFIX.test(t)) return true;
  return false;
}

/**
 * Extract room-tag seed positions from a page. Near-duplicate tags (the
 * same room's name + number, or the same word repeated) are collapsed to
 * one seed per cluster.
 */
export async function extractRoomSeeds(
  pdfBuffer: Buffer,
  pageNumber: number,
): Promise<RoomSeed[]> {
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
      lines?: Array<{ text?: string; bbox?: MupdfBBox }>;
    }>;
  };

  const raw: RoomSeed[] = [];
  for (const block of st.blocks ?? []) {
    for (const line of block.lines ?? []) {
      const text = (line.text ?? "").trim();
      const bb = line.bbox;
      if (!bb || !isRoomTag(text)) continue;
      // Prefer the name over the bare number when both sit at one spot;
      // keep names, drop standalone numbers that duplicate a name nearby.
      raw.push({ label: text, x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 });
    }
  }

  // Collapse near-duplicates (same tag drawn twice, or name+number pair)
  // within ~45pt into a single seed, preferring a named label over a
  // numeric one.
  const CLUSTER_PT = 45;
  const seeds: RoomSeed[] = [];
  for (const r of raw) {
    const near = seeds.find(
      (s) => Math.hypot(s.x - r.x, s.y - r.y) < CLUSTER_PT,
    );
    if (!near) {
      seeds.push({ ...r });
      continue;
    }
    // Merge: keep the more descriptive (non-numeric, longer) label.
    const rNum = ROOM_NUMBER.test(r.label);
    const nNum = ROOM_NUMBER.test(near.label);
    if (nNum && !rNum) near.label = r.label;
    else if (!nNum && !rNum && r.label.length > near.label.length)
      near.label = r.label;
  }
  // Drop bare room-NUMBER seeds that never merged into a named tag: a
  // standalone number far from its room name is usually a door/grid tag,
  // and an extra seed inside an already-named room splits it spuriously.
  // (Named rooms dominate commercial plans; revisit if a plan numbers
  // rooms without naming them.)
  const named = seeds.filter((s) => !ROOM_NUMBER.test(s.label));
  return named.length >= 2 ? named : seeds;
}
