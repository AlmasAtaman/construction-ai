/**
 * Extract wall-candidate line segments and room rectangles directly
 * from the PDF's vector layer. This bypasses AI for the geometry —
 * room polygons come from actual drawing data, so floor areas are
 * computed deterministically.
 *
 * Strategy (v1):
 *   1. Use MuPDF.js (WASM, no native deps) to iterate every drawing
 *      operation on the page, applying each path's CTM to get
 *      coordinates in PDF page space.
 *   2. Keep only stroke operations that look like walls — horizontal
 *      or vertical, length > 5 pt, stroke width in the wall range.
 *   3. Detect rectangular rooms by matching pairs of horizontal lines
 *      to pairs of vertical lines that share endpoints (within a
 *      tolerance).
 *
 * Limitations: only finds rectangular rooms — L-shaped and irregular
 * rooms need the full planar-graph face enumeration we'll add later.
 * For now, rectangular rooms cover ~70-80% of commercial spaces.
 */

export interface WallSegment {
  /** Endpoints in PDF page space (0..pageWidthPt × 0..pageHeightPt). */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** "h" = horizontal, "v" = vertical. */
  orientation: "h" | "v";
  length: number;
}

/**
 * A door candidate detected from non-axis-aligned line segments or
 * arc/bezier curves. Door symbols in CAD are typically:
 *   - a diagonal line representing the door panel
 *   - a 90° arc representing the swing
 * Both have length ≈ door width (24-42 pt at 1/8":1' scale).
 */
export interface DoorCandidate {
  /** Center of the symbol in PDF page space. */
  x: number;
  y: number;
  /** Symbol radius / extent — approximately the door width. */
  size: number;
}

export interface RoomRectangle {
  /** Bounding box in PDF page space. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Area in square PDF points. Convert with the page scale to sqft. */
  areaPt: number;
  /** Bounding box in normalized 0..1 page coords. */
  xNorm: number;
  yNorm: number;
  widthNorm: number;
  heightNorm: number;
}

export interface RoomPolygon {
  /** Closed polygon in PDF page space. polygon[0] != polygon[n-1]. */
  polygon: { x: number; y: number }[];
  /** Signed shoelace area (positive for inner faces). pt². */
  areaPt: number;
  /** Axis-aligned bounding box in PDF page space. */
  bbox: { x: number; y: number; width: number; height: number };
  /** Bounding box in normalized 0..1 page coords. */
  bboxNorm: { x: number; y: number; width: number; height: number };
}

export interface VectorExtractResult {
  pageWidthPt: number;
  pageHeightPt: number;
  segments: WallSegment[];
  doorCandidates: DoorCandidate[];
  /**
   * Rectangular rooms only (fast first-pass detector). Kept for
   * back-compat; prefer `roomPolygons` for the full set.
   */
  roomRectangles: RoomRectangle[];
  /**
   * Full planar-graph face enumeration — rectangles + L-shapes +
   * corridors + irregular rooms. The deterministic geometry layer.
   */
  roomPolygons: RoomPolygon[];
  /** Total time taken in milliseconds, for debugging. */
  elapsedMs: number;
}

const COORD_TOL = 1.5; // points; line endpoints within this distance are "the same"
const MIN_WALL_LEN_PT = 5;
const MIN_ROOM_AREA_PT = 5000; // ~5 sqft at typical scale — anything smaller is a closet/note
const MAX_ROOM_AREA_PT = 5_000_000; // sanity bound (huge plenum)
// Door-panel and door-swing geometry sizes at 1/8":1' scale. A 3-ft
// door = 27 pt; we accept 18-45 pt to cover 2-ft and 4-ft doors too.
const DOOR_MIN_PT = 18;
const DOOR_MAX_PT = 45;

/**
 * Pull all stroked line segments from a PDF page that look like walls,
 * and group them into rectangular rooms.
 */
