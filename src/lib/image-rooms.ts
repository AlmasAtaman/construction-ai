/**
 * Image-based room detection via morphology + connected components.
 *
 * Why this exists: the planar-graph face enumeration in planar-graph.ts
 * over-merges rooms on real plans. When a door gap or wall break isn't
 * closed, two rooms merge into one wraparound face. We've measured the
 * fallout in tests/fixtures/benchmark-suite-results.json — vector MAE
 * routinely hits 3000-5000% because room labels get paired with these
 * giant wraparound faces.
 *
 * The fix is to find rooms a different way:
 *
 *   1. Render the page to a binary image (walls = black, floor = white).
 *   2. Morphologically DILATE the wall pixels by a small radius — this
 *      closes door gaps and small drafting imperfections.
 *   3. Find connected components of the WHITE pixels (walkable space).
 *   4. Each non-tiny component IS a room. Its polygon is the
 *      component's bounding box / contour.
 *   5. Pair each component with the text label whose centroid sits
 *      inside it.
 *
 * Properties:
 *   - $0 — no AI, no API calls
 *   - Fast — ~1-2 s on a 6000×4500 image in pure JS
 *   - Deterministic — same input → same output
 *   - Resilient to wraparound — connected components naturally separate
 *     even when walls have small breaks (dilation closes them)
 *
 * Coordinate system: image pixels with Y-down for processing, converted
 * to PDF user space (Y-up) on output.
 */

export interface ImageRoom {
  /** Bounding box in PDF page space (Y up, origin bottom-left). */
  bbox: { x: number; y: number; width: number; height: number };
  /** Approximate polygon for the room — bbox corners for now. */
  polygon: { x: number; y: number }[];
  /** Area in PDF points². Use scale anchor to convert to sqft. */
  areaPt: number;
  /** Number of pixels in the component (rough size signal). */
  pixelCount: number;
}

export interface ImageRoomsResult {
  pageWidthPt: number;
  pageHeightPt: number;
  rooms: ImageRoom[];
  dpi: number;
  /** Diagnostics. */
  stats: {
    pixelsWidth: number;
    pixelsHeight: number;
    wallPixelsAfterDilation: number;
    componentsFound: number;
    componentsKept: number;
  };
  elapsedMs: number;
}

export interface ImageRoomsOptions {
  /** Render DPI. Default 150. Higher = sharper room edges, more memory. */
  dpi?: number;
  /** Threshold below which a grayscale pixel counts as ink (wall). Default 140. */
  threshold?: number;
  /**
   * Dilation radius in pixels — how aggressively to close gaps in walls.
   * Default 3 (≈6 px after H + V passes). On a 150-DPI render, that's
   * ~0.3 inch on the page, which closes typical door gaps (3 ft at
   * 1/8":1' scale = 27 px) when combined with the wall ALREADY being
   * 2-4 px thick.
   *
   * If your plan has wider door openings, increase to 5-7. Too high =
   * walls collapse into one big room.
   */
  dilationRadius?: number;
  /** Minimum component pixel count to count as a room. Default 400 px²(~3sqft@150DPI). */
  minPixels?: number;
  /** Maximum component pixel count. Default = 80% of total — drops the outer "everything else" component. */
  maxPixelsFraction?: number;
  /**
   * Text bounding boxes (PDF point space, Y up) to mask out before
   * thresholding. Without this, text glyphs become "walls" and divide
   * rooms by every letter on the plan.
   */
  textBoxes?: { x: number; y: number; width: number; height: number }[];
  /** Padding around text boxes. Default 4 pt. */
  textBoxPadPt?: number;
}

const DEFAULT_DPI = 150;
const DEFAULT_THRESHOLD = 140;
const DEFAULT_DILATION_RADIUS = 3;
const DEFAULT_MIN_PIXELS = 400;
const DEFAULT_MAX_PIXELS_FRAC = 0.4;

/**
 * Main entry point — render the page and return detected room polygons.
 */
