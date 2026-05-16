/**
 * Image-based wall detection for rasterized PDF backgrounds.
 *
 * Why: Many commercial plans (the VA Building 28 benchmark is one) have
 * architectural walls embedded as raster images (fillImage) rather than
 * vector lines. The vector layer carries only annotations, labels, and
 * dimensions — so vector-only algorithms find 0 walls in the room
 * interiors. To recover walls from raster, we render the page to a high-
 * DPI bitmap, threshold to binary, and detect long contiguous black runs
 * as wall segments.
 *
 * Pipeline:
 *   1. Render page to grayscale bitmap at `dpi` resolution via MuPDF.
 *   2. Threshold: pixels below `threshold` (e.g. 100/255) are "ink".
 *   3. Horizontal sweep: for each row, find contiguous ink runs longer
 *      than `minWallPx`. Each becomes a horizontal wall segment.
 *   4. Vertical sweep: same for columns.
 *   5. Convert pixel coords → PDF point space (Y-flipped because PDF
 *      user space has Y up, image has Y down).
 *
 * Output is fed into planar-graph / Voronoi room recovery alongside
 * vector segments. Downstream snap+dedupe collapses redundant parallel
 * runs (a wall 3 pixels thick produces 3 nearly-identical segments).
 *
 * What this catches/misses:
 *   - ✓ Solid black walls of any thickness — the dominant case.
 *   - ✓ Walls drawn at any line weight (raster pixels are pixels).
 *   - ✗ Dashed walls (broken into short runs below minWallPx).
 *   - ✗ Diagonal walls (this pass is axis-aligned only).
 *   - ✗ Text that happens to form a long unbroken horizontal stroke
 *     (rare — letter spacing usually breaks runs below 24 px).
 *
 * Complexity: O(W × H) pixels + O(W × H) for the run scan.
 * Memory: 1 byte per pixel for the threshold buffer + segment list.
 */

export interface ImageWallSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  orientation: "h" | "v";
}

export interface ImageWallResult {
  pageWidthPt: number;
  pageHeightPt: number;
  /** Detected segments in PDF point coordinates (Y up). */
  segments: ImageWallSegment[];
  /** Resolution the page was rendered at. */
  dpi: number;
  /** Total elapsed ms. */
  elapsedMs: number;
  /** Diagnostics. */
  stats: {
    pixelsWidth: number;
    pixelsHeight: number;
    inkPixels: number;
    horizontalRuns: number;
    verticalRuns: number;
  };
}

export interface ImageWallOptions {
  /** Render DPI. Default 150 — good edge sharpness, manageable memory. */
  dpi?: number;
  /**
   * Pixel value threshold (0-255). Pixels with intensity BELOW this
   * are treated as ink. Default 140 — anything noticeably darker than
   * paper.
   */
  threshold?: number;
  /**
   * Minimum continuous ink-run length (in PIXELS) to count as a wall
   * segment. Default 24 px = ~3 ft at 150 DPI on a 1/8":1' plan. Below
   * this is usually text or short detail.
   */
  minWallPx?: number;
  /**
   * Minimum wall THICKNESS in pixels. A run is only kept if the same
   * (or near-same) run is present in at least this many adjacent rows
   * (for horizontal) or columns (for vertical). Default 2 — eliminates
   * 1-pixel-thick noise (text strokes, dimension lines, hatching).
   * Set to 1 to keep everything.
   */
  minWallThickness?: number;
  /**
   * Optional text bounding boxes (in PDF point space, Y-up). Pixels
   * inside any text box are NOT classified as ink for wall detection.
   * Without this mask, every text glyph contributes pixel runs that
   * look like wall fragments. Pass the page's text fragments here
   * (from pdfjs) for clean wall recovery.
   */
  textBoxes?: { x: number; y: number; width: number; height: number }[];
  /**
   * Padding (in PDF points) added around each text box. Default 4 pt
   * — covers tight text glyphs that extend slightly past the reported
   * bounding box.
   */
  textBoxPadPt?: number;
}

const DEFAULT_DPI = 150;
const DEFAULT_THRESHOLD = 140;
const DEFAULT_MIN_WALL_PX = 24;
const DEFAULT_MIN_WALL_THICKNESS = 2;