export async function extractVectorRooms(
  pdfBuffer: Buffer,
  pageNumber: number,
): Promise<VectorExtractResult> {
  const t0 = Date.now();
  const mupdf = await import("mupdf");

  const doc = mupdf.Document.openDocument(
    new Uint8Array(pdfBuffer),
    "application/pdf",
  );
  const page = doc.loadPage(pageNumber - 1);
  const bounds = page.getBounds();
  const pageWidthPt = bounds[2] - bounds[0];
  const pageHeightPt = bounds[3] - bounds[1];

  const segments: WallSegment[] = [];
  const doorCandidates: DoorCandidate[] = [];
  const collectFromPath = (
    path: unknown,
    ctm: number[],
    isStroke: boolean,
  ) => {
    if (!isStroke) return; // walls are stroked, fills are hatches/text
    let curX = 0;
    let curY = 0;
    let startX = 0;
    let startY = 0;
    function tx(x: number, y: number): [number, number] {
      return [
        ctm[0] * x + ctm[2] * y + ctm[4],
        ctm[1] * x + ctm[3] * y + ctm[5],
      ];
    }
    function emit(x: number, y: number): void {
      const dx = Math.abs(x - curX);
      const dy = Math.abs(y - curY);
      const len = Math.hypot(dx, dy);
      if (len >= MIN_WALL_LEN_PT) {
        if (dy < COORD_TOL && dx > COORD_TOL) {
          segments.push({
            x1: curX,
            y1: curY,
            x2: x,
            y2: y,
            orientation: "h",
            length: dx,
          });
        } else if (dx < COORD_TOL && dy > COORD_TOL) {
          segments.push({
            x1: curX,
            y1: curY,
            x2: x,
            y2: y,
            orientation: "v",
            length: dy,
          });
        } else if (len >= DOOR_MIN_PT && len <= DOOR_MAX_PT) {
          // Diagonal line at door-panel scale = likely door swing line.
          doorCandidates.push({
            x: (curX + x) / 2,
            y: (curY + y) / 2,
            size: len,
          });
        }
      }
      curX = x;
      curY = y;
    }
    function emitCurve(
      cx1: number,
      cy1: number,
      cx2: number,
      cy2: number,
      ex: number,
      ey: number,
    ): void {
      // Bezier curve: treat as a door-swing arc if its bounding box is
      // door-sized. We approximate the curve by its endpoints + control
      // points; if the diagonal extent matches a door, register as
      // door candidate at the midpoint of the curve.
      const minX = Math.min(curX, cx1, cx2, ex);
      const maxX = Math.max(curX, cx1, cx2, ex);
      const minY = Math.min(curY, cy1, cy2, ey);
      const maxY = Math.max(curY, cy1, cy2, ey);
      const w = maxX - minX;
      const h = maxY - minY;
      const extent = Math.max(w, h);
      if (extent >= DOOR_MIN_PT && extent <= DOOR_MAX_PT) {
        doorCandidates.push({
          x: (minX + maxX) / 2,
          y: (minY + maxY) / 2,
          size: extent,
        });
      }
      curX = ex;
      curY = ey;
    }
    (path as { walk: (v: object) => void }).walk({
      moveTo: (x: number, y: number) => {
        [curX, curY] = tx(x, y);
        startX = curX;
        startY = curY;
      },
      lineTo: (x: number, y: number) => {
        const [nx, ny] = tx(x, y);
        emit(nx, ny);
      },
      curveTo: (
        c1x: number,
        c1y: number,
        c2x: number,
        c2y: number,
        ex: number,
        ey: number,
      ) => {
        const [a1x, a1y] = tx(c1x, c1y);
        const [a2x, a2y] = tx(c2x, c2y);
        const [aex, aey] = tx(ex, ey);
        emitCurve(a1x, a1y, a2x, a2y, aex, aey);
      },
      closePath: () => {
        emit(startX, startY);
      },
    });
  };

  const dev = new mupdf.Device({
    fillPath: (path: unknown, _evenOdd: unknown, ctm: number[]) =>
      collectFromPath(path, ctm, false),
    strokePath: (
      path: unknown,
      _stroke: unknown,
      ctm: number[],
    ) => collectFromPath(path, ctm, true),
  });
  page.run(dev, mupdf.Matrix.identity);

  const roomRectangles = detectRectangles(
    segments,
    pageWidthPt,
    pageHeightPt,
  );

  // Full planar-graph face enumeration — covers L-shapes, corridors,
  // and irregular rooms that the rectangle detector misses.
  const { detectRooms } = await import("./planar-graph");
  const planarRooms = detectRooms(
    segments.map((s) => ({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 })),
    pageWidthPt,
    pageHeightPt,
    {
      snapTolerance: COORD_TOL,
      minRoomArea: 1500, // ~1.5 sqft at typical scale
      maxRoomArea: 0.85 * pageWidthPt * pageHeightPt,
      maxAspectRatio: 30,
      maxVertices: 80,
      maxDoorGap: 60, // bridge gaps up to ~6-ft openings
      doorCandidates: doorCandidates.map((d) => ({ x: d.x, y: d.y, size: d.size })),
      doorMatchRadius: 60, // door arcs offset perpendicular to wall by ≈ door width
    },
  );
  const roomPolygons: RoomPolygon[] = planarRooms.map((r) => {
    const w = r.bbox.x1 - r.bbox.x0;
    const h = r.bbox.y1 - r.bbox.y0;
    return {
      polygon: r.polygon,
      areaPt: r.area,
      bbox: { x: r.bbox.x0, y: r.bbox.y0, width: w, height: h },
      bboxNorm: {
        x: r.bbox.x0 / pageWidthPt,
        y: r.bbox.y0 / pageHeightPt,
        width: w / pageWidthPt,
        height: h / pageHeightPt,
      },
    };
  });

  return {
    pageWidthPt,
    pageHeightPt,
    segments,
    doorCandidates,
    roomRectangles,
    roomPolygons,
    elapsedMs: Date.now() - t0,
  };
}

