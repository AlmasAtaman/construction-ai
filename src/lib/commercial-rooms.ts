/**
 * Commercial-plan room identification — the deterministic room-finder.
 *
 * Combines four signals to produce a list of room candidates with
 * positions, polygons, and confidence scores:
 *
 *   1. Vector walls from MuPDF (axis-aligned segments + door arcs/panels)
 *   2. Image walls from rasterized PDF backgrounds (Canny-lite run-length)
 *   3. Text labels from pdfjs (room names + numbers + codes)
 *   4. Planar-graph faces (closed wall-bounded regions)
 *
 * Each emitted candidate ties a text label to a geometric region. The
 * caller uses these to:
 *   - Set `source='vector'` on AI-detected surfaces that match
 *   - Cross-check AI areas (flag when AI and vector disagree)
 *   - Bootstrap room enumeration on dense plans where the AI misses some
 *
 * Honest accuracy on the VA Building 28 benchmark:
 *   - 9/9 GT rooms IDENTIFIED (label → region match: 100%)
 *   - Areas: 2/9 within ±10% of truth, the rest variable due to partial
 *     wall coverage. Best-effort area is reported but the caller should
 *     prefer the AI's per-room measurement when confidence is low.
 *
 * Coordinate system: PDF user space (Y up, origin bottom-left).
 */

import { detectRooms, type RoomFace } from "./planar-graph";
import { detectWallsFromImage } from "./image-walls";
import { detectScaleAnchor, type ScaleAnchor } from "./scale-anchor";
import {
  parseDimensionCallouts,
  calloutsForRoom,
  roomDimensionsFromCallouts,
  type DimensionCallout,
} from "./dimension-callouts";

export interface RoomCandidate {
  /** Human-readable label drawn from the text layer (e.g., "CORRIDOR CE-3"). */
  label: string;
  /** Centroid of the label cluster in PDF page space. */
  x: number;
  y: number;
  /** Bounding box of the geometric region paired with this label. */
  bbox: { x: number; y: number; width: number; height: number };
  /** Region polygon in page space (Y up). May be a bbox-rectangle for image-derived rooms. */
  polygon: { x: number; y: number }[];
  /** Region area in PDF points². Use the page's scale to convert to sqft. */
  areaPt: number;
  /**
   * Deterministic floor area in square feet, when we have enough
   * data to compute it. Null when we don't (caller falls back to AI).
   */
  areaSqft: number | null;
  /** Room width and height in feet, when computable. */
  widthFt: number | null;
  heightFt: number | null;
  /** How `areaSqft` was derived. */
  measurementSource:
    | "callouts" // printed dimension callouts (architect's numbers — best)
    | "mixed" // one axis from callouts, other from geometry+scale
    | "geometry+scale" // bbox in pt → ft via scale anchor
    | "none"; // no measurement; defer to AI
  /** Dimension callouts found inside/near this room (debug + verification). */
  callouts: DimensionCallout[];
  /**
   * Confidence 0..1. Heuristic combining wall coverage, single-label
   * match, and region size sanity. The caller should default to AI
   * measurement when confidence < 0.6.
   */
  confidence: number;
  /** Provenance — which extraction step produced this candidate. */
  source: "planar-graph" | "voronoi" | "hybrid";
}

export interface CommercialRoomsResult {
  pageWidthPt: number;
  pageHeightPt: number;
  candidates: RoomCandidate[];
  /**
   * Scale anchor parsed from the page's text layer (e.g., 1/8" = 1'-0").
   * Null if no scale notation was found. When present, every pt
   * measurement converts to feet deterministically.
   */
  scaleAnchor: ScaleAnchor | null;
  /** All dimension callouts parsed from the text layer. */
  dimensionCallouts: DimensionCallout[];
  /** Vector wall segments extracted. */
  vectorWallCount: number;
  /** Image-derived wall segments extracted. */
  imageWallCount: number;
  /** Door candidates found in the vector layer. */
  doorCandidateCount: number;
  /** Planar-graph faces enumerated. */
  faceCount: number;
  elapsedMs: number;
}

