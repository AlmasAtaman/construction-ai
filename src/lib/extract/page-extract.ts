/**
 * Page extraction — the deterministic replacement for AI coordinate
 * guessing.
 *
 * Decides which extraction strategy a single PDF page supports, then
 * produces a list of rooms with normalized polygons whose coordinates
 * came from real PDF geometry, never from an AI estimate.
 *
 * Strategies, in order of trust:
 *
 *   A. table   — page has a printed `Room × Dimensions` schedule.
 *      Each row's `widthFt × heightFt` is ground truth. We try to anchor
 *      the rectangle to a real wall-bounded face from the planar graph;
 *      when no face is available (geometry-poor plans), we fall back to
 *      a rectangle sized from `widthFt × heightFt × ptPerFt`, anchored
 *      to the room's in-plan label fragment. Never anchored to the
 *      schedule table itself.
 *
 *   B. vector  — page has a real vector wall network. We run the
 *      existing commercial-rooms pipeline (planar-graph faces +
 *      label-to-face pairing) and use the face polygons directly.
 *
 *   none — skipped pages: covers, photo pages, amenities text,
 *      specifications text, scanned/flattened images. No boxes drawn.
 *
 * Coordinates leaving this module are normalized 0..1 with y-down
 * (0 = top of page), matching what SurfaceOverlay consumes.
 */

import { detectRooms, type RoomFace } from "../planar-graph";
import {
  establishScale,
  type EstablishedScale,
  type UserSuppliedScale,
} from "./scale";
import {
  parseDimensionCallouts,
  calloutsForRoom,
  type DimensionCallout,
} from "../dimension-callouts";
import {
  virtualPartition,
  type ClaimedPeer,
  type FailedLabel,
} from "./virtual-partition";

export type Derivation =
  | "scale-measured"
  | "table-cross-checked"
  | "traced"
  | "sized-from-dimensions"
  | "table-only"
  | "virtual-partition"
  | "scale-needed"
  | "geometry-uncertain"
  | "ai-fallback";

export interface ExtractedRoom {
  /** Room label as printed on the plan. */
  label: string;
  /** PDF user-space bbox (y-up). null when no on-plan placement was found. */
  bboxPt: { x: number; y: number; width: number; height: number } | null;
  /**
   * Closed polygon in normalized 0..1 page coords, y-down (0 = top).
   * Empty when the room has measurement but no reliable placement —
   * the caller renders no marker in that case.
   */
  polygonNorm: { x: number; y: number }[];
  widthFt: number | null;
  heightFt: number | null;
  areaSqft: number | null;
  /** Wall perimeter in feet — sum of polygon edge lengths × scale. */
  perimeterFt: number | null;
  /**
   * The architect's printed table value for this room, if any. Set
   * when the row came from a dim-table; left null otherwise. Lets the
   * UI show "table says 14×16, scale-measured 13.8×16.1" side by side.
   */
  tableWidthFt?: number | null;
  tableHeightFt?: number | null;
  tableAreaSqft?: number | null;
  /** Cross-check disagreement message when present. */
  measurementWarning?: string;
  derivation: Derivation;
}

export interface ExtractedPage {
  status: "ok" | "skipped";
  /** Why this page was skipped (only set when status === "skipped"). */
  reason?: "no_text_layer" | "non_floor_plan" | "low_geometry";
  /** Which strategy produced the rooms. */
  strategy: "table" | "vector" | "none";
  rooms: ExtractedRoom[];
  pageWidthPt: number;
  pageHeightPt: number;
  /**
   * The scale used for every scale-measured number on the page. Null
   * when no scale source was found AND no user scale was supplied —
   * callers must NOT invent one; surface a "scale needed" state.
   */
  establishedScale: EstablishedScale | null;
  /** Useful diagnostics for logging — not consumed by callers. */
  diagnostics: {
    textFragmentCount: number;
    vectorPathOpCount: number;
    wallSegmentCount: number;
    planarFaceCount: number;
    dimRowCount: number;
    roomLikeLabelCount: number;
    /** The pt/ft actually used for measurement (= establishedScale.ptPerFoot or null). */
    ptPerFt: number | null;
    elapsedMs: number;
  };
}

