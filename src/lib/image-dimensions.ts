/**
 * OCR-based dimension callout extraction.
 *
 * Many architectural PDFs have the floor plan embedded as a raster
 * image with vector overlays for annotations. Dimension callouts
 * printed on that raster (12'-6", 24'-0", etc.) are invisible to
 * pdfjs's text-layer extractor. We OCR the rendered page to recover
 * them.
 *
 * Tesseract.js is a pure-JS WASM port — no native binaries, no
 * Windows install hassle, no API cost. On a 150-DPI render of a
 * commercial floor plan (~6300×4500 px) it takes 20-60 seconds.
 * Output: text + bounding box per word.
 *
 * We restrict the recognized character set to digits, primes, quotes,
 * dashes, fractions — the alphabet of dimension callouts. This both
 * speeds OCR up and cuts false positives from text glyphs that aren't
 * dimensions.
 *
 * The output is fed back through the same dimension-callout parser
 * used for vector text, so downstream code doesn't care whether the
 * callout came from vector or OCR.
 */

import { parseDimensionCallouts, type DimensionCallout } from "./dimension-callouts";

export interface OcrDimensionsOptions {
  /** Render DPI for OCR. Default 200 — higher = better OCR, slower. */
  dpi?: number;
  /**
   * Optional text bounding boxes (PDF page space, Y up) to mask out
   * before OCR. Skip vector text regions — they're already covered by
   * the vector pipeline and would just add noise.
   */
  excludeRegions?: { x: number; y: number; width: number; height: number }[];
  /** Padding around excludeRegions, in PDF points. Default 4. */
  excludeRegionPadPt?: number;
}

export interface OcrDimensionsResult {
  pageWidthPt: number;
  pageHeightPt: number;
  callouts: DimensionCallout[];
  /** Diagnostics. */
  stats: {
    pixelsWidth: number;
    pixelsHeight: number;
    wordsRecognized: number;
    calloutsExtracted: number;
    ocrMs: number;
  };
  elapsedMs: number;
}

const DPI_DEFAULT = 200;

interface MupdfPath {
  walk: (visitor: {
    moveTo: (x: number, y: number) => void;
    lineTo: (x: number, y: number) => void;
    closePath: () => void;
  }) => void;
}

/**
 * OCR the rendered page and return dimension callouts in PDF coords.
 */
export async function ocrPageDimensions(
  pdfBuffer: Buffer,
  pageNumber: number,
  opts: OcrDimensionsOptions = {},
): Promise<OcrDimensionsResult> {
  const t0 = Date.now();
  const dpi = opts.dpi ?? DPI_DEFAULT;
  const excludePad = opts.excludeRegionPadPt ?? 4;

  // 1. Render the page to grayscale via MuPDF.
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
      asPNG: () => Uint8Array;
      destroy?: () => void;
    };
  }).toPixmap(matrix, cs);

  // Mask out excluded regions by overwriting pixels with white (255).
  if (opts.excludeRegions && opts.excludeRegions.length > 0) {
    const samples = pixmap.getPixels();
    const pxW = pixmap.getWidth();
    const pxH = pixmap.getHeight();
    const pxPerPt = dpi / 72;
    for (const r of opts.excludeRegions) {
      const ix0 = Math.max(0, Math.floor((r.x - excludePad) * pxPerPt));
      const ix1 = Math.min(pxW, Math.ceil((r.x + r.width + excludePad) * pxPerPt));
      const iy0 = Math.max(
        0,
        Math.floor((pageHeightPt - (r.y + r.height + excludePad)) * pxPerPt),
      );
      const iy1 = Math.min(
        pxH,
        Math.ceil((pageHeightPt - (r.y - excludePad)) * pxPerPt),
      );
      for (let y = iy0; y < iy1; y++) {
        const rs = y * pxW;
        for (let x = ix0; x < ix1; x++) samples[rs + x] = 255;
      }
    }
  }

  const png = pixmap.asPNG();
  const pxW = pixmap.getWidth();
  const pxH = pixmap.getHeight();
  pixmap.destroy?.();

  // 2. Run Tesseract OCR. We do NOT use a character whitelist because
  // Tesseract's line detection seems to drop short tokens (like "12'-6\"")
  // when restricted. Instead we filter callouts in post-processing.
  // Pass the blocks output flag so we get word-level bounding boxes.
  const tess = await import("tesseract.js");
  const ocrT0 = Date.now();
  const worker = await tess.createWorker("eng");
  const ocrResult = await worker.recognize(
    Buffer.from(png),
    {},
    { blocks: true },
  );
  await worker.terminate();
  const ocrMs = Date.now() - ocrT0;

  // 3. Convert Tesseract words → PDF-coord text fragments → callouts.
  type TessWord = {
    text: string;
    bbox: { x0: number; y0: number; x1: number; y1: number };
  };
  // Different tesseract.js versions expose words at different paths.
  const data = ocrResult.data as {
    words?: TessWord[];
    blocks?: { paragraphs?: { lines?: { words?: TessWord[] }[] }[] }[];
  };
  let words: TessWord[] = data.words ?? [];
  // Newer tesseract.js (5.x) only emits text by default — need to walk
  // blocks if available, else parse the raw text for token positions.
  if (words.length === 0 && data.blocks) {
    for (const b of data.blocks)
      for (const p of b.paragraphs ?? [])
        for (const l of p.lines ?? [])
          for (const w of l.words ?? []) words.push(w);
  }
  const pxPerPt = dpi / 72;
  const pointFromX = (px: number): number => px / pxPerPt;
  const pointFromY = (py: number): number => pageHeightPt - py / pxPerPt;

  const ocrFragments = words.map((w) => {
    const cx = (w.bbox.x0 + w.bbox.x1) / 2;
    const cy = (w.bbox.y0 + w.bbox.y1) / 2;
    return {
      text: w.text.trim(),
      x: pointFromX(cx),
      y: pointFromY(cy),
      // Rotation isn't reliably reported by Tesseract; leave undefined
      // so the parser doesn't fake an orientation.
      rotation: undefined,
    };
  });

  const callouts = parseDimensionCallouts(ocrFragments);

  return {
    pageWidthPt,
    pageHeightPt,
    callouts,
    stats: {
      pixelsWidth: pxW,
      pixelsHeight: pxH,
      wordsRecognized: words.length,
      calloutsExtracted: callouts.length,
      ocrMs,
    },
    elapsedMs: Date.now() - t0,
  };
}