/**
 * Group horizontal segments by Y-coordinate and vertical segments by
 * X-coordinate, then look for quadruples of (top, bottom, left, right)
 * lines whose endpoints align to form a closed rectangle.
 *
 * This is a deliberately simple v1 — it only finds axis-aligned
 * rectangles. Most office/restroom-style rooms ARE rectangles, so this
 * catches most of the value. L-shaped and irregular rooms fall through
 * to the AI pipeline.
 */
function detectRectangles(
  segments: WallSegment[],
  pageWidthPt: number,
  pageHeightPt: number,
): RoomRectangle[] {
  const horizontals = segments.filter((s) => s.orientation === "h");
  const verticals = segments.filter((s) => s.orientation === "v");

  // Index horizontals by Y bucket (snap to COORD_TOL grid).
  const hByY = new Map<number, WallSegment[]>();
  for (const h of horizontals) {
    const y = Math.round(h.y1 / COORD_TOL) * COORD_TOL;
    const list = hByY.get(y) ?? [];
    list.push(h);
    hByY.set(y, list);
  }
  // Index verticals by X bucket.
  const vByX = new Map<number, WallSegment[]>();
  for (const v of verticals) {
    const x = Math.round(v.x1 / COORD_TOL) * COORD_TOL;
    const list = vByX.get(x) ?? [];
    list.push(v);
    vByX.set(x, list);
  }

  const rects: RoomRectangle[] = [];
  const seen = new Set<string>();

  // For each pair of horizontals at different Ys, check whether any
  // pair of verticals "closes" the rectangle.
  const hYs = [...hByY.keys()].sort((a, b) => a - b);
  for (let i = 0; i < hYs.length; i++) {
    const yTop = hYs[i];
    const topLines = hByY.get(yTop)!;
    for (let j = i + 1; j < hYs.length; j++) {
      const yBot = hYs[j];
      if (yBot - yTop < 20) continue; // too thin
      const botLines = hByY.get(yBot)!;
      // Find x-ranges shared between any top and any bottom line.
      for (const t of topLines) {
        const tMin = Math.min(t.x1, t.x2);
        const tMax = Math.max(t.x1, t.x2);
        for (const b of botLines) {
          const bMin = Math.min(b.x1, b.x2);
          const bMax = Math.max(b.x1, b.x2);
          const xLo = Math.max(tMin, bMin);
          const xHi = Math.min(tMax, bMax);
          if (xHi - xLo < 20) continue; // no usable shared x-range
          // Need a left vertical at xLo connecting yTop to yBot, and a
          // right vertical at xHi.
          const leftCandidates = findVerticalAt(vByX, xLo, yTop, yBot);
          if (!leftCandidates) continue;
          const rightCandidates = findVerticalAt(vByX, xHi, yTop, yBot);
          if (!rightCandidates) continue;

          const key = `${Math.round(xLo)}-${Math.round(yTop)}-${Math.round(xHi)}-${Math.round(yBot)}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const w = xHi - xLo;
          const h = yBot - yTop;
          const area = w * h;
          if (area < MIN_ROOM_AREA_PT) continue;
          if (area > MAX_ROOM_AREA_PT) continue;

          rects.push({
            x: xLo,
            y: yTop,
            width: w,
            height: h,
            areaPt: area,
            xNorm: xLo / pageWidthPt,
            yNorm: yTop / pageHeightPt,
            widthNorm: w / pageWidthPt,
            heightNorm: h / pageHeightPt,
          });
        }
      }
    }
  }

  // Sort by area DESC, then dedupe overlapping rectangles (keep larger).
  rects.sort((a, b) => b.areaPt - a.areaPt);
  return removeOverlapping(rects);
}

function findVerticalAt(
  vByX: Map<number, WallSegment[]>,
  x: number,
  yTop: number,
  yBot: number,
): WallSegment | null {
  // Search a small window of X buckets around `x`.
  for (let dx = -COORD_TOL; dx <= COORD_TOL; dx += COORD_TOL) {
    const bucket = Math.round((x + dx) / COORD_TOL) * COORD_TOL;
    const lines = vByX.get(bucket);
    if (!lines) continue;
    for (const v of lines) {
      const vMin = Math.min(v.y1, v.y2);
      const vMax = Math.max(v.y1, v.y2);
      // Vertical must cover the full Y range between top and bottom
      // (with a little slack).
      if (vMin <= yTop + COORD_TOL && vMax >= yBot - COORD_TOL) {
        return v;
      }
    }
  }
  return null;
}

/**
 * Drop rectangles that are wholly contained inside another, larger
 * rectangle (those are usually millwork drawn inside a room). Keep the
 * outer one.
 */
function removeOverlapping(rects: RoomRectangle[]): RoomRectangle[] {
  const kept: RoomRectangle[] = [];
  for (const r of rects) {
    let dominated = false;
    for (const k of kept) {
      // r contained in k?
      if (
        r.x >= k.x - COORD_TOL &&
        r.y >= k.y - COORD_TOL &&
        r.x + r.width <= k.x + k.width + COORD_TOL &&
        r.y + r.height <= k.y + k.height + COORD_TOL
      ) {
        dominated = true;
        break;
      }
    }
    if (!dominated) kept.push(r);
  }
  return kept;
}
