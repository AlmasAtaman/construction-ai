import { pdf } from "pdf-to-img";
import sharp from "sharp";

/**
 * A text fragment from the PDF's vector text layer, with its position
 * normalized to (0..1) over the page. Used both as grounding for the AI
 * ("here are the labels and where they are") and to draw Set-of-Marks
 * overlays.
 */
export interface TextFragment {
  text: string;
  /** Normalized center X (0..1, left → right). */
  xNorm: number;
  /** Normalized center Y (0..1, top → bottom). */
  yNorm: number;
  /** Approximate font size in PDF points. */
  fontSizePt: number;
}

/**
 * A printed `Room × Dimensions` row found in a schedule table. When we
 * detect one of these, we can short-circuit the AI's wall-area math:
 * floor area = widthFt × heightFt is ground truth.
 */
export interface DimensionTableRow {
  /** Room label as printed on the plan. */
  label: string;
  widthFt: number;
  heightFt: number;
  areaSqft: number;
}

export interface RenderedPage {
  imageBase64: string;
  imageMediaType: "image/jpeg";
  /** All text fragments (raw, for grounding). */
  textFragments: TextFragment[];
  /** Filtered to fragments that look like room labels. */
  roomLabels: TextFragment[];
  /** Parsed dimension-table rows if a table was detected. */
  dimensionTable: DimensionTableRow[];
  /** Concatenated text dump (legacy field, kept for the prompt). */
  textAnnotations: string;
  widthPx: number;
  heightPx: number;
  pageWidthPt: number;
  pageHeightPt: number;
}

const TARGET_LONG_EDGE_PX = 1568;
const RENDER_SCALE = 2.5;