export interface ExtractOptions {
  /** Skip image-based wall detection (faster, less accurate). Default false. */
  skipImageWalls?: boolean;
  /** Render DPI for image-wall detection. Default 150. */
  imageWallDpi?: number;
  /** Door-symbol match radius in pt for gap closure. Default 60. */
  doorMatchRadius?: number;
  /**
   * Run AI-vision OCR (Haiku) to extract dimension callouts that are
   * printed on the rasterized portion of the PDF. Costs ~$0.02-0.05
   * per page depending on tile count. Off by default; opt-in for
   * commercial plans with raster backgrounds where vector callouts
   * are scarce.
   */
  enableAiOcr?: boolean;
  /** Grid for AI-OCR tiling. Default 3x2. */
  aiOcrCols?: number;
  aiOcrRows?: number;
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

interface TextFragment {
  text: string;
  x: number;
  y: number;
  fontSize: number;
  width: number;
  height: number;
}

/** Label-shape heuristics (shared with the validation script). */
const ROOM_KW =
  /\b(ROOM|CORRIDOR|OFFICE|STAIR|ELEV|LOBBY|STORAGE|STORE|OXYGEN|BATH|RESTROOM|TOILET|MECH|ELECTRICAL|JANITOR|KITCHEN|LOCKER|VEST|LOUNGE|WAIT|PANTRY|CLOSET|UTILITY|SOIL|CLEAN|SOILED|LINEN|EXAM|CONF|RECEPTION|STAFF|PATIENT|NOURISH|ALCOVE|VESTIBULE|LINK|CONNECTING|VOLTAGE|VEND)\b/i;
const ROOM_NUM = /^[A-Z]{0,3}\s*\d{2,4}[A-Z]?$/i;
const ROOM_CODE = /^[A-Z]{1,3}-?\d{1,3}[A-Z]?$/i;
const EXCLUDE =
  /\b(SF|SQFT|TYP|DET|DETAIL|NOTE|NOTES|SEE|ALIGN|VIF|REF|SECTION|ELEVATION|PLAN|DRAWING|SHEET|SCALE|TITLE|STAMP|REVISION|PROJECT|ARCHITECT|ENGINEER|CONSULTANT|FINISH|SCHEDULE|GENERAL|LEGEND|KEY|SYMBOL|CODE|NAVIGATION|DEPARTMENT|VETERANS)\b/i;
const DIM_CALLOUT = /^\d+(['"’”′″]|\s*(SF|sqft))/;
const NOTE_BULLET = /^\d{1,2}\.$/;

function isLikelyRoomLabel(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  if (NOTE_BULLET.test(t)) return false;
  if (DIM_CALLOUT.test(t)) return false;
  if (EXCLUDE.test(t)) return false;
  if (ROOM_KW.test(t)) return true;
  if (ROOM_NUM.test(t)) return true;
  if (ROOM_CODE.test(t)) return true;
  return false;
}

/**
 * Cluster text fragments into a single "label seed" per room. Two
 * fragments cluster if they're within 25 pt — tight enough to keep
 * adjacent rooms separate (>30 pt apart), loose enough to merge a
 * stacked label like ROOM / 134A / 16 SF.
 */
function clusterLabels(
  frags: TextFragment[],
): { label: string; x: number; y: number; fontSize: number }[] {
  const CLUSTER_DIST = 25;
  const distSq = CLUSTER_DIST * CLUSTER_DIST;
  const parent = frags.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) {
      const n = parent[i];
      parent[i] = r;
      i = n;
    }
    return r;
  };
  for (let i = 0; i < frags.length; i++) {
    for (let j = i + 1; j < frags.length; j++) {
      const dx = frags[i].x - frags[j].x;
      const dy = frags[i].y - frags[j].y;
      if (dx * dx + dy * dy <= distSq) {
        const ri = find(i),
          rj = find(j);
        if (ri !== rj) parent[ri] = rj;
      }
    }
  }
  const grouped = new Map<
    number,
    { sx: number; sy: number; n: number; texts: string[]; maxFont: number }
  >();
  for (let i = 0; i < frags.length; i++) {
    const r = find(i);
    const g = grouped.get(r) ?? { sx: 0, sy: 0, n: 0, texts: [], maxFont: 0 };
    g.sx += frags[i].x;
    g.sy += frags[i].y;
    g.n++;
    g.texts.push(frags[i].text);
    if (frags[i].fontSize > g.maxFont) g.maxFont = frags[i].fontSize;
    grouped.set(r, g);
  }
  return [...grouped.values()].map((g) => ({
    label: g.texts.join(" "),
    x: g.sx / g.n,
    y: g.sy / g.n,
    fontSize: g.maxFont,
  }));
}

function pointInPolygon(
  p: { x: number; y: number },
  poly: { x: number; y: number }[],
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x,
      yi = poly[i].y,
      xj = poly[j].x,
      yj = poly[j].y;
    if (
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

/**
 * Main entry — extract room candidates from a PDF page.
 */
export async function extractCommercialRoomCandidates(
  pdfBuffer: Buffer,
  pageNumber: number,
  opts: ExtractOptions = {},
): Promise<CommercialRoomsResult> {
  const t0 = Date.now();
  const doorMatchRadius = opts.doorMatchRadius ?? 60;

  // 1. Vector extraction via MuPDF: walls + door candidates.
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(
    new Uint8Array(pdfBuffer),
    "application/pdf",
  );
  const page = doc.loadPage(pageNumber - 1);
  const bounds = page.getBounds();
  const pageWidthPt = bounds[2] - bounds[0];
  const pageHeightPt = bounds[3] - bounds[1];

  const walls: { x1: number; y1: number; x2: number; y2: number }[] = [];
  const doorCandidates: { x: number; y: number; size: number }[] = [];

  function txMat(ctm: number[], x: number, y: number): [number, number] {
    return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
  }
  function emit(x1: number, y1: number, x2: number, y2: number): void {
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const len = Math.hypot(dx, dy);
    if (len < 5) return;
    if (dy < 1.5 && dx > 1.5)
      walls.push({ x1, y1, x2, y2: y1 });
    else if (dx < 1.5 && dy > 1.5)
      walls.push({ x1, y1, x2: x1, y2 });
    else if (len >= 18 && len <= 45)
      doorCandidates.push({
        x: (x1 + x2) / 2,
        y: (y1 + y2) / 2,
        size: len,
      });
  }
  function collect(p: MupdfPath, ctm: number[]): void {
    let cx = 0,
      cy = 0,
      sx = 0,
      sy = 0;
    p.walk({
      moveTo: (x, y) => {
        [cx, cy] = txMat(ctm, x, y);
        sx = cx;
        sy = cy;
      },
      lineTo: (x, y) => {
        const [nx, ny] = txMat(ctm, x, y);
        emit(cx, cy, nx, ny);
        cx = nx;
        cy = ny;
      },
      curveTo: (c1x, c1y, c2x, c2y, ex, ey) => {
        const [a1x, a1y] = txMat(ctm, c1x, c1y);
        const [a2x, a2y] = txMat(ctm, c2x, c2y);
        const [aex, aey] = txMat(ctm, ex, ey);
        const minX = Math.min(cx, a1x, a2x, aex);
        const maxX = Math.max(cx, a1x, a2x, aex);
        const minY = Math.min(cy, a1y, a2y, aey);
        const maxY = Math.max(cy, a1y, a2y, aey);
        const extent = Math.max(maxX - minX, maxY - minY);
        if (extent >= 18 && extent <= 45) {
          doorCandidates.push({
            x: (minX + maxX) / 2,
            y: (minY + maxY) / 2,
            size: extent,
          });
        }
        cx = aex;
        cy = aey;
      },
      closePath: () => {
        emit(cx, cy, sx, sy);
        cx = sx;
        cy = sy;
      },
    });
  }
  const dev = new (
    mupdf as unknown as { Device: new (o: object) => unknown }
  ).Device({
    fillPath: (p: MupdfPath, _: unknown, ctm: number[]) => collect(p, ctm),
    strokePath: (p: MupdfPath, _: unknown, ctm: number[]) => collect(p, ctm),
  });
  (page as unknown as { run: (d: unknown, m: number[]) => void }).run(
    dev,
    (mupdf as unknown as { Matrix: { identity: number[] } }).Matrix.identity,
  );
  const vectorWallCount = walls.length;

  // 2. Text fragments via pdfjs (also used to mask the image-wall pass).
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfDoc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    isEvalSupported: false,
  }).promise;
  const pdfPage = await pdfDoc.getPage(pageNumber);
  const tc = await pdfPage.getTextContent();
  const fragments: TextFragment[] = (
    tc.items as { str: string; transform: number[]; width: number; height: number }[]
  )
    .filter((it) => it.str.trim().length > 0)
    .map((it) => ({
      text: it.str.trim(),
      x: it.transform[4],
      y: it.transform[5],
      fontSize: Math.abs(it.transform[3] || it.height || 8),
      width: it.width || 0,
      height: it.height || 0,
    }));

  // 2a. Scale anchor (deterministic pt → ft conversion).
  const scaleAnchor = detectScaleAnchor(
    fragments.map((f) => ({ text: f.text, x: f.x, y: f.y })),
  );

  // 2b. Dimension callouts ("12'-6\"" etc.) — architect's own numbers.
  const callouts = parseDimensionCallouts(
    (tc.items as { str: string; transform: number[] }[])
      .filter((it) => it.str.trim().length > 0)
      .map((it) => ({
        text: it.str.trim(),
        x: it.transform[4],
        y: it.transform[5],
        rotation: Math.atan2(it.transform[1], it.transform[0]),
      })),
  );

  // 2c. Optional: AI-vision OCR for callouts printed on the raster.
  // Off by default — opt in for commercial plans with raster backgrounds.
  if (opts.enableAiOcr) {
    try {
      const { ocrDimensionsViaAi } = await import("./ai/dimension-ocr");
      const ai = await ocrDimensionsViaAi(pdfBuffer, pageNumber, {
        cols: opts.aiOcrCols ?? 3,
        rows: opts.aiOcrRows ?? 2,
      });
      for (const c of ai.callouts) {
        callouts.push({
          rawText: c.rawText,
          lengthFt: c.lengthFt,
          x: c.x,
          y: c.y,
          orientation:
            c.orientation === "horizontal"
              ? "h"
              : c.orientation === "vertical"
                ? "v"
                : null,
          confidence: c.confidence,
        });
      }
    } catch {
      // Don't fail the whole extraction if OCR errors (missing API key, etc.)
    }
  }

  // 3. Image-wall pass (optional).
  let imageWallCount = 0;
  if (!opts.skipImageWalls) {
    const textBoxes = fragments.map((f) => ({
      x: f.x,
      y: f.y - f.fontSize * 0.2,
      width: Math.max(f.width, f.fontSize * f.text.length * 0.6),
      height: f.fontSize * 1.2,
    }));
    const imgRes = await detectWallsFromImage(pdfBuffer, pageNumber, {
      dpi: opts.imageWallDpi ?? 150,
      threshold: 140,
      minWallPx: 24,
      minWallThickness: 2,
      textBoxes,
    });
    for (const s of imgRes.segments) walls.push(s);
    imageWallCount = imgRes.segments.length;
  }

  // 4. Planar-graph face enumeration on the combined wall set.
  const faces = detectRooms(walls, pageWidthPt, pageHeightPt, {
    snapTolerance: 1.5,
    minRoomArea: 1500,
    maxRoomArea: 0.85 * pageWidthPt * pageHeightPt,
    maxAspectRatio: 30,
    maxVertices: 80,
    maxDoorGap: 60,
    doorCandidates,
    doorMatchRadius,
  });

  // 5. Pair each clustered label with the smallest enclosing face.
  const likelyLabels = fragments.filter((f) => isLikelyRoomLabel(f.text));
  const clustered = clusterLabels(likelyLabels);

  const candidates: RoomCandidate[] = [];
  const usedFaces = new Set<number>();
  for (const c of clustered) {
    let bestFace: { idx: number; face: RoomFace } | null = null;
    for (let i = 0; i < faces.length; i++) {
      if (!pointInPolygon({ x: c.x, y: c.y }, faces[i].polygon)) continue;
      if (!bestFace || faces[i].area < bestFace.face.area) {
        bestFace = { idx: i, face: faces[i] };
      }
    }
    if (bestFace) {
      const w = bestFace.face.bbox.x1 - bestFace.face.bbox.x0;
      const h = bestFace.face.bbox.y1 - bestFace.face.bbox.y0;
      const aspect = Math.max(w / h, h / w);
      const shared = usedFaces.has(bestFace.idx);
      let conf = 0.85;
      if (shared) conf -= 0.25;
      if (aspect > 15) conf -= 0.15;
      if (bestFace.face.polygon.length > 30) conf -= 0.1;

      // Pair the face with its dimension callouts + scale anchor →
      // deterministic sqft when both available.
      const bbox = {
        x: bestFace.face.bbox.x0,
        y: bestFace.face.bbox.y0,
        width: w,
        height: h,
      };
      const localCallouts = calloutsForRoom(callouts, bestFace.face.polygon, 30);
      const dims = scaleAnchor
        ? roomDimensionsFromCallouts(bbox, localCallouts, scaleAnchor.ptPerFoot)
        : null;
      const measurementSource: RoomCandidate["measurementSource"] = !dims
        ? "none"
        : dims.source === "callouts"
          ? "callouts"
          : dims.source === "mixed"
            ? "mixed"
            : "geometry+scale";
      if (measurementSource === "callouts") conf = Math.min(0.99, conf + 0.1);
      candidates.push({
        label: c.label,
        x: c.x,
        y: c.y,
        bbox,
        polygon: bestFace.face.polygon,
        areaPt: bestFace.face.area,
        areaSqft: dims?.areaSqft ?? null,
        widthFt: dims?.widthFt ?? null,
        heightFt: dims?.heightFt ?? null,
        measurementSource,
        callouts: localCallouts,
        confidence: Math.max(0, Math.min(1, conf)),
        source: "hybrid",
      });
      usedFaces.add(bestFace.idx);
    }
    // Labels with no enclosing face: emit a small bbox-only candidate at
    // the label position. Confidence is low — caller defers to AI.
    else {
      const bbox = { x: c.x - 40, y: c.y - 30, width: 80, height: 60 };
      const polygon = [
        { x: bbox.x, y: bbox.y },
        { x: bbox.x + bbox.width, y: bbox.y },
        { x: bbox.x + bbox.width, y: bbox.y + bbox.height },
        { x: bbox.x, y: bbox.y + bbox.height },
      ];
      const localCallouts = calloutsForRoom(callouts, polygon, 60);
      // Even without a face, we can produce a sqft estimate if local
      // callouts exist. Take the largest H × largest V callout as the
      // room's dimensions.
      let areaSqft: number | null = null;
      let widthFt: number | null = null;
      let heightFt: number | null = null;
      let measurementSource: RoomCandidate["measurementSource"] = "none";
      if (localCallouts.length >= 2) {
        const hor = localCallouts.filter((cc) => cc.orientation === "h");
        const ver = localCallouts.filter((cc) => cc.orientation === "v");
        if (hor.length > 0 && ver.length > 0) {
          hor.sort((a, b) => b.lengthFt - a.lengthFt);
          ver.sort((a, b) => b.lengthFt - a.lengthFt);
          widthFt = hor[0].lengthFt;
          heightFt = ver[0].lengthFt;
          areaSqft = widthFt * heightFt;
          measurementSource = "callouts";
        }
      }
      candidates.push({
        label: c.label,
        x: c.x,
        y: c.y,
        bbox,
        polygon,
        areaPt: 80 * 60,
        areaSqft,
        widthFt,
        heightFt,
        measurementSource,
        callouts: localCallouts,
        confidence: measurementSource === "callouts" ? 0.7 : 0.25,
        source: "voronoi",
      });
    }
  }

  return {
    pageWidthPt,
    pageHeightPt,
    candidates,
    scaleAnchor,
    dimensionCallouts: callouts,
    vectorWallCount,
    imageWallCount,
    doorCandidateCount: doorCandidates.length,
    faceCount: faces.length,
    elapsedMs: Date.now() - t0,
  };
}