export interface ExtractPageOptions {
  /**
   * User-supplied scale (from a two-point click calibration persisted
   * on PlanPage). Overrides any text-notation / scale-bar detection.
   */
  userScale?: UserSuppliedScale | null;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RawTextFragment {
  text: string;
  /** PDF user space (y-up). */
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
  fontSize: number;
  /** Rotation in radians from the pdfjs transform. Used to infer
   *  horizontal vs vertical dimension-callout orientation. */
  rotation: number;
}

interface MupdfPath {
  walk: (visitor: {
    moveTo: (x: number, y: number) => void;
    lineTo: (x: number, y: number) => void;
    curveTo?: (
      c1x: number,
      c1y: number,
      c2x: number,
      c2y: number,
      ex: number,
      ey: number,
    ) => void;
    closePath: () => void;
  }) => void;
}

interface DimRow {
  label: string;
  labelFragment: RawTextFragment;
  dimFragment: RawTextFragment;
  widthFt: number;
  heightFt: number;
  areaSqft: number;
}

// ---------------------------------------------------------------------------
// Dimension regex — accepts straight + curly quotes, with/without inches
// ---------------------------------------------------------------------------

const Q1 = "[\\u0027\\u2018\\u2019\\u2032]"; // ' ' ' ′
const Q2 = "[\\u0022\\u201C\\u201D\\u2033]"; // " " " ″
const DIM_RE = new RegExp(
  `^(\\d{1,3})\\s*${Q1}\\s*(\\d{1,2})?\\s*${Q2}?\\s*[xX\\u00D7]\\s*(\\d{1,3})\\s*${Q1}\\s*(\\d{1,2})?\\s*${Q2}?$`,
);
const SIMPLE_DIM_RE = /^(\d{1,3}(?:\.\d+)?)\s*[xX×]\s*(\d{1,3}(?:\.\d+)?)$/;

function parseDim(raw: string): { widthFt: number; heightFt: number } | null {
  const t = raw.replace(/\s+/g, "");
  const m = DIM_RE.exec(t);
  if (m) {
    const w = parseInt(m[1], 10) + (parseInt(m[2] ?? "0", 10) || 0) / 12;
    const h = parseInt(m[3], 10) + (parseInt(m[4] ?? "0", 10) || 0) / 12;
    if (w > 0 && h > 0 && w < 200 && h < 200) {
      return { widthFt: w, heightFt: h };
    }
  }
  const m2 = SIMPLE_DIM_RE.exec(t);
  if (m2) {
    const w = parseFloat(m2[1]);
    const h = parseFloat(m2[2]);
    if (w > 0 && h > 0 && w < 200 && h < 200) {
      return { widthFt: w, heightFt: h };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Header / dim-table cluster rejection
// ---------------------------------------------------------------------------

// Fragments that obviously belong to title-block / header noise — they
// must never become room anchors. We keep this list short and targeted;
// the regex matches the WHOLE trimmed string only.
const HEADER_NOISE = new RegExp(
  [
    `^(client|date|job\\s*#?|sheet|project|drawn|scale|north|key|legend|notes?)`,
    `:?$`,
  ].join(""),
  "i",
);
const DATE_LIKE =
  /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}$/i;
const JOB_NUMBER_LIKE = /^(job|sheet|drawing|project)\s*#?:?\s*[\w-]+$/i;
const PURE_NUMBER = /^\d[\d.,]*$/;
const DIM_TABLE_HEADER = /^(room|dimensions?|size|area|name)$/i;

function isHeaderFragment(t: string): boolean {
  const s = t.trim();
  if (s.length === 0) return true;
  if (HEADER_NOISE.test(s)) return true;
  if (DATE_LIKE.test(s)) return true;
  if (JOB_NUMBER_LIKE.test(s)) return true;
  if (PURE_NUMBER.test(s)) return true;
  if (DIM_TABLE_HEADER.test(s)) return true;
  return false;
}

/**
 * Detect a dimensions-table cluster on the page.
 *
 * Schedules localize the dim fragments — every `W'X" × H'X"` lives
 * inside a small region (a vertical column, a horizontal row, or a
 * grid). Inline wall callouts on a real plan spread across most of
 * the page. We tell them apart by AABB area: a schedule's AABB is a
 * small fraction of the page (<5%); inline callouts cover much more.
 *
 * Returns the AABB of every dim fragment plus its paired left-side
 * label fragments, expanded slightly. Anchoring inside that box is
 * forbidden.
 */
function detectDimTableBox(
  fragments: RawTextFragment[],
  pageWidthPt: number,
  pageHeightPt: number,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const dimFragments = fragments.filter((f) => parseDim(f.text) !== null);
  if (dimFragments.length < 2) return null;

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const f of dimFragments) {
    if (f.xPt < xMin) xMin = f.xPt;
    if (f.xPt + f.widthPt > xMax) xMax = f.xPt + f.widthPt;
    if (f.yPt < yMin) yMin = f.yPt;
    if (f.yPt + f.heightPt > yMax) yMax = f.yPt + f.heightPt;
  }
  const aabbArea = (xMax - xMin) * (yMax - yMin);
  const pageArea = pageWidthPt * pageHeightPt;
  // If the AABB covers more than ~12% of the page, these are inline
  // wall callouts scattered across the plan rather than a schedule.
  if (aabbArea / pageArea > 0.12) return null;

  // Pull in label fragments that sit anywhere on a row sharing y with
  // a dim fragment — they're part of the schedule.
  let labelXMin = xMin;
  let labelYMin = yMin;
  let labelYMax = yMax;
  const ROW_TOLERANCE = 3;
  for (const f of fragments) {
    if (parseDim(f.text) !== null) continue;
    // Same y-row as any dim fragment?
    const sharesRow = dimFragments.some(
      (d) => Math.abs(f.yPt - d.yPt) <= ROW_TOLERANCE,
    );
    if (!sharesRow) continue;
    // Same column (a label sitting above/below a dim) doesn't qualify;
    // it must be on the SAME row.
    if (f.xPt + f.widthPt > labelXMin && f.xPt < xMax) {
      labelXMin = Math.min(labelXMin, f.xPt);
      labelYMin = Math.min(labelYMin, f.yPt);
      labelYMax = Math.max(labelYMax, f.yPt + f.heightPt);
    }
  }
  return {
    x0: labelXMin - 4,
    y0: Math.min(yMin, labelYMin) - 4,
    x1: xMax + 4,
    y1: Math.max(yMax, labelYMax) + 4,
  };
}

// ---------------------------------------------------------------------------
// Vector path walking (mupdf)
// ---------------------------------------------------------------------------

/**
 * Minimum length (in PDF points) for a non-axis-aligned segment to be
 * kept as an architectural wall instead of dropped as stray vector ink.
 *
 * Picked above the 18-45 pt door-swing band with headroom so short
 * dimension ticks, hatch ends, and small ornamental diagonals don't
 * masquerade as walls. Tuned against the angled east entrance on the
 * commercial fixture and DP-BP page 10 (see Day 1 probe in
 * scripts/probe-diagonal-walls.mjs).
 *
 * Surfaced as a named export so the wall-tracer pipeline and test
 * probes share one source of truth.
 */
export const DIAGONAL_WALL_MIN_PT = 50;

export interface VectorScan {
  /**
   * Axis-aligned wall segments. Contract: every entry is either purely
   * horizontal (y1 === y2) or purely vertical (x1 === x2). Consumed by
   * the room detector (detectRooms, roomBoundsFromRays, virtualPartition)
   * which assumes axis-alignment throughout. Do NOT push diagonals here
   * — they belong in diagonalWalls.
   */
  walls: { x1: number; y1: number; x2: number; y2: number }[];
  /**
   * Long non-axis-aligned wall segments — angled entries, bay clips,
   * non-orthogonal corridors. Captured for the wall-path tracer; NOT
   * fed to the room detector (its planar graph assumes H/V edges and
   * adding diagonals would mutate existing room faces). Exposed
   * alongside `walls` so the tracer pipeline can consume both.
   */
  diagonalWalls: { x1: number; y1: number; x2: number; y2: number }[];
  doorCandidates: { x: number; y: number; size: number }[];
  pathOpCount: number;
  /** AABB of every emitted segment endpoint in pt (y-up). */
  segmentBboxPt: { x0: number; y0: number; x1: number; y1: number } | null;
}

interface MupdfModule {
  Document: { openDocument: (data: Uint8Array, mime: string) => MupdfDoc };
  Device: new (handlers: Record<string, unknown>) => unknown;
  Matrix: { identity: number[] };
}
interface MupdfDoc {
  loadPage: (i: number) => MupdfPage;
}
interface MupdfPage {
  getBounds: () => number[];
  run: (device: unknown, matrix: number[]) => void;
}

export async function scanVectorPaths(
  pdfBuffer: Buffer,
  pageNumber: number,
): Promise<{
  scan: VectorScan;
  pageWidthPt: number;
  pageHeightPt: number;
}> {
  const mupdfMod = (await import("mupdf")) as unknown as MupdfModule;
  const doc = mupdfMod.Document.openDocument(
    new Uint8Array(pdfBuffer),
    "application/pdf",
  );
  const page = doc.loadPage(pageNumber - 1);
  const bounds = page.getBounds();
  const pageWidthPt = bounds[2] - bounds[0];
  const pageHeightPt = bounds[3] - bounds[1];

  const scan: VectorScan = {
    walls: [],
    diagonalWalls: [],
    doorCandidates: [],
    pathOpCount: 0,
    segmentBboxPt: null,
  };

  function expandBbox(x: number, y: number): void {
    if (scan.segmentBboxPt === null) {
      scan.segmentBboxPt = { x0: x, y0: y, x1: x, y1: y };
      return;
    }
    const b = scan.segmentBboxPt;
    if (x < b.x0) b.x0 = x;
    if (y < b.y0) b.y0 = y;
    if (x > b.x1) b.x1 = x;
    if (y > b.y1) b.y1 = y;
  }

  function tx(ctm: number[], x: number, y: number): [number, number] {
    return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
  }
  function emit(x1: number, y1: number, x2: number, y2: number): void {
    expandBbox(x1, y1);
    expandBbox(x2, y2);
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const len = Math.hypot(dx, dy);
    if (len < 5) return;
    if (dy < 1.5 && dx > 1.5) {
      scan.walls.push({ x1, y1, x2, y2: y1 });
    } else if (dx < 1.5 && dy > 1.5) {
      scan.walls.push({ x1, y1, x2: x1, y2 });
    } else if (len >= 18 && len <= 45) {
      scan.doorCandidates.push({
        x: (x1 + x2) / 2,
        y: (y1 + y2) / 2,
        size: len,
      });
    } else if (len >= DIAGONAL_WALL_MIN_PT) {
      // Long non-axis segment — architectural diagonal (angled entry,
      // bay clip, non-orthogonal corridor). Kept in a separate array
      // so the room detector (which assumes H/V everywhere) is not
      // disturbed; the wall-path tracer reads both walls and
      // diagonalWalls.
      scan.diagonalWalls.push({ x1, y1, x2, y2 });
    }
  }
  function collect(p: MupdfPath, ctm: number[]): void {
    let cx = 0;
    let cy = 0;
    let sx = 0;
    let sy = 0;
    p.walk({
      moveTo: (x, y) => {
        scan.pathOpCount++;
        [cx, cy] = tx(ctm, x, y);
        sx = cx;
        sy = cy;
      },
      lineTo: (x, y) => {
        scan.pathOpCount++;
        const [nx, ny] = tx(ctm, x, y);
        emit(cx, cy, nx, ny);
        cx = nx;
        cy = ny;
      },
      curveTo: (c1x, c1y, c2x, c2y, ex, ey) => {
        scan.pathOpCount++;
        const [a1x, a1y] = tx(ctm, c1x, c1y);
        const [a2x, a2y] = tx(ctm, c2x, c2y);
        const [aex, aey] = tx(ctm, ex, ey);
        const minX = Math.min(cx, a1x, a2x, aex);
        const maxX = Math.max(cx, a1x, a2x, aex);
        const minY = Math.min(cy, a1y, a2y, aey);
        const maxY = Math.max(cy, a1y, a2y, aey);
        const extent = Math.max(maxX - minX, maxY - minY);
        if (extent >= 18 && extent <= 45) {
          scan.doorCandidates.push({
            x: (minX + maxX) / 2,
            y: (minY + maxY) / 2,
            size: extent,
          });
        }
        cx = aex;
        cy = aey;
      },
      closePath: () => {
        scan.pathOpCount++;
        emit(cx, cy, sx, sy);
        cx = sx;
        cy = sy;
      },
    });
  }
  const device = new mupdfMod.Device({
    fillPath: (p: MupdfPath, _: unknown, ctm: number[]) => collect(p, ctm),
    strokePath: (p: MupdfPath, _: unknown, ctm: number[]) => collect(p, ctm),
  });
  page.run(device, mupdfMod.Matrix.identity);

  return { scan, pageWidthPt, pageHeightPt };
}

// ---------------------------------------------------------------------------
// Text fragment extraction (pdfjs)
// ---------------------------------------------------------------------------

interface PdfjsLike {
  getDocument: (opts: {
    data: Uint8Array;
    useWorkerFetch?: boolean;
    isEvalSupported?: boolean;
    useSystemFonts?: boolean;
  }) => { promise: Promise<PdfjsDoc> };
}
interface PdfjsDoc {
  getPage: (n: number) => Promise<PdfjsPage>;
}
interface PdfjsPage {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  getTextContent: () => Promise<{
    items: Array<{
      str?: string;
      transform?: number[];
      width?: number;
      height?: number;
    }>;
  }>;
}

async function extractTextFragments(
  pdfBuffer: Buffer,
  pageNumber: number,
): Promise<{
  fragments: RawTextFragment[];
  viewportWidth: number;
  viewportHeight: number;
}> {
  const pdfjs = (await import(
    "pdfjs-dist/legacy/build/pdf.mjs"
  )) as unknown as PdfjsLike;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const fragments: RawTextFragment[] = [];
  for (const item of tc.items) {
    const s = (item.str ?? "").trim();
    if (!s) continue;
    if (!item.transform || item.transform.length < 6) continue;
    const w = item.width ?? 0;
    const h = item.height ?? Math.abs(item.transform[3] ?? 10);
    const a = item.transform[0] ?? 1;
    const b = item.transform[1] ?? 0;
    fragments.push({
      text: s,
      xPt: item.transform[4],
      yPt: item.transform[5],
      widthPt: w,
      heightPt: h,
      fontSize: Math.abs(item.transform[3] ?? 10),
      rotation: Math.atan2(b, a),
    });
  }
  return {
    fragments,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
  };
}

// ---------------------------------------------------------------------------
// Room-like label classification
// ---------------------------------------------------------------------------

// Tokens that signal "this is a room name." Permissive — false positives
// are cheap; false negatives drop boxes.
const ROOM_KW =
  /\b(ROOM|CORRIDOR|OFFICE|STAIR|ELEV|LOBBY|STORAGE|STORE|OXYGEN|BATH|RESTROOM|TOILET|MECH|ELECTRICAL|JANITOR|KITCHEN|LOCKER|VEST|LOUNGE|WAIT|PANTRY|CLOSET|UTILITY|LINEN|EXAM|CONF|RECEPTION|STAFF|PATIENT|BEDROOM|BED|DINING|LIVING|GARAGE|FOYER|LAUNDRY|POWDER|HALL|WIC|PWDR|MASTER|ENTRY|DEN|STUDY|NOOK|PORCH|DECK|PATIO|MUDROOM|MUD|FAMILY|GREAT|MEDIA|BONUS|REC|HOBBY|GUEST|NURSERY|PLAYROOM|GYM|FLEX|PRIMARY|ENSUITE|BALCONY|WORK|ALCOVE|VESTIBULE|HALLWAY|ATTIC|BASEMENT|CELLAR|FORMAL|BREAKFAST|MORNING|CRAFT|SHOP|MECHANICAL|RECREATION|GAMES|ENTRANCE|SUNROOM|MORNING|MASTER|GARDEN|GREENHOUSE)\b/i;

const EXCLUDE_KW =
  /\b(SF|SQFT|TYP|DET|DETAIL|NOTE|NOTES|SEE|ALIGN|VIF|REF|SECTION|ELEVATION|PLAN|DRAWING|SHEET|SCALE|TITLE|STAMP|REVISION|PROJECT|ARCHITECT|ENGINEER|CONSULTANT|FINISH|SCHEDULE|GENERAL|LEGEND|KEY|SYMBOL|CODE|NAVIGATION|DEPARTMENT|VETERANS|RENDERING|OVERVIEW|WINDOW|DOOR|GLASS|SLIDER|SLIDING|DOORS|SHOWER|ART|WALL|COLLECTION|WINNER|AWARD|HICKORY|MULBERRY|WALNUT|PALM|WILLOW|PINE|TAMARIND|PEACH|SANDALWOOD|MAPLE|OAK|BIRCH|CEDAR|TREATED|PRESSURE|LEDGER|CONSTRUCTION|TYPICAL|PROVIDE|INSTALL|EXIST|EXISTING|REMOVE|RELOCATE|FOR|FROM|ROOF|PEAK|JOIST|FRAMING|HEADER|BEAM|STUD|RAFTER|RAIL|RAILING|HANDRAIL|GUARDRAIL|BLOCKING|SIDING|SOFFIT|FASCIA|FOUNDATION|FOOTING|SLAB|BACKFILL|GRADE|CHAIR|DESK|WARDROBE|WARDR0BE|CABINET|COUNTER|DISPENSER|TISSUE|NIGHTSTAND|FURNISHING|FURNITURE|BOOKCASE|DRESSER|MIRROR)\b/i;

// Detail callouts (E1, D19, W18, S5) and short codes.
const CALLOUT_CODE = /^[A-Z]{1,3}\s*-?\s*\d{1,3}[A-Z]?$/i;

// Unit-type captions ("1 Bedroom", "2 Bedroom + Den") — they show up
// inside a marketing brochure's title bar and key-plan thumbnail, NOT
// inside an actual room. Treat them as unit names, not rooms.
const UNIT_TYPE_LIKE =
  /^\d+\s+(bedroom|bed|br)(\s*(\+|and|and a)\s+(den|flex|study))?$/i;

// Area-summary labels printed in the marketing sidebar — "Interior
// Area", "Balcony Area", "Total Area". They name metrics, not rooms.
const AREA_METRIC = /\b(interior|balcony|total|garage|usable|saleable)\s+area$/i;

function isRoomLikeLabel(text: string): boolean {
  const t = text.trim();
  if (t.length < 2 || t.length > 40) return false;
  // Marketing prose ("• Billiards room") starts with a bullet or
  // dash — never a room label.
  if (/^[•·\-*]/.test(t)) return false;
  // Long phrases (more than 4 words) are notes, not room names.
  if (t.split(/\s+/).length > 4) return false;
  if (UNIT_TYPE_LIKE.test(t)) return false;
  if (AREA_METRIC.test(t)) return false;
  if (isHeaderFragment(t)) return false;
  if (parseDim(t) !== null) return false;
  if (CALLOUT_CODE.test(t)) return false;
  if (EXCLUDE_KW.test(t)) return false;
  if (!ROOM_KW.test(t)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function rectPolygonNorm(
  cxPt: number,
  cyPt: number,
  widthPt: number,
  heightPt: number,
  pageWidthPt: number,
  pageHeightPt: number,
): { x: number; y: number }[] {
  // Convert a PDF y-up centered rectangle to overlay y-down normalized.
  const halfW = widthPt / 2;
  const halfH = heightPt / 2;
  const x0Pt = cxPt - halfW;
  const x1Pt = cxPt + halfW;
  const y0Pt = cyPt - halfH;
  const y1Pt = cyPt + halfH;
  const clamp = (v: number) => Math.max(0.005, Math.min(0.995, v));
  // y-down: yNorm = 1 - yPt / pageHeight. Topmost corner uses the
  // larger PDF y.
  return [
    { x: clamp(x0Pt / pageWidthPt), y: clamp(1 - y1Pt / pageHeightPt) },
    { x: clamp(x1Pt / pageWidthPt), y: clamp(1 - y1Pt / pageHeightPt) },
    { x: clamp(x1Pt / pageWidthPt), y: clamp(1 - y0Pt / pageHeightPt) },
    { x: clamp(x0Pt / pageWidthPt), y: clamp(1 - y0Pt / pageHeightPt) },
  ];
}

function polygonPtToNorm(
  poly: { x: number; y: number }[],
  pageWidthPt: number,
  pageHeightPt: number,
): { x: number; y: number }[] {
  const clamp = (v: number) => Math.max(0.005, Math.min(0.995, v));
  return poly.map((p) => ({
    x: clamp(p.x / pageWidthPt),
    y: clamp(1 - p.y / pageHeightPt),
  }));
}

function bboxOfPoly(poly: { x: number; y: number }[]): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const p of poly) {
    if (p.x < xMin) xMin = p.x;
    if (p.y < yMin) yMin = p.y;
    if (p.x > xMax) xMax = p.x;
    if (p.y > yMax) yMax = p.y;
  }
  return { x: xMin, y: yMin, width: xMax - xMin, height: yMax - yMin };
}

function pointInPolygon(
  p: { x: number; y: number },
  poly: { x: number; y: number }[],
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Strategy A — dim table
// ---------------------------------------------------------------------------

interface DimTableMatch {
  rows: DimRow[];
  tableBox: { x0: number; y0: number; x1: number; y1: number } | null;
}

/**
 * Pair every dimension fragment with the nearest left-side text-fragment
 * in the same row. Returns one DimRow per pairing, plus the bbox of the
 * detected dim-table cluster (which the anchor step must avoid).
 */
function findDimRows(
  fragments: RawTextFragment[],
  pageWidthPt: number,
  pageHeightPt: number,
): DimTableMatch {
  const tableBox = detectDimTableBox(fragments, pageWidthPt, pageHeightPt);
  const rows: DimRow[] = [];
  const ROW_TOLERANCE = 5; // pt — within one text line
  for (const f of fragments) {
    const dims = parseDim(f.text);
    if (!dims) continue;
    // Find the nearest left-side text fragment within the same row.
    let bestLabel: RawTextFragment | null = null;
    let bestDx = Infinity;
    for (const g of fragments) {
      if (g === f) continue;
      if (parseDim(g.text) !== null) continue;
      if (isHeaderFragment(g.text)) continue;
      if (Math.abs(g.yPt - f.yPt) > ROW_TOLERANCE) continue;
      if (g.xPt >= f.xPt) continue;
      const dx = f.xPt - (g.xPt + g.widthPt);
      if (dx >= 0 && dx < bestDx) {
        bestDx = dx;
        bestLabel = g;
      }
    }
    if (!bestLabel) continue;
    rows.push({
      label: bestLabel.text.trim(),
      labelFragment: bestLabel,
      dimFragment: f,
      widthFt: dims.widthFt,
      heightFt: dims.heightFt,
      areaSqft: round1(dims.widthFt * dims.heightFt),
    });
  }
  // De-dup by label (first-seen wins).
  const seen = new Set<string>();
  const deduped = rows.filter((r) => {
    const k = r.label.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { rows: deduped, tableBox };
}

/**
 * Find the room label fragment that sits ON THE PLAN (not on the dim
 * table) for a given dim row. Returns null if no in-plan placement is
 * available — caller must then tag the room as `table-only`.
 */
function findInPlanLabelFor(
  row: DimRow,
  allFragments: RawTextFragment[],
  tableBox: { x0: number; y0: number; x1: number; y1: number } | null,
  pageWidthPt: number,
  pageHeightPt: number,
): RawTextFragment | null {
  const normRow = normalizeLabel(row.label);
  if (!normRow) return null;
  // Strict equality after normalization — must match the label exactly.
  const candidates = allFragments.filter((f) => {
    if (f === row.labelFragment) return false;
    return normalizeLabel(f.text) === normRow;
  });
  for (const c of candidates) {
    if (tableBox && isInsideBox(c, tableBox)) continue;
    if (isInMarginOrBlock(c, pageWidthPt, pageHeightPt)) continue;
    return c;
  }
  return null;
}

function isInsideBox(
  f: RawTextFragment,
  box: { x0: number; y0: number; x1: number; y1: number },
): boolean {
  // Use the fragment's center.
  const cx = f.xPt + f.widthPt / 2;
  const cy = f.yPt + f.heightPt / 2;
  return cx >= box.x0 && cx <= box.x1 && cy >= box.y0 && cy <= box.y1;
}

/**
 * Reject anchors that fall in the page's outer 4% strip on any side —
 * those are title-block / margin territory regardless of orientation.
 */
function isInMarginOrBlock(
  f: RawTextFragment,
  pageWidthPt: number,
  pageHeightPt: number,
): boolean {
  const xn = (f.xPt + f.widthPt / 2) / pageWidthPt;
  const yn = (f.yPt + f.heightPt / 2) / pageHeightPt;
  if (xn < 0.02 || xn > 0.98) return true;
  if (yn < 0.02 || yn > 0.98) return true;
  return false;
}

function normalizeLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/**
 * VISUAL-ONLY sizing fallback for Strategy A "sized-from-dimensions"
 * rectangles. This is used ONLY to draw a placeholder rectangle of the
 * right RELATIVE size on the plan when no real scale exists — the
 * measurement values (widthFt × heightFt × areaSqft) come from the
 * printed table verbatim and are NOT derived from this estimate.
 *
 * The brief explicitly forbids inventing a scale for measurement.
 * This function is allowed because it doesn't produce a measurement —
 * it produces a rendering hint that the contractor can visually verify
 * against the labelled room next door.
 */
function sizingPtPerFtForRectangles(
  rows: DimRow[],
  scan: VectorScan,
  pageWidthPt: number,
  pageHeightPt: number,
): number | null {
  const totalFloorAreaSqft = rows.reduce(
    (acc, r) => acc + r.widthFt * r.heightFt,
    0,
  );
  if (totalFloorAreaSqft <= 0) return null;

  let planAreaPt2: number;
  if (
    scan.segmentBboxPt &&
    scan.segmentBboxPt.x1 > scan.segmentBboxPt.x0 &&
    scan.segmentBboxPt.y1 > scan.segmentBboxPt.y0
  ) {
    const w = scan.segmentBboxPt.x1 - scan.segmentBboxPt.x0;
    const h = scan.segmentBboxPt.y1 - scan.segmentBboxPt.y0;
    planAreaPt2 = w * h;
  } else {
    planAreaPt2 = pageWidthPt * pageHeightPt * 0.7;
  }
  const FILL_RATIO = 0.6;
  const ptPerFt = Math.sqrt((planAreaPt2 * FILL_RATIO) / totalFloorAreaSqft);
  if (!Number.isFinite(ptPerFt) || ptPerFt <= 0) return null;
  return ptPerFt;
}

function polygonPerimeterPt(poly: { x: number; y: number }[]): number {
  if (poly.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    sum += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return sum;
}

function polygonAreaPt2(poly: { x: number; y: number }[]): number {
  if (poly.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Keywords that almost certainly name an actual habitable room. A label
// that matches this AND ends up paired with a tiny face is the "sliver"
// failure mode — drop it rather than report a 6×3 ft "LIVING ROOM".
const REAL_ROOM_KW =
  /\b(LIVING|KITCHEN|BEDROOM|MASTER|DINING|FAMILY|GREAT|FOYER|ENTRY|HALL|HALLWAY|CORRIDOR|OFFICE|DEN|STUDY|NOOK|MEDIA|BONUS|REC|RECREATION|GUEST|PLAYROOM|BATH|BATHROOM|RESTROOM|TOILET|POWDER|LAUNDRY|MUDROOM|MUD|LOBBY|RECEPTION|STAFF|PATIENT|EXAM|CONF|LOUNGE|PORCH|DECK|PATIO|BALCONY|GARAGE|SUNROOM|BREAKFAST|MORNING|SHOP|BASEMENT|ATTIC|CELLAR)\b/i;

function hasRealRoomKeyword(label: string): boolean {
  return REAL_ROOM_KW.test(label);
}

/**
 * Minimum plausible floor area in square feet, by room-type keyword.
 * Below this, a matched face is almost certainly a sliver inside the
 * real room (around furniture or a partition wall), not the room itself.
 *
 * The thresholds are conservative — a small bathroom can be 25 sqft;
 * a closet 12 sqft. Returns 0 when no room-keyword is recognised.
 */
function minPlausibleSqftForLabel(label: string): number {
  const t = label.toUpperCase();
  if (/\b(LIVING|MASTER|GREAT|FAMILY|REC|RECREATION|MEDIA|BONUS|GUEST|PLAYROOM|GARAGE|SHOP|LOBBY|BASEMENT)\b/.test(t))
    return 80;
  if (/\b(KITCHEN|DINING|BEDROOM|DEN|STUDY|OFFICE|LOUNGE|SUNROOM|BREAKFAST|MORNING|CONF|EXAM)\b/.test(t))
    return 60;
  if (/\b(NOOK|MUDROOM|MUD|LAUNDRY|FOYER|ENTRY|RECEPTION|STAFF|PATIENT)\b/.test(t))
    return 30;
  if (/\b(BATH|BATHROOM|RESTROOM|POWDER|CLOSET|TOILET|HALL|HALLWAY|CORRIDOR|VESTIBULE|ATTIC|CELLAR)\b/.test(t))
    return 15;
  if (/\b(PORCH|DECK|PATIO|BALCONY)\b/.test(t)) return 18;
  return 0;
}

/**
 * Find printed-dimension callouts whose values cross-validate the
 * extracted bbox. The picker is intentionally STRICT:
 *
 *   1. Search a tight radius (100 pt) around the label — wider sweeps
 *      pick up overall-building dims and the next room's callouts.
 *   2. Require a callout whose value matches the bbox extent in its
 *      axis within ±30 %. A 16-ft bbox-width that happens to sit next
 *      to a 24-ft callout (the house width) doesn't qualify.
 *   3. Orientation comes from text rotation. When unavailable, position
 *      relative to the label is the fall-back: callouts above/below
 *      measure horizontal walls (room WIDTH); side callouts measure
 *      vertical walls (room HEIGHT).
 *
 * The picker is a cross-check, NOT a hallucinator. It refuses to
 * synthesize dimensions when its conditions aren't met — the caller
 * then falls back to the bbox-derived dims or to geometry-uncertain.
 */
function pickWidthHeightFromCallouts(
  callouts: DimensionCallout[],
  labelCenter: { x: number; y: number },
  bboxHintPt: { width: number; height: number } | null,
  ptPerFt: number,
): { widthFt: number; heightFt: number } | null {
  const radiusPt = 100;
  const local = callouts.filter((c) => {
    if (c.lengthFt < 3 || c.lengthFt > 60) return false;
    const dx = c.x - labelCenter.x;
    const dy = c.y - labelCenter.y;
    return dx * dx + dy * dy <= radiusPt * radiusPt;
  });
  if (local.length < 2) return null;

  let horCallouts = local.filter((c) => c.orientation === "h");
  let verCallouts = local.filter((c) => c.orientation === "v");

  // Position-based fallback for renderers that strip rotation.
  if (horCallouts.length === 0 || verCallouts.length === 0) {
    for (const c of local) {
      if (c.orientation === "h" || c.orientation === "v") continue;
      const dx = Math.abs(c.x - labelCenter.x);
      const dy = Math.abs(c.y - labelCenter.y);
      if (dy > dx) horCallouts.push(c);
      else verCallouts.push(c);
    }
  }
  if (horCallouts.length === 0 || verCallouts.length === 0) return null;

  // Without a bbox hint we can't disambiguate which callout names the
  // room — refuse to guess.
  if (!bboxHintPt) return null;

  const bboxWFt = bboxHintPt.width / ptPerFt;
  const bboxHFt = bboxHintPt.height / ptPerFt;
  const tol = 0.30;

  function bestMatch(
    list: DimensionCallout[],
    targetFt: number,
  ): DimensionCallout | null {
    let best: DimensionCallout | null = null;
    let bestErr = tol;
    for (const c of list) {
      const err = Math.abs(c.lengthFt - targetFt) / Math.max(1, targetFt);
      if (err <= bestErr) {
        bestErr = err;
        best = c;
      }
    }
    return best;
  }

  const h = bestMatch(horCallouts, bboxWFt);
  const v = bestMatch(verCallouts, bboxHFt);
  if (h && v) {
    return { widthFt: h.lengthFt, heightFt: v.lengthFt };
  }
  return null;
}

/**
 * Run Strategy A — dim-table placement. May still produce traced rooms
 * when a planar-graph face matches a table row's label position.
 *
 * When `establishedPtPerFt` is provided (real scale from notation, bar
 * or user calibration), each traced face is cross-checked: if the
 * scale-measured polygon area lands within ±10 % of the table's
 * `widthFt × heightFt`, the row is tagged `table-cross-checked`. When
 * they disagree, the row keeps the table value (architect's number) but
 * is tagged `traced` with a `measurementWarning`.
 *
 * When `establishedPtPerFt` is null, we still draw "sized-from-
 * dimensions" rectangles using an internal-only rendering hint
 * (sizingPtPerFtForRectangles). That hint never becomes a reported
 * measurement.
 */
function runStrategyA(
  fragments: RawTextFragment[],
  scan: VectorScan,
  pageWidthPt: number,
  pageHeightPt: number,
  establishedPtPerFt: number | null,
): {
  rooms: ExtractedRoom[];
  faceCount: number;
} | null {
  const { rows, tableBox } = findDimRows(fragments, pageWidthPt, pageHeightPt);
  if (rows.length < 2) return null;

  // Try to enumerate faces from whatever wall geometry we have, so a
  // room with a real face still gets a `traced` polygon. Faces are
  // optional — strategy A works without them via the sized fallback.
  const faces = scan.walls.length >= 4
    ? detectRooms(scan.walls, pageWidthPt, pageHeightPt, {
        snapTolerance: 1.5,
        minRoomArea: 800,
        maxRoomArea: 0.85 * pageWidthPt * pageHeightPt,
        maxAspectRatio: 30,
        maxVertices: 80,
        maxDoorGap: 60,
        doorCandidates: scan.doorCandidates,
        doorMatchRadius: 30,
      })
    : [];

  // Sizing hint for "sized-from-dimensions" rectangles. NOT a real
  // measurement — only used to draw a placeholder of the right relative
  // size when there's no real scale. Real measurement (widthFt etc.)
  // comes from the table verbatim, then optionally cross-checked
  // against the polygon when establishedPtPerFt is non-null.
  const sizingPtPerFt =
    establishedPtPerFt ?? sizingPtPerFtForRectangles(rows, scan, pageWidthPt, pageHeightPt);

  const rooms: ExtractedRoom[] = [];
  for (const row of rows) {
    const inPlanLabel = findInPlanLabelFor(
      row,
      fragments,
      tableBox,
      pageWidthPt,
      pageHeightPt,
    );

    // 1. Best case: in-plan label sits inside a planar-graph face.
    if (inPlanLabel && faces.length > 0) {
      const face = findEnclosingFace(
        { x: inPlanLabel.xPt + inPlanLabel.widthPt / 2, y: inPlanLabel.yPt + inPlanLabel.heightPt / 2 },
        faces,
      );
      if (face) {
        const polygonNorm = polygonPtToNorm(face.polygon, pageWidthPt, pageHeightPt);
        const bboxPt = {
          x: face.bbox.x0,
          y: face.bbox.y0,
          width: face.bbox.x1 - face.bbox.x0,
          height: face.bbox.y1 - face.bbox.y0,
        };

        // Default to the table values; cross-check when scale is real.
        let derivation: Derivation = "traced";
        let measurementWarning: string | undefined;
        if (establishedPtPerFt !== null && establishedPtPerFt > 0) {
          const polyArea = polygonAreaPt2(face.polygon);
          const scaleAreaSqft =
            polyArea / (establishedPtPerFt * establishedPtPerFt);
          const tableAreaSqft = row.widthFt * row.heightFt;
          if (tableAreaSqft > 0) {
            const ratio = scaleAreaSqft / tableAreaSqft;
            if (ratio >= 0.9 && ratio <= 1.1) {
              derivation = "table-cross-checked";
            } else {
              const pct = Math.round((ratio - 1) * 100);
              measurementWarning =
                `Table says ${row.widthFt}×${row.heightFt}' = ${round1(tableAreaSqft)} sqft, ` +
                `scale-measured polygon = ${round1(scaleAreaSqft)} sqft (${pct >= 0 ? "+" : ""}${pct}%). ` +
                `Using the printed table.`;
              derivation = "traced";
            }
          }
        }

        rooms.push({
          label: row.label,
          bboxPt,
          polygonNorm,
          widthFt: row.widthFt,
          heightFt: row.heightFt,
          areaSqft: row.areaSqft,
          perimeterFt:
            establishedPtPerFt !== null && establishedPtPerFt > 0
              ? round1(polygonPerimeterPt(face.polygon) / establishedPtPerFt)
              : round1(2 * (row.widthFt + row.heightFt)),
          tableWidthFt: row.widthFt,
          tableHeightFt: row.heightFt,
          tableAreaSqft: row.areaSqft,
          measurementWarning,
          derivation,
        });
        continue;
      }
    }

    // 2. Sized rectangle from real dimensions, anchored to label.
    if (inPlanLabel && sizingPtPerFt !== null) {
      const widthPt = row.widthFt * sizingPtPerFt;
      const heightPt = row.heightFt * sizingPtPerFt;
      const cxPt = inPlanLabel.xPt + inPlanLabel.widthPt / 2;
      const cyPt = inPlanLabel.yPt + inPlanLabel.heightPt / 2;
      const polygonNorm = rectPolygonNorm(
        cxPt,
        cyPt,
        widthPt,
        heightPt,
        pageWidthPt,
        pageHeightPt,
      );
      rooms.push({
        label: row.label,
        bboxPt: {
          x: cxPt - widthPt / 2,
          y: cyPt - heightPt / 2,
          width: widthPt,
          height: heightPt,
        },
        polygonNorm,
        widthFt: row.widthFt,
        heightFt: row.heightFt,
        areaSqft: row.areaSqft,
        perimeterFt: round1(2 * (row.widthFt + row.heightFt)),
        tableWidthFt: row.widthFt,
        tableHeightFt: row.heightFt,
        tableAreaSqft: row.areaSqft,
        derivation: "sized-from-dimensions",
      });
      continue;
    }

    // 3. Measurement known but no reliable placement → no polygon.
    rooms.push({
      label: row.label,
      bboxPt: null,
      polygonNorm: [],
      widthFt: row.widthFt,
      heightFt: row.heightFt,
      areaSqft: row.areaSqft,
      perimeterFt: round1(2 * (row.widthFt + row.heightFt)),
      tableWidthFt: row.widthFt,
      tableHeightFt: row.heightFt,
      tableAreaSqft: row.areaSqft,
      derivation: "table-only",
    });
  }

  return { rooms, faceCount: faces.length };
}

function findEnclosingFace(
  pointPt: { x: number; y: number },
  faces: RoomFace[],
): RoomFace | null {
  let best: RoomFace | null = null;
  for (const f of faces) {
    if (!pointInPolygon(pointPt, f.polygon)) continue;
    if (!best || f.area < best.area) best = f;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Strategy B — vector geometry
// ---------------------------------------------------------------------------

interface ClusteredLabel {
  text: string;
  /** Centroid of the cluster in PDF pt, y-up. */
  cxPt: number;
  cyPt: number;
  /** Bbox of the cluster (union of fragment bboxes). */
  x0Pt: number;
  y0Pt: number;
  x1Pt: number;
  y1Pt: number;
}

/**
 * Cluster room-like fragments that sit within 25 pt of each other —
 * merges multi-line labels like "DINING / KITCHEN" or "1 Bedroom + Den"
 * while keeping adjacent rooms separate (typically >30 pt apart).
 */
function clusterRoomLabels(fragments: RawTextFragment[]): ClusteredLabel[] {
  const labels = fragments.filter((f) => isRoomLikeLabel(f.text));
  if (labels.length === 0) return [];
  const CLUSTER_DIST_SQ = 25 * 25;
  const parent = labels.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    let n = i;
    while (parent[n] !== r) {
      const next = parent[n];
      parent[n] = r;
      n = next;
    }
    return r;
  };
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const dx = labels[i].xPt - labels[j].xPt;
      const dy = labels[i].yPt - labels[j].yPt;
      if (dx * dx + dy * dy <= CLUSTER_DIST_SQ) {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[a] = b;
      }
    }
  }
  const groups = new Map<number, RawTextFragment[]>();
  for (let i = 0; i < labels.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(labels[i]);
  }
  const out: ClusteredLabel[] = [];
  for (const grp of groups.values()) {
    let cx = 0;
    let cy = 0;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const f of grp) {
      cx += f.xPt + f.widthPt / 2;
      cy += f.yPt + f.heightPt / 2;
      if (f.xPt < x0) x0 = f.xPt;
      if (f.yPt < y0) y0 = f.yPt;
      if (f.xPt + f.widthPt > x1) x1 = f.xPt + f.widthPt;
      if (f.yPt + f.heightPt > y1) y1 = f.yPt + f.heightPt;
    }
    // Sort fragments top-to-bottom (PDF y-up: higher y = higher on page)
    // then left-to-right so the joined label reads naturally.
    grp.sort((a, b) => (b.yPt - a.yPt) || (a.xPt - b.xPt));
    out.push({
      text: grp.map((f) => f.text.trim()).join(" "),
      cxPt: cx / grp.length,
      cyPt: cy / grp.length,
      x0Pt: x0,
      y0Pt: y0,
      x1Pt: x1,
      y1Pt: y1,
    });
  }
  return out;
}

/**
 * Match a clustered label to a planar-graph face, in three passes:
 *   1. Smallest face whose polygon strictly encloses the label centroid.
 *   2. Smallest face whose polygon encloses any corner of the label bbox.
 *   3. Smallest face whose bbox center is within `searchRadiusPt` of the
 *      label centroid (handles labels printed on the wall line or just
 *      outside the face boundary, common on LOFT-style plans).
 */
function matchLabelToFace(
  label: ClusteredLabel,
  faces: RoomFace[],
  excluded: Set<number>,
  searchRadiusPt: number,
): { idx: number; face: RoomFace } | null {
  // Pass 1: centroid inside.
  let best: { idx: number; face: RoomFace } | null = null;
  for (let i = 0; i < faces.length; i++) {
    if (excluded.has(i)) continue;
    if (!pointInPolygon({ x: label.cxPt, y: label.cyPt }, faces[i].polygon)) {
      continue;
    }
    if (!best || faces[i].area < best.face.area) {
      best = { idx: i, face: faces[i] };
    }
  }
  if (best) return best;

  // Pass 2: any corner inside.
  const corners = [
    { x: label.x0Pt, y: label.y0Pt },
    { x: label.x1Pt, y: label.y0Pt },
    { x: label.x0Pt, y: label.y1Pt },
    { x: label.x1Pt, y: label.y1Pt },
  ];
  for (let i = 0; i < faces.length; i++) {
    if (excluded.has(i)) continue;
    if (!corners.some((c) => pointInPolygon(c, faces[i].polygon))) continue;
    if (!best || faces[i].area < best.face.area) {
      best = { idx: i, face: faces[i] };
    }
  }
  if (best) return best;

  // Pass 3: nearest face bbox center within radius.
  let bestDistSq = searchRadiusPt * searchRadiusPt;
  for (let i = 0; i < faces.length; i++) {
    if (excluded.has(i)) continue;
    const fcx = (faces[i].bbox.x0 + faces[i].bbox.x1) / 2;
    const fcy = (faces[i].bbox.y0 + faces[i].bbox.y1) / 2;
    const dx = fcx - label.cxPt;
    const dy = fcy - label.cyPt;
    const dSq = dx * dx + dy * dy;
    if (dSq > bestDistSq) continue;
    bestDistSq = dSq;
    best = { idx: i, face: faces[i] };
  }
  return best;
}

/**
 * Cast four axis-aligned rays from the label bbox and find the
 * nearest meaningful wall hit in each direction. "Meaningful" means:
 *
 *   - The wall segment is at least `minWallLen` pt long (filters out
 *     furniture details, door swings, hatching).
 *   - The wall sits at least `minClearance` pt outside the label's
 *     bbox (filters out furniture lines drawn snugly around the
 *     label text — sofa edges, counter outlines, etc.).
 *
 * Returns the axis-aligned rectangle in PDF user space, or null when
 * fewer than two boundaries hit (label likely sits outside the plan
 * drawing area).
 */
function roomBoundsFromRays(
  labelBbox: { x0: number; y0: number; x1: number; y1: number },
  walls: { x1: number; y1: number; x2: number; y2: number }[],
  pageWidthPt: number,
  pageHeightPt: number,
  options: {
    minSide: number;
    maxSide: number;
    minWallLen: number;
    minClearance: number;
  },
): { x: number; y: number; width: number; height: number } | null {
  let topY = pageHeightPt;
  let bottomY = 0;
  let leftX = 0;
  let rightX = pageWidthPt;
  let hitTop = false;
  let hitBottom = false;
  let hitLeft = false;
  let hitRight = false;

  const cx = (labelBbox.x0 + labelBbox.x1) / 2;
  const cy = (labelBbox.y0 + labelBbox.y1) / 2;

  for (const w of walls) {
    const isHorizontal = w.y1 === w.y2;
    const isVertical = w.x1 === w.x2;
    if (isHorizontal) {
      const wx0 = Math.min(w.x1, w.x2);
      const wx1 = Math.max(w.x1, w.x2);
      const len = wx1 - wx0;
      if (len < options.minWallLen) continue;
      if (cx < wx0 || cx > wx1) continue;
      const wy = w.y1;
      if (wy > labelBbox.y1 + options.minClearance && wy < topY) {
        topY = wy;
        hitTop = true;
      } else if (wy < labelBbox.y0 - options.minClearance && wy > bottomY) {
        bottomY = wy;
        hitBottom = true;
      }
    } else if (isVertical) {
      const wy0 = Math.min(w.y1, w.y2);
      const wy1 = Math.max(w.y1, w.y2);
      const len = wy1 - wy0;
      if (len < options.minWallLen) continue;
      if (cy < wy0 || cy > wy1) continue;
      const wx = w.x1;
      if (wx > labelBbox.x1 + options.minClearance && wx < rightX) {
        rightX = wx;
        hitRight = true;
      } else if (wx < labelBbox.x0 - options.minClearance && wx > leftX) {
        leftX = wx;
        hitLeft = true;
      }
    }
  }
  const hits = [hitTop, hitBottom, hitLeft, hitRight].filter(Boolean).length;
  if (hits < 2) return null;
  const width = rightX - leftX;
  const height = topY - bottomY;
  if (width < options.minSide || height < options.minSide) return null;
  if (width > options.maxSide || height > options.maxSide) return null;
  return { x: leftX, y: bottomY, width, height };
}

function runStrategyB(
  fragments: RawTextFragment[],
  scan: VectorScan,
  pageWidthPt: number,
  pageHeightPt: number,
  ptPerFt: number | null,
  callouts: DimensionCallout[],
): { rooms: ExtractedRoom[]; faceCount: number } | null {
  if (scan.walls.length < 8) return null;
  const derivationForGeometry: Derivation =
    ptPerFt !== null && ptPerFt > 0 ? "scale-measured" : "scale-needed";

  function measure(
    polyPt: { x: number; y: number }[],
    bbox: { x: number; y: number; width: number; height: number },
  ): Pick<ExtractedRoom, "widthFt" | "heightFt" | "areaSqft" | "perimeterFt"> {
    if (ptPerFt === null || ptPerFt <= 0) {
      return { widthFt: null, heightFt: null, areaSqft: null, perimeterFt: null };
    }
    const widthFt = round1(bbox.width / ptPerFt);
    const heightFt = round1(bbox.height / ptPerFt);
    const polyAreaSqft = polygonAreaPt2(polyPt) / (ptPerFt * ptPerFt);
    const perimeterFt = round1(polygonPerimeterPt(polyPt) / ptPerFt);
    return {
      widthFt,
      heightFt,
      areaSqft: round1(polyAreaSqft),
      perimeterFt,
    };
  }

  // Reconcile a raw geometry measurement with printed dimension callouts
  // (the architect's own numbers on the plan). When callouts exist near
  // the room's label, they OVERRIDE the bbox-derived dims — open-plan
  // homes where walls don't fully enclose make tracing unreliable, but
  // the printed "17'-0\" × 11'-6\"" is ground truth.
  //
  // When no callout exists AND the extracted face is implausibly small
  // for a real room (sliver inside the room around furniture / partition
  // walls), we DROP the measurement and tag `geometry-uncertain`. A
  // sliver number presented as confident is worse than no number at all.
  function applyCalloutsAndSliverCheck(
    label: string,
    labelCenter: { x: number; y: number },
    bboxHintPt: { width: number; height: number } | null,
    base: Pick<
      ExtractedRoom,
      "widthFt" | "heightFt" | "areaSqft" | "perimeterFt"
    >,
  ): {
    widthFt: number | null;
    heightFt: number | null;
    areaSqft: number | null;
    perimeterFt: number | null;
    derivation: Derivation;
    measurementWarning?: string;
  } {
    if (ptPerFt === null || ptPerFt <= 0) {
      return { ...base, derivation: "scale-needed" };
    }

    const picked = pickWidthHeightFromCallouts(
      callouts,
      labelCenter,
      bboxHintPt,
      ptPerFt,
    );
    if (picked) {
      const areaSqft = round1(picked.widthFt * picked.heightFt);
      const perimeterFt = round1(2 * (picked.widthFt + picked.heightFt));
      const baseArea = base.areaSqft ?? 0;
      const disagreement =
        baseArea > 0 ? Math.abs(areaSqft - baseArea) / baseArea : 0;
      let measurementWarning: string | undefined;
      if (baseArea > 0 && disagreement > 0.25) {
        measurementWarning =
          `Extracted boundary suggested ${baseArea.toFixed(0)} sqft, but the printed callouts ` +
          `${picked.widthFt}'×${picked.heightFt}' say ${areaSqft.toFixed(0)} sqft. ` +
          `Using the architect's callouts.`;
      }
      return {
        widthFt: picked.widthFt,
        heightFt: picked.heightFt,
        areaSqft,
        perimeterFt,
        derivation: "scale-measured",
        measurementWarning,
      };
    }

    // No usable callouts. Aspect-ratio check: a 20:1 strip is never a
    // real room — it's an artifact of the keyword filter latching onto
    // a note or a single-wall dimension line. Drop it.
    if (
      base.widthFt !== null &&
      base.heightFt !== null &&
      base.widthFt > 0 &&
      base.heightFt > 0
    ) {
      const aspect =
        Math.max(base.widthFt, base.heightFt) /
        Math.min(base.widthFt, base.heightFt);
      if (aspect > 8) {
        return {
          widthFt: null,
          heightFt: null,
          areaSqft: null,
          perimeterFt: null,
          derivation: "geometry-uncertain",
          measurementWarning:
            `Found "${label}", but the extracted bounds (${base.widthFt}'×${base.heightFt}') ` +
            `are too skinny to be a real room. Likely a label on a wall callout ` +
            `or note, not a room.`,
        };
      }
    }

    // Sliver check: if the matched face is too small to be a real room
    // with this label, refuse to report it. Threshold varies by room
    // type (Living Room ≥ 80 sqft, Bath ≥ 15).
    const minSqft = minPlausibleSqftForLabel(label);
    if (
      base.areaSqft !== null &&
      minSqft > 0 &&
      base.areaSqft < minSqft
    ) {
      return {
        widthFt: null,
        heightFt: null,
        areaSqft: null,
        perimeterFt: null,
        derivation: "geometry-uncertain",
        measurementWarning:
          `Found "${label}" on the plan, but the extracted boundary is only ` +
          `${base.areaSqft.toFixed(0)} sqft — too small to be a real ${label.toLowerCase()} ` +
          `(typical minimum ${minSqft} sqft). Likely a partition or fixture ` +
          `inside the room, not the room itself. Enter the measurement ` +
          `manually or redraw the polygon.`,
      };
    }

    return { ...base, derivation: derivationForGeometry };
  }

  // Faces are still enumerated for diagnostics + a fallback path on
  // simple plans where the planar graph DOES close. Most LOFT-style
  // plans have too much furniture detail for this to fire reliably,
  // so the real boundary-finder is the ray-cast below.
  const faces = detectRooms(scan.walls, pageWidthPt, pageHeightPt, {
    snapTolerance: 1.5,
    minRoomArea: 1500,
    maxRoomArea: 0.85 * pageWidthPt * pageHeightPt,
    maxAspectRatio: 30,
    maxVertices: 80,
    maxDoorGap: 60,
    doorCandidates: scan.doorCandidates,
    doorMatchRadius: 30,
  });

  const clusters = clusterRoomLabels(fragments);
  if (clusters.length === 0) return null;

  // Sanity bounds — derived from the page, not hardcoded constants:
  // a room is at least 20 pt on a side and at most 40% of the smaller
  // page dimension. Captures everything from a small closet up to a
  // great-room without picking up the page border.
  const minSide = 20;
  const maxSide = Math.min(pageWidthPt, pageHeightPt) * 0.4;
  // Walls in vector floor plans are at least ~25 pt long (a 3 ft door
  // at 1/8":1' scale is 27 pt). Anything shorter is door swing arcs,
  // hatching, or fixture detail — not a room boundary.
  const minWallLen = 25;
  // Walls drawn around fixture/furniture symbols sit within ~12 pt of
  // the room label. Real room walls have at least this much clearance.
  const minClearance = 12;
  // Reject ray-cast bboxes that would span more than half the page —
  // a typical room is much smaller. A bbox that wide usually means
  // the label is in the header / margin and the rays escaped.
  const maxAreaFrac = 0.15;
  const maxArea = pageWidthPt * pageHeightPt * maxAreaFrac;

  const usedFaceIdx = new Set<number>();
  const usedBboxes: Array<{ x: number; y: number; width: number; height: number }> = [];

  function bboxesOverlap(
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number },
  ): boolean {
    return !(
      a.x + a.width <= b.x ||
      b.x + b.width <= a.x ||
      a.y + a.height <= b.y ||
      b.y + b.height <= a.y
    );
  }

  const rooms: ExtractedRoom[] = [];
  for (const lbl of clusters) {
    // 1. Try ray-casting from the label bbox. This is the primary
    //    boundary finder — it works on plans with open wall networks.
    //
    // We try the strict pass first (skip walls < 12 pt from the label
    // — those are fixture/furniture edges that crowd the label). If
    // the result is rejected by the sanity bounds, retry with a
    // looser clearance. This trades a little precision for recall on
    // plans that draw furniture flush against the label.
    let bbox = roomBoundsFromRays(
      { x0: lbl.x0Pt, y0: lbl.y0Pt, x1: lbl.x1Pt, y1: lbl.y1Pt },
      scan.walls,
      pageWidthPt,
      pageHeightPt,
      { minSide, maxSide, minWallLen, minClearance },
    );
    if (!bbox) {
      bbox = roomBoundsFromRays(
        { x0: lbl.x0Pt, y0: lbl.y0Pt, x1: lbl.x1Pt, y1: lbl.y1Pt },
        scan.walls,
        pageWidthPt,
        pageHeightPt,
        { minSide, maxSide, minWallLen, minClearance: 2 },
      );
    }
    if (bbox && bbox.width * bbox.height <= maxArea) {
      // Reject duplicates: another label already claimed this rectangle.
      const collides = usedBboxes.some((b) => {
        const ax = Math.max(bbox.x, b.x);
        const ay = Math.max(bbox.y, b.y);
        const bx = Math.min(bbox.x + bbox.width, b.x + b.width);
        const by = Math.min(bbox.y + bbox.height, b.y + b.height);
        if (bx <= ax || by <= ay) return false;
        const iou = ((bx - ax) * (by - ay)) /
          (bbox.width * bbox.height + b.width * b.height -
            (bx - ax) * (by - ay));
        return iou > 0.5;
      });
      if (!collides) {
        usedBboxes.push(bbox);
        const rectPolyPt: { x: number; y: number }[] = [
          { x: bbox.x, y: bbox.y },
          { x: bbox.x + bbox.width, y: bbox.y },
          { x: bbox.x + bbox.width, y: bbox.y + bbox.height },
          { x: bbox.x, y: bbox.y + bbox.height },
        ];
        const baseDims = measure(rectPolyPt, bbox);
        const reconciled = applyCalloutsAndSliverCheck(
          lbl.text,
          { x: lbl.cxPt, y: lbl.cyPt },
          { width: bbox.width, height: bbox.height },
          baseDims,
        );
        rooms.push({
          label: lbl.text,
          bboxPt: bbox,
          polygonNorm: rectPolygonNorm(
            bbox.x + bbox.width / 2,
            bbox.y + bbox.height / 2,
            bbox.width,
            bbox.height,
            pageWidthPt,
            pageHeightPt,
          ),
          widthFt: reconciled.widthFt,
          heightFt: reconciled.heightFt,
          areaSqft: reconciled.areaSqft,
          perimeterFt: reconciled.perimeterFt,
          derivation: reconciled.derivation,
          measurementWarning: reconciled.measurementWarning,
        });
        continue;
      }
    }

    // 2. Fallback: a planar-graph face that strictly encloses the label.
    if (faces.length > 0) {
      const m = matchLabelToFace(
        lbl,
        faces,
        usedFaceIdx,
        Math.min(pageWidthPt, pageHeightPt) * 0.04,
      );
      if (m) {
        // Skip face matches that overlap an existing bbox — those are
        // furniture/fixture slivers, not rooms.
        const faceBbox = {
          x: m.face.bbox.x0,
          y: m.face.bbox.y0,
          width: m.face.bbox.x1 - m.face.bbox.x0,
          height: m.face.bbox.y1 - m.face.bbox.y0,
        };
        const overlapsExisting = usedBboxes.some((b) => bboxesOverlap(faceBbox, b));
        if (!overlapsExisting) {
          usedFaceIdx.add(m.idx);
          usedBboxes.push(faceBbox);
          const baseDims = measure(m.face.polygon, faceBbox);
          const reconciled = applyCalloutsAndSliverCheck(
            lbl.text,
            { x: lbl.cxPt, y: lbl.cyPt },
            { width: faceBbox.width, height: faceBbox.height },
            baseDims,
          );
          rooms.push({
            label: lbl.text,
            bboxPt: faceBbox,
            polygonNorm: polygonPtToNorm(
              m.face.polygon,
              pageWidthPt,
              pageHeightPt,
            ),
            widthFt: reconciled.widthFt,
            heightFt: reconciled.heightFt,
            areaSqft: reconciled.areaSqft,
            perimeterFt: reconciled.perimeterFt,
            derivation: reconciled.derivation,
            measurementWarning: reconciled.measurementWarning,
          });
          continue;
        }
      }
    }

    // 3. Last resort: label found, but no geometry would lock down.
    //    Emit a geometry-uncertain entry IF the label is clearly a real
    //    room — better the estimator sees the room in the queue with a
    //    clear "needs measurement" badge than to silently drop it.
    //    (Pure callout-fallback without geometry is intentionally not
    //    attempted — without a bbox to cross-validate, picking the
    //    "right" callouts is unreliable.)
    if (hasRealRoomKeyword(lbl.text)) {
      rooms.push({
        label: lbl.text,
        bboxPt: null,
        polygonNorm: [],
        widthFt: null,
        heightFt: null,
        areaSqft: null,
        perimeterFt: null,
        derivation: "geometry-uncertain",
        measurementWarning:
          `Found "${lbl.text}" on the plan, but couldn't extract a reliable wall boundary or printed dimension. Set the measurement manually.`,
      });
    }
  }

  // ---------------------------------------------------------------
  // Virtual-partition fallback pass
  //
  // Runs ONLY when the main per-label loop produced at least one
  // geometry-uncertain entry for an actual room (open-plan rooms
  // whose walls don't enclose them). The pass computes virtual
  // partition lines from label positions + the partial wall network
  // that does exist, snaps them to real walls, and turns
  // geometry-uncertain rooms into virtual-partition rooms with
  // computed dimensions. It also re-emits "suspect peers" — rooms
  // whose ray-cast bbox geometrically contradicts the partition —
  // honestly tagged as estimated boundaries.
  //
  // Correctly enclosed rooms (whose existing measurement matches the
  // partition within 25 %) stay untouched. The brief's rule is
  // "don't touch a CORRECTLY measured room", not "never touch a
  // measured room".
  if (ptPerFt !== null && ptPerFt > 0) {
    const failed: FailedLabel[] = [];
    const claimed: ClaimedPeer[] = [];
    for (let i = 0; i < rooms.length; i++) {
      const r = rooms[i];
      if (!hasRealRoomKeyword(r.label)) continue;
      const id = `${i}:${r.label}`;
      // Look up the label's centroid in the original clusters.
      const cluster = clusters.find(
        (c) => normalizeLabel(c.text) === normalizeLabel(r.label),
      );
      if (!cluster) continue;
      if (r.derivation === "geometry-uncertain") {
        failed.push({
          id,
          text: r.label,
          cxPt: cluster.cxPt,
          cyPt: cluster.cyPt,
          roomsIndex: i,
        });
      } else if (r.bboxPt !== null) {
        claimed.push({
          id,
          text: r.label,
          cxPt: cluster.cxPt,
          cyPt: cluster.cyPt,
          bboxPt: r.bboxPt,
          areaSqft: r.areaSqft,
          roomsIndex: i,
        });
      }
    }

    if (failed.length > 0) {
      const partitionResults = virtualPartition({
        failed,
        claimed,
        walls: scan.walls,
        callouts,
        ptPerFt,
        pageWidthPt,
        pageHeightPt,
        segmentBboxPt: scan.segmentBboxPt,
        minPlausibleSqft: minPlausibleSqftForLabel,
      });

      for (const r of partitionResults) {
        const target = rooms[r.roomsIndex];
        if (!target) continue;
        rooms[r.roomsIndex] = {
          ...target,
          bboxPt: r.bboxPt,
          polygonNorm: rectPolygonNorm(
            r.bboxPt.x + r.bboxPt.width / 2,
            r.bboxPt.y + r.bboxPt.height / 2,
            r.bboxPt.width,
            r.bboxPt.height,
            pageWidthPt,
            pageHeightPt,
          ),
          widthFt: r.widthFt,
          heightFt: r.heightFt,
          areaSqft: r.areaSqft,
          perimeterFt: r.perimeterFt,
          derivation: "virtual-partition",
          measurementWarning: r.measurementWarning,
        };
      }
    }
  }

  return { rooms, faceCount: faces.length };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function extractPage(
  pdfBuffer: Buffer,
  pageNumber: number,
  options: ExtractPageOptions = {},
): Promise<ExtractedPage> {
  const t0 = Date.now();
  const [{ scan, pageWidthPt, pageHeightPt }, textResult] = await Promise.all([
    scanVectorPaths(pdfBuffer, pageNumber),
    extractTextFragments(pdfBuffer, pageNumber),
  ]);
  const fragments = textResult.fragments;

  // Parse dimension callouts ("17'-0\"", "11'-6\"" etc.) from the text
  // layer once. These are the architect's own numbers printed directly
  // on the plan — the most reliable measurement source on any plan
  // that has them. Strategy B uses them to override / ground the
  // geometry-derived dimensions and to surface real rooms when the
  // wall network is too open to enclose them.
  const callouts = parseDimensionCallouts(
    fragments.map((f) => ({
      text: f.text,
      x: f.xPt,
      y: f.yPt,
      rotation: f.rotation,
    })),
  );

  // Establish the page's scale up front. This drives every measurement
  // produced below; when it returns null, all geometry-derived measures
  // are reported as null with derivation `scale-needed`.
  const established = establishScale({
    fragments: fragments.map((f) => ({ text: f.text, x: f.xPt, y: f.yPt })),
    doorCandidates: scan.doorCandidates.map((d) => ({
      x: d.x,
      y: d.y,
      size: d.size,
    })),
    userScale: options.userScale ?? null,
  });
  const ptPerFt = established?.ptPerFoot ?? null;

  // Early skip: no usable signal at all → scanned/flattened.
  if (fragments.length < 3 && scan.pathOpCount < 80) {
    return {
      status: "skipped",
      reason: "no_text_layer",
      strategy: "none",
      rooms: [],
      pageWidthPt,
      pageHeightPt,
      establishedScale: established,
      diagnostics: {
        textFragmentCount: fragments.length,
        vectorPathOpCount: scan.pathOpCount,
        wallSegmentCount: scan.walls.length,
        planarFaceCount: 0,
        dimRowCount: 0,
        roomLikeLabelCount: 0,
        ptPerFt,
        elapsedMs: Date.now() - t0,
      },
    };
  }

  // Early skip: text has zero room-like labels → cover / amenities /
  // specifications page. Avoids billing the AI classifier for obvious
  // non-floor-plans.
  const roomLikeCount = fragments.filter((f) =>
    isRoomLikeLabel(f.text),
  ).length;
  if (roomLikeCount === 0) {
    return {
      status: "skipped",
      reason: "non_floor_plan",
      strategy: "none",
      rooms: [],
      pageWidthPt,
      pageHeightPt,
      establishedScale: established,
      diagnostics: {
        textFragmentCount: fragments.length,
        vectorPathOpCount: scan.pathOpCount,
        wallSegmentCount: scan.walls.length,
        planarFaceCount: 0,
        dimRowCount: 0,
        roomLikeLabelCount: 0,
        ptPerFt,
        elapsedMs: Date.now() - t0,
      },
    };
  }

  // Strategy A: dim table.
  const a = runStrategyA(fragments, scan, pageWidthPt, pageHeightPt, ptPerFt);
  if (a && a.rooms.length >= 2) {
    return {
      status: "ok",
      strategy: "table",
      rooms: a.rooms,
      pageWidthPt,
      pageHeightPt,
      establishedScale: established,
      diagnostics: {
        textFragmentCount: fragments.length,
        vectorPathOpCount: scan.pathOpCount,
        wallSegmentCount: scan.walls.length,
        planarFaceCount: a.faceCount,
        dimRowCount: a.rooms.length,
        roomLikeLabelCount: roomLikeCount,
        ptPerFt,
        elapsedMs: Date.now() - t0,
      },
    };
  }

  // Strategy B: vector geometry, with callouts as the ground-truth
  // overlay for room dimensions.
  const b = runStrategyB(
    fragments,
    scan,
    pageWidthPt,
    pageHeightPt,
    ptPerFt,
    callouts,
  );
  if (b && b.rooms.length >= 1) {
    return {
      status: "ok",
      strategy: "vector",
      rooms: b.rooms,
      pageWidthPt,
      pageHeightPt,
      establishedScale: established,
      diagnostics: {
        textFragmentCount: fragments.length,
        vectorPathOpCount: scan.pathOpCount,
        wallSegmentCount: scan.walls.length,
        planarFaceCount: b.faceCount,
        dimRowCount: 0,
        roomLikeLabelCount: roomLikeCount,
        ptPerFt,
        elapsedMs: Date.now() - t0,
      },
    };
  }

  // Neither strategy produced usable rooms.
  return {
    status: "skipped",
    reason: "low_geometry",
    strategy: "none",
    rooms: [],
    pageWidthPt,
    pageHeightPt,
    establishedScale: established,
    diagnostics: {
      textFragmentCount: fragments.length,
      vectorPathOpCount: scan.pathOpCount,
      wallSegmentCount: scan.walls.length,
      planarFaceCount: 0,
      dimRowCount: 0,
      roomLikeLabelCount: roomLikeCount,
      ptPerFt,
      elapsedMs: Date.now() - t0,
    },
  };
}