export async function renderPdfPage(
  pdfBuffer: Buffer,
  pageNumber: number,
): Promise<RenderedPage> {
  const doc = await pdf(pdfBuffer, { scale: RENDER_SCALE });
  let rawPng: Buffer | null = null;
  let i = 0;
  for await (const pageImage of doc) {
    i++;
    if (i === pageNumber) {
      rawPng = pageImage;
      break;
    }
  }
  if (!rawPng) throw new Error(`Page ${pageNumber} not found in PDF`);

  const processed = await sharp(rawPng)
    .resize({
      width: TARGET_LONG_EDGE_PX,
      height: TARGET_LONG_EDGE_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .grayscale()
    .normalize()
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  const { textFragments, pageWidthPt, pageHeightPt } = await extractTextLayer(
    pdfBuffer,
    pageNumber,
  );
  const roomLabels = pickRoomLabels(textFragments);
  const dimensionTable = parseDimensionTable(textFragments);
  if (process.env.NODE_ENV === "development") {
    // eslint-disable-next-line no-console
    console.log(
      `[render] page ${pageNumber}: ${textFragments.length} fragments, ${roomLabels.length} labels, ${dimensionTable.length} dim rows`,
    );
  }

  return {
    imageBase64: processed.data.toString("base64"),
    imageMediaType: "image/jpeg",
    textFragments,
    roomLabels,
    dimensionTable,
    textAnnotations: textFragments
      .map((f) => f.text)
      .join(" | ")
      .slice(0, 4000),
    widthPx: processed.info.width,
    heightPx: processed.info.height,
    pageWidthPt,
    pageHeightPt,
  };
}

/**
 * Extract every text fragment from the PDF's vector text layer along with
 * its normalized center position. Skips empty strings and pure whitespace.
 */
async function extractTextLayer(
  pdfBuffer: Buffer,
  pageNumber: number,
): Promise<{
  textFragments: TextFragment[];
  pageWidthPt: number;
  pageHeightPt: number;
}> {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(pdfBuffer),
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
    });
    const doc = await loadingTask.promise;
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    const fragments: TextFragment[] = [];
    for (const item of content.items as Array<{
      str: string;
      transform?: number[];
      width?: number;
      height?: number;
    }>) {
      const s = (item.str ?? "").trim();
      if (!s) continue;
      if (!item.transform || item.transform.length < 6) continue;
      const tx = item.transform[4];
      const ty = item.transform[5];
      const w = item.width ?? 0;
      const h = item.height ?? Math.abs(item.transform[3] ?? 10);
      const cx = tx + w / 2;
      // PDF origin is bottom-left; flip to top-left so 0,0 = top-left of page.
      const cy = viewport.height - (ty + h / 2);
      fragments.push({
        text: s,
        xNorm: clamp01(cx / viewport.width),
        yNorm: clamp01(cy / viewport.height),
        fontSizePt: Math.abs(item.transform[3] ?? 10),
      });
    }
    return {
      textFragments: fragments,
      pageWidthPt: viewport.width,
      pageHeightPt: viewport.height,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[extractTextLayer] failed:", err);
    return { textFragments: [], pageWidthPt: 0, pageHeightPt: 0 };
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Heuristic: looks like a room label on a floor plan. We're permissive on
 * purpose — the AI gets the full list of candidates and picks the actual
 * rooms it can see. False positives are cheap; false negatives mean a
 * missed room.
 */
// Common annotation words that show up on plans but aren't actual rooms.
// Filtering these saves a per-room AI call each ($0.01-0.02 saved per).
const ANNOTATION_NOT_ROOM =
  /^(column|columns|glass roof|roof|north|south|east|west|legend|notes?|key|symbols?|scale|true north|grid|datum|align|typ\.?|sim\.?|do not enter|exit|entry|elev\.?|fdn\.?|f\.d\.?|sect\.?|sect|stair|stairs|hold|hatch)$/i;

// Words that appear ONLY in title blocks / legends — not on the actual
// floor plan drawing. Common in commercial architectural documents.
const TITLE_BLOCK_KEYWORD =
  /^(stamp|consultant|consultants?|architect|engineer|drawn|checked|approved|reviewed|sheet|drawing|project number|building number|location|issue date|revision|revisions?|description|date|date:|of record|finish plan general notes|general notes|no work|no work this area|finish plan|reflected ceiling plan|abbreviations?|room finish legend|abbreviation|construction documents?|prebid|addendum|revision set|first floor|second floor|third floor|saint cloud|st cloud|st\. cloud|key plan)$/i;

// Date and code patterns commonly in title blocks
const DATE_PATTERN =
  /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}$/i;
const SHEET_CODE =
  /^(a|af|s|m|e|p|c|l|t)[a-z]?\d{2,4}[a-z]?$/i; // "AF101", "A201", "ME502"

// Material/finish/paint codes printed all over commercial drawings.
// "P-1", "P-2", "CPT-1", "VCT-1", "PT-1/PT-2", "CG", "WSF-1", etc.
const MATERIAL_CODE =
  /^(p|pt|cpt|vct|wsf|cg|act|gwb|cmu|wb|gyp|hm|wd|mtl|sst|alm|alm\.?|gl|gl\.?)\s*-?\s*\d+([\s/-]?\d+)?$/i;

// Multi-code joined with slashes: "PT-1/PT-2", "CPT-1/CPT-2"
const MATERIAL_CODE_SLASH =
  /^([a-z]{1,4}\s*-?\s*\d+)(\s*\/\s*[a-z]{1,4}\s*-?\s*\d+)+$/i;

// Bare 1-2 letter codes that are never room names.
const SHORT_CODE = /^[A-Z]{1,2}$/;

/**
 * Detect the title-block region. Commercial drawings have a dense strip
 * of administrative text — sheet number, project title, architect of
 * record, revision schedule, etc. — usually clustered in the right or
 * bottom edge of the page. We find every fragment that matches a
 * title-block keyword and union their positions into a "no go" box.
 * Labels inside that box are NOT treated as room labels.
 */
/**
 * Title blocks live in one of two places: a vertical strip on the right
 * (x > ~0.72) or a horizontal strip across the bottom (y > ~0.78).
 * We figure out which by asking: where are most of the title-block
 * keyword hits clustered? Then we return one of three boxes — right
 * strip, bottom strip, or both.
 */
function detectTitleBlockBox(
  fragments: TextFragment[],
): Array<{ x0: number; y0: number; x1: number; y1: number }> {
  const hits: TextFragment[] = [];
  for (const f of fragments) {
    const t = f.text.trim();
    if (TITLE_BLOCK_KEYWORD.test(t) || DATE_PATTERN.test(t) || SHEET_CODE.test(t)) {
      hits.push(f);
    }
  }
  if (hits.length < 2) return [];
  const inRightStrip = hits.filter((h) => h.xNorm > 0.7).length;
  const inBottomStrip = hits.filter((h) => h.yNorm > 0.78).length;
  const totalHits = hits.length;
  const boxes: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  // If at least half of the title-block hits cluster in the right strip,
  // exclude that strip.
  if (inRightStrip >= Math.ceil(totalHits * 0.4)) {
    boxes.push({ x0: 0.7, y0: 0, x1: 1.0, y1: 1.0 });
  }
  // Same for bottom strip.
  if (inBottomStrip >= Math.ceil(totalHits * 0.4)) {
    boxes.push({ x0: 0, y0: 0.78, x1: 1.0, y1: 1.0 });
  }
  return boxes;
}

function pickRoomLabels(fragments: TextFragment[]): TextFragment[] {
  const titleBlocks = detectTitleBlockBox(fragments);
  const candidates: TextFragment[] = [];
  for (const f of fragments) {
    const t = f.text.trim();
    if (t.length < 2 || t.length > 40) continue;
    // Skip pure numeric / measurement strings.
    if (/^[\d'"\-.,×x\s]+$/.test(t)) continue;
    // Skip URLs and addresses with digits.
    if (/^https?:\/\//.test(t)) continue;
    if (/^\d+\s+[A-Z]/i.test(t) && t.length > 12) continue;
    // Skip page numbers and short purely-numeric callouts.
    if (/^\d+$/.test(t)) continue;
    // Skip very-edge margins (title block / page number row).
    if (f.yNorm < 0.04 || f.yNorm > 0.97) continue;
    if (f.xNorm < 0.02 || f.xNorm > 0.98) continue;
    // Skip well-known non-room annotations and material/finish codes.
    if (ANNOTATION_NOT_ROOM.test(t)) continue;
    if (MATERIAL_CODE.test(t)) continue;
    if (MATERIAL_CODE_SLASH.test(t)) continue;
    if (SHORT_CODE.test(t)) continue;
    // Skip title-block words, dates, sheet codes (commercial titleblock noise).
    if (TITLE_BLOCK_KEYWORD.test(t)) continue;
    if (DATE_PATTERN.test(t)) continue;
    if (SHEET_CODE.test(t)) continue;
    // Skip strings with no alphabetic chars after stripping non-letters
    // (e.g., "1/4"", "12-0", purely punctuation).
    if (!/[A-Za-z]{2,}/.test(t)) continue;
    // Skip if inside any detected title block region.
    const inTitleBlock = titleBlocks.some(
      (b) =>
        f.xNorm >= b.x0 &&
        f.xNorm <= b.x1 &&
        f.yNorm >= b.y0 &&
        f.yNorm <= b.y1,
    );
    if (inTitleBlock) continue;
    candidates.push(f);
  }
  return candidates;
}

/**
 * Look for `Room × Dimensions` table rows. The strategy:
 *   1. Find every fragment that looks like a dimension (`12'-0" × 14'-0"`,
 *      `9'11" × 10'11"`, `10×8`).
 *   2. For each, take the nearest text-fragment to its LEFT in the same
 *      row (within +/- one font-height vertically). That's the room name.
 *   3. Convert the dimension to feet and produce {label, width, height,
 *      area}.
 */
function parseDimensionTable(
  fragments: TextFragment[],
): DimensionTableRow[] {
  // Combined regex: matches W'F" x H'F", W' x H', W×H (with optional inches).
  // Accept straight ASCII ' " AND smart curly quotes — different PDFs use different glyphs.
  const QSINGLE = "[\\u0027\\u2018\\u2019\\u2032]"; // ' ' ' ′
  const QDOUBLE = "[\\u0022\\u201C\\u201D\\u2033]"; // " " " ″
  const DIM_RE = new RegExp(
    `^(\\d{1,3})\\s*${QSINGLE}\\s*(\\d{1,2})?\\s*${QDOUBLE}?\\s*[xX\\u00D7]\\s*(\\d{1,3})\\s*${QSINGLE}\\s*(\\d{1,2})?\\s*${QDOUBLE}?$`,
  );
  const SIMPLE_RE = /^(\d{1,3}(?:\.\d+)?)\s*[xX×]\s*(\d{1,3}(?:\.\d+)?)$/;

  const dims: { f: TextFragment; w: number; h: number }[] = [];
  for (const f of fragments) {
    const txt = f.text.replace(/\s+/g, "");
    const m = DIM_RE.exec(txt);
    if (m) {
      const w = parseInt(m[1], 10) + (parseInt(m[2] ?? "0", 10) || 0) / 12;
      const h = parseInt(m[3], 10) + (parseInt(m[4] ?? "0", 10) || 0) / 12;
      if (w > 0 && h > 0 && w < 200 && h < 200) {
        dims.push({ f, w, h });
        continue;
      }
    }
    const m2 = SIMPLE_RE.exec(txt);
    if (m2) {
      const w = parseFloat(m2[1]);
      const h = parseFloat(m2[2]);
      if (w > 0 && h > 0 && w < 200 && h < 200) {
        dims.push({ f, w, h });
      }
    }
  }

  // For each dim, find the nearest left-side fragment in the same row.
  const rows: DimensionTableRow[] = [];
  for (const d of dims) {
    const rowHeight = 0.012; // ~1.2% of page height
    const left = fragments.filter(
      (g) =>
        g !== d.f &&
        Math.abs(g.yNorm - d.f.yNorm) < rowHeight &&
        g.xNorm < d.f.xNorm &&
        // Skip if it's also a dimension fragment.
        !DIM_RE.test(g.text.trim()) &&
        !SIMPLE_RE.test(g.text.trim()),
    );
    if (left.length === 0) continue;
    // Pick the rightmost (closest) text fragment to the left.
    left.sort((a, b) => b.xNorm - a.xNorm);
    const label = left[0].text.trim();
    // Sanity check: don't pick generic words like "Width" / "Height".
    if (/^(width|height|dim|dimension|size|area)$/i.test(label)) continue;
    rows.push({
      label,
      widthFt: round1(d.w),
      heightFt: round1(d.h),
      areaSqft: round1(d.w * d.h),
    });
  }

  // De-duplicate by label (keep the first occurrence).
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = r.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Composite a Set-of-Marks overlay onto the rendered JPEG: a small
 * numbered circle at each room label's position so the AI can refer to
 * rooms by mark number. Returns a new base64 JPEG.
 */
export async function drawMarks(
  imageBase64: string,
  imageMediaType: "image/jpeg" | "image/png",
  marks: { xNorm: number; yNorm: number; n: number }[],
  imageWidthPx: number,
  imageHeightPx: number,
): Promise<{ imageBase64: string; imageMediaType: "image/jpeg" }> {
  if (marks.length === 0) {
    return {
      imageBase64,
      imageMediaType: imageMediaType === "image/png" ? "image/jpeg" : imageMediaType,
    };
  }

  // SVG overlay: a circle + number per mark.
  const r = Math.max(14, Math.round(imageHeightPx * 0.014));
  const fontSize = Math.max(12, Math.round(r * 1.1));
  const svgMarks = marks
    .map(({ xNorm, yNorm, n }) => {
      const cx = Math.round(xNorm * imageWidthPx);
      const cy = Math.round(yNorm * imageHeightPx);
      return `
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="#E8742C" stroke="white" stroke-width="2"/>
        <text x="${cx}" y="${cy + Math.round(r * 0.4)}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="white" text-anchor="middle">${n}</text>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidthPx}" height="${imageHeightPx}">${svgMarks}</svg>`;

  const buffer = Buffer.from(imageBase64, "base64");
  const out = await sharp(buffer)
    .composite([{ input: Buffer.from(svg), blend: "over" }])
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();

  return {
    imageBase64: out.toString("base64"),
    imageMediaType: "image/jpeg",
  };
}