export async function detectRoomsFromImage(
  pdfBuffer: Buffer,
  pageNumber: number,
  opts: ImageRoomsOptions = {},
): Promise<ImageRoomsResult> {
  const t0 = Date.now();
  const dpi = opts.dpi ?? DEFAULT_DPI;
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const dilationRadius = opts.dilationRadius ?? DEFAULT_DILATION_RADIUS;
  const minPixels = opts.minPixels ?? DEFAULT_MIN_PIXELS;
  const maxPixelsFrac = opts.maxPixelsFraction ?? DEFAULT_MAX_PIXELS_FRAC;
  const textPad = opts.textBoxPadPt ?? 4;

  // 1. Render to grayscale via MuPDF.
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(
    new Uint8Array(pdfBuffer),
    "application/pdf",
  );
  const page = doc.loadPage(pageNumber - 1);
  const bounds = page.getBounds();
  const pageWidthPt = bounds[2] - bounds[0];
  const pageHeightPt = bounds[3] - bounds[1];

  const scale = dpi / 72;
  const matrix = (mupdf as unknown as {
    Matrix: { scale: (sx: number, sy: number) => number[] };
  }).Matrix.scale(scale, scale);
  const cs = (mupdf as unknown as { ColorSpace: { DeviceGray: unknown } })
    .ColorSpace.DeviceGray;
  const pixmap = (page as unknown as {
    toPixmap: (m: number[], c: unknown) => {
      getPixels: () => Uint8Array;
      getWidth: () => number;
      getHeight: () => number;
      destroy?: () => void;
    };
  }).toPixmap(matrix, cs);
  const samples = pixmap.getPixels();
  const W = pixmap.getWidth();
  const H = pixmap.getHeight();
  pixmap.destroy?.();

  // 2. Threshold + apply text mask.
  const wallMask = new Uint8Array(W * H);
  const pxPerPt = dpi / 72;
  const textMask = opts.textBoxes && opts.textBoxes.length > 0
    ? new Uint8Array(W * H)
    : null;
  if (textMask && opts.textBoxes) {
    for (const t of opts.textBoxes) {
      const ix0 = Math.max(0, Math.floor((t.x - textPad) * pxPerPt));
      const ix1 = Math.min(W, Math.ceil((t.x + t.width + textPad) * pxPerPt));
      const iy0 = Math.max(
        0,
        Math.floor((pageHeightPt - (t.y + t.height + textPad)) * pxPerPt),
      );
      const iy1 = Math.min(
        H,
        Math.ceil((pageHeightPt - (t.y - textPad)) * pxPerPt),
      );
      for (let y = iy0; y < iy1; y++) {
        const rs = y * W;
        for (let x = ix0; x < ix1; x++) textMask[rs + x] = 1;
      }
    }
  }
  for (let i = 0; i < samples.length; i++) {
    if (textMask && textMask[i]) continue; // text isn't a wall
    if (samples[i] < threshold) wallMask[i] = 1;
  }

  // 3. Dilate walls (separable horizontal + vertical for speed).
  const dilated = dilationRadius > 0 ? dilate(wallMask, W, H, dilationRadius) : wallMask;
  let wallPixels = 0;
  for (let i = 0; i < dilated.length; i++) if (dilated[i]) wallPixels++;

  // 4. Connected-component on the WHITE pixels (walkable space).
  // Each cell stores its component id (-1 = wall, ≥0 = component id).
  const componentId = new Int32Array(W * H).fill(-1);
  const componentSize: number[] = [];
  let nextId = 0;
  // BFS queue per component (reused).
  const queue: number[] = [];
  for (let seedIdx = 0; seedIdx < W * H; seedIdx++) {
    if (dilated[seedIdx]) continue;
    if (componentId[seedIdx] >= 0) continue;
    // Start a new component.
    const myId = nextId++;
    componentId[seedIdx] = myId;
    queue.length = 0;
    queue.push(seedIdx);
    let count = 0;
    while (queue.length > 0) {
      const idx = queue.pop()!;
      count++;
      const x = idx % W;
      const y = (idx - x) / W;
      if (x > 0) {
        const ni = idx - 1;
        if (!dilated[ni] && componentId[ni] < 0) {
          componentId[ni] = myId;
          queue.push(ni);
        }
      }
      if (x < W - 1) {
        const ni = idx + 1;
        if (!dilated[ni] && componentId[ni] < 0) {
          componentId[ni] = myId;
          queue.push(ni);
        }
      }
      if (y > 0) {
        const ni = idx - W;
        if (!dilated[ni] && componentId[ni] < 0) {
          componentId[ni] = myId;
          queue.push(ni);
        }
      }
      if (y < H - 1) {
        const ni = idx + W;
        if (!dilated[ni] && componentId[ni] < 0) {
          componentId[ni] = myId;
          queue.push(ni);
        }
      }
    }
    componentSize.push(count);
  }

  // 5. Filter by size; build bounding boxes for each kept component.
  // Track which components touch the image border — those are exterior
  // "outer floor / everything" regions and aren't real rooms.
  type Bbox = { minX: number; minY: number; maxX: number; maxY: number };
  const componentBbox: Bbox[] = componentSize.map(() => ({
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  }));
  const touchesBorder = componentSize.map(() => 0); // count of border sides touched
  for (let i = 0; i < W * H; i++) {
    const id = componentId[i];
    if (id < 0) continue;
    const x = i % W;
    const y = (i - x) / W;
    const b = componentBbox[id];
    if (x < b.minX) b.minX = x;
    if (y < b.minY) b.minY = y;
    if (x > b.maxX) b.maxX = x;
    if (y > b.maxY) b.maxY = y;
  }
  // After bbox pass, check which components touch the image edge.
  for (let id = 0; id < componentBbox.length; id++) {
    const b = componentBbox[id];
    if (b.minX === 0) touchesBorder[id]++;
    if (b.minY === 0) touchesBorder[id]++;
    if (b.maxX === W - 1) touchesBorder[id]++;
    if (b.maxY === H - 1) touchesBorder[id]++;
  }

  const totalPx = W * H;
  const maxPx = totalPx * maxPixelsFrac;
  const rooms: ImageRoom[] = [];
  let kept = 0;
  for (let id = 0; id < componentSize.length; id++) {
    const px = componentSize[id];
    if (px < minPixels || px > maxPx) continue;
    // Drop components that touch ANY image border — real interior rooms
    // don't touch the page edge. The page typically has margins, notes,
    // legends, 3D renderings, and exterior surroundings around the
    // building footprint — all of which form a single huge "outer"
    // component that touches at least one border.
    if (touchesBorder[id] >= 1) continue;
    const b = componentBbox[id];
    // Convert pixel bbox to PDF pt (Y flip).
    const xPt = b.minX / pxPerPt;
    const widthPt = (b.maxX - b.minX + 1) / pxPerPt;
    // Image y=0 is top of page; PDF y=0 is bottom of page.
    const yPt = pageHeightPt - b.maxY / pxPerPt;
    const heightPt = (b.maxY - b.minY + 1) / pxPerPt;
    const polygon = [
      { x: xPt, y: yPt },
      { x: xPt + widthPt, y: yPt },
      { x: xPt + widthPt, y: yPt + heightPt },
      { x: xPt, y: yPt + heightPt },
    ];
    rooms.push({
      bbox: { x: xPt, y: yPt, width: widthPt, height: heightPt },
      polygon,
      areaPt: widthPt * heightPt,
      pixelCount: px,
    });
    kept++;
  }
  rooms.sort((a, b) => b.areaPt - a.areaPt);

  return {
    pageWidthPt,
    pageHeightPt,
    rooms,
    dpi,
    elapsedMs: Date.now() - t0,
    stats: {
      pixelsWidth: W,
      pixelsHeight: H,
      wallPixelsAfterDilation: wallPixels,
      componentsFound: componentSize.length,
      componentsKept: kept,
    },
  };
}

/**
 * In-place-friendly dilation of a binary mask. Returns a new buffer.
 * Separable: horizontal pass then vertical, each O(N × radius).
 */
function dilate(
  mask: Uint8Array,
  W: number,
  H: number,
  radius: number,
): Uint8Array {
  const tmp = new Uint8Array(mask.length);
  // Horizontal pass: each pixel becomes max of [-radius, +radius] along row.
  for (let y = 0; y < H; y++) {
    const rs = y * W;
    for (let x = 0; x < W; x++) {
      let v = 0;
      const lo = Math.max(0, x - radius);
      const hi = Math.min(W - 1, x + radius);
      for (let xi = lo; xi <= hi; xi++) {
        if (mask[rs + xi] > v) {
          v = mask[rs + xi];
          if (v === 1) break;
        }
      }
      tmp[rs + x] = v;
    }
  }
  // Vertical pass on tmp → out
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let v = 0;
      const lo = Math.max(0, y - radius);
      const hi = Math.min(H - 1, y + radius);
      for (let yi = lo; yi <= hi; yi++) {
        if (tmp[yi * W + x] > v) {
          v = tmp[yi * W + x];
          if (v === 1) break;
        }
      }
      out[y * W + x] = v;
    }
  }
  return out;
}