export async function detectWallsFromImage(
  pdfBuffer: Buffer,
  pageNumber: number,
  opts: ImageWallOptions = {},
): Promise<ImageWallResult> {
  const t0 = Date.now();
  const dpi = opts.dpi ?? DEFAULT_DPI;
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const minWallPx = opts.minWallPx ?? DEFAULT_MIN_WALL_PX;
  const minThickness = opts.minWallThickness ?? DEFAULT_MIN_WALL_THICKNESS;
  const textPad = opts.textBoxPadPt ?? 4;

  const mupdf = await import("mupdf");

  const doc = mupdf.Document.openDocument(
    new Uint8Array(pdfBuffer),
    "application/pdf",
  );
  const page = doc.loadPage(pageNumber - 1);
  const bounds = page.getBounds();
  const pageWidthPt = bounds[2] - bounds[0];
  const pageHeightPt = bounds[3] - bounds[1];

  // Render to grayscale pixmap at the requested DPI.
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
  const pxW = pixmap.getWidth();
  const pxH = pixmap.getHeight();

  // Threshold to binary in-place is unnecessary; we read `samples` directly.
  // pxPerPt: scale we need to invert when converting pixel → point.
  const pxPerPt = dpi / 72;
  const pointFromX = (px: number): number => px / pxPerPt;
  // Image Y goes DOWN from top; PDF user space Y goes UP from bottom.
  // pdfY = pageHeightPt - imageY/pxPerPt
  const pointFromY = (py: number): number => pageHeightPt - py / pxPerPt;

  // Build a text mask: 1 byte per pixel, 1 = inside a text bbox (skip).
  // We use Uint8Array so test-and-skip is a single array lookup.
  const textMask = opts.textBoxes && opts.textBoxes.length > 0
    ? new Uint8Array(pxW * pxH)
    : null;
  if (textMask && opts.textBoxes) {
    for (const t of opts.textBoxes) {
      // Convert PDF box (Y up) to image-pixel box (Y down).
      const ix0 = Math.max(0, Math.floor((t.x - textPad) * pxPerPt));
      const ix1 = Math.min(pxW, Math.ceil((t.x + t.width + textPad) * pxPerPt));
      // The PDF top of the box (y + height) becomes image small-y.
      const iy0 = Math.max(
        0,
        Math.floor((pageHeightPt - (t.y + t.height + textPad)) * pxPerPt),
      );
      const iy1 = Math.min(
        pxH,
        Math.ceil((pageHeightPt - (t.y - textPad)) * pxPerPt),
      );
      for (let y = iy0; y < iy1; y++) {
        const rs = y * pxW;
        for (let x = ix0; x < ix1; x++) textMask[rs + x] = 1;
      }
    }
  }
  const isMaskedText = (x: number, y: number): boolean =>
    !!textMask && textMask[y * pxW + x] === 1;

  const segments: ImageWallSegment[] = [];
  let inkPixels = 0;
  let hRuns = 0;
  let vRuns = 0;

  // Helper: is pixel (x, y) part of a feature thick enough to be a wall
  // in the H direction (i.e., has at least minThickness-1 adjacent ink
  // pixels above/below)? Returns true iff the pixel is ink AND enough
  // of its vertical neighbors are also ink.
  const isWallInkH = (x: number, y: number): boolean => {
    if (samples[y * pxW + x] >= threshold) return false;
    if (isMaskedText(x, y)) return false;
    if (minThickness <= 1) return true;
    let neighbors = 0;
    const need = minThickness - 1;
    for (let dy = 1; dy <= need; dy++) {
      if (y + dy < pxH && samples[(y + dy) * pxW + x] < threshold) neighbors++;
      if (y - dy >= 0 && samples[(y - dy) * pxW + x] < threshold) neighbors++;
      if (neighbors >= need) return true;
    }
    return neighbors >= need;
  };
  const isWallInkV = (x: number, y: number): boolean => {
    if (samples[y * pxW + x] >= threshold) return false;
    if (isMaskedText(x, y)) return false;
    if (minThickness <= 1) return true;
    let neighbors = 0;
    const need = minThickness - 1;
    for (let dx = 1; dx <= need; dx++) {
      if (x + dx < pxW && samples[y * pxW + (x + dx)] < threshold) neighbors++;
      if (x - dx >= 0 && samples[y * pxW + (x - dx)] < threshold) neighbors++;
      if (neighbors >= need) return true;
    }
    return neighbors >= need;
  };

  // ── Horizontal sweep: ink-runs along rows → horizontal wall segments ──
  for (let y = 0; y < pxH; y++) {
    const rowStart = y * pxW;
    let runStart = -1;
    for (let x = 0; x < pxW; x++) {
      const raw = samples[rowStart + x] < threshold;
      if (raw) inkPixels++;
      const ink = raw && isWallInkH(x, y);
      if (ink) {
        if (runStart < 0) runStart = x;
      } else if (runStart >= 0) {
        if (x - runStart >= minWallPx) {
          const py = pointFromY(y);
          segments.push({
            x1: pointFromX(runStart),
            y1: py,
            x2: pointFromX(x),
            y2: py,
            orientation: "h",
          });
          hRuns++;
        }
        runStart = -1;
      }
    }
    if (runStart >= 0 && pxW - runStart >= minWallPx) {
      const py = pointFromY(y);
      segments.push({
        x1: pointFromX(runStart),
        y1: py,
        x2: pointFromX(pxW),
        y2: py,
        orientation: "h",
      });
      hRuns++;
    }
  }

  // ── Vertical sweep: ink-runs along columns → vertical wall segments ──
  for (let x = 0; x < pxW; x++) {
    let runStart = -1;
    for (let y = 0; y < pxH; y++) {
      const raw = samples[y * pxW + x] < threshold;
      const ink = raw && isWallInkV(x, y);
      if (ink) {
        if (runStart < 0) runStart = y;
      } else if (runStart >= 0) {
        if (y - runStart >= minWallPx) {
          const px = pointFromX(x);
          segments.push({
            x1: px,
            y1: pointFromY(runStart),
            x2: px,
            y2: pointFromY(y),
            orientation: "v",
          });
          vRuns++;
        }
        runStart = -1;
      }
    }
    if (runStart >= 0 && pxH - runStart >= minWallPx) {
      const px = pointFromX(x);
      segments.push({
        x1: px,
        y1: pointFromY(runStart),
        x2: px,
        y2: pointFromY(pxH),
        orientation: "v",
      });
      vRuns++;
    }
  }

  pixmap.destroy?.();

  return {
    pageWidthPt,
    pageHeightPt,
    segments,
    dpi,
    elapsedMs: Date.now() - t0,
    stats: {
      pixelsWidth: pxW,
      pixelsHeight: pxH,
      inkPixels,
      horizontalRuns: hRuns,
      verticalRuns: vRuns,
    },
  };
}
