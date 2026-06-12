/**
 * Layer-aware vector extraction (PDF Optional Content Groups).
 *
 * CAD-exported tender sets usually preserve the architect's AutoCAD layer
 * structure as PDF OCGs (e.g. "2103118_Base|FP-N-WALL" vs "…|FP-N-DIMS").
 * That metadata separates walls from dimension ladders / tile hatching
 * deterministically — the classification that geometry and vision models
 * both fail at on dense commercial sheets.
 *
 * This module is deliberately separate from page-extract.ts so the room
 * detector / scale engine keep their proven input untouched. Some honest
 * duplication of the walk-device code is the price for zero risk there.
 */

// Mirror page-extract.ts thresholds so layer-filtered and full scans are
// directly comparable.
const MIN_SEGMENT_PT = 5;
const AXIS_TOLERANCE_PT = 1.5;
const DIAGONAL_MIN_PT = 50;

export interface LayerSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** OCG name the segment was drawn under; null = not layer-wrapped. */
  layer: string | null;
  diagonal: boolean;
}

export interface LayerScanResult {
  /** Unique OCG names declared in the document (may exceed page usage). */
  layerNames: string[];
  /** H/V + long-diagonal stroke segments on this page, layer-tagged. */
  segments: LayerSegment[];
  /** Segment count per layer actually drawn on this page. */
  segmentsPerLayer: Record<string, number>;
  pageWidthPt: number;
  pageHeightPt: number;
}

interface MupdfDocLike {
  countLayers: () => number;
  getLayerName: (i: number) => string;
  loadPage: (i: number) => {
    getBounds: () => number[];
    run: (device: unknown, matrix: unknown) => void;
  };
}

/**
 * Scan one page's vector strokes, tagging each segment with the OCG layer
 * it was drawn under (via beginLayer/endLayer marked-content callbacks).
 * Single pass with all layers visible — selection happens downstream.
 */
export async function scanSegmentsByLayer(
  pdfBuffer: Buffer,
  pageNumber: number,
): Promise<LayerScanResult> {
  const mupdf = await import("mupdf");
  const doc = (
    mupdf as unknown as {
      Document: {
        openDocument: (d: Uint8Array, mime: string) => MupdfDocLike;
      };
    }
  ).Document.openDocument(new Uint8Array(pdfBuffer), "application/pdf");

  const layerNames: string[] = [];
  {
    const seen = new Set<string>();
    const n = doc.countLayers();
    for (let i = 0; i < n; i++) {
      const name = doc.getLayerName(i);
      if (name && !seen.has(name)) {
        seen.add(name);
        layerNames.push(name);
      }
    }
  }

  const page = doc.loadPage(pageNumber - 1);
  const bounds = page.getBounds();
  const pageWidthPt = bounds[2] - bounds[0];
  const pageHeightPt = bounds[3] - bounds[1];

  const segments: LayerSegment[] = [];
  const segmentsPerLayer: Record<string, number> = {};

  // Marked-content layers can nest; the innermost BDC wins.
  const layerStack: string[] = [];
  const currentLayer = (): string | null =>
    layerStack.length > 0 ? layerStack[layerStack.length - 1] : null;

  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const tx = (ctm: number[], x: number, y: number): [number, number] => [
    ctm[0] * x + ctm[2] * y + ctm[4],
    ctm[1] * x + ctm[3] * y + ctm[5],
  ];
  function emit(x1: number, y1: number, x2: number, y2: number): void {
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const len = Math.hypot(dx, dy);
    if (len < MIN_SEGMENT_PT) return;
    const layer = currentLayer();
    let seg: LayerSegment | null = null;
    if (dy < AXIS_TOLERANCE_PT && dx > AXIS_TOLERANCE_PT) {
      seg = { x1, y1, x2, y2: y1, layer, diagonal: false };
    } else if (dx < AXIS_TOLERANCE_PT && dy > AXIS_TOLERANCE_PT) {
      seg = { x1, y1, x2: x1, y2, layer, diagonal: false };
    } else if (len >= DIAGONAL_MIN_PT) {
      seg = { x1, y1, x2, y2, layer, diagonal: true };
    }
    if (seg) {
      segments.push(seg);
      if (layer) segmentsPerLayer[layer] = (segmentsPerLayer[layer] ?? 0) + 1;
    }
  }
  function collect(p: { walk: (v: unknown) => void }, ctm: number[]): void {
    p.walk({
      moveTo: (x: number, y: number) => {
        [cx, cy] = tx(ctm, x, y);
        sx = cx;
        sy = cy;
      },
      lineTo: (x: number, y: number) => {
        const [nx, ny] = tx(ctm, x, y);
        emit(cx, cy, nx, ny);
        cx = nx;
        cy = ny;
      },
      curveTo: (
        _c1x: number,
        _c1y: number,
        _c2x: number,
        _c2y: number,
        ex: number,
        ey: number,
      ) => {
        [cx, cy] = tx(ctm, ex, ey);
      },
      closePath: () => {
        emit(cx, cy, sx, sy);
        cx = sx;
        cy = sy;
      },
    });
  }

  const device = new (
    mupdf as unknown as { Device: new (handlers: unknown) => unknown }
  ).Device({
    beginLayer: (name: string) => {
      layerStack.push(name);
    },
    endLayer: () => {
      layerStack.pop();
    },
    fillPath: (p: { walk: (v: unknown) => void }, _: unknown, ctm: number[]) =>
      collect(p, ctm),
    strokePath: (
      p: { walk: (v: unknown) => void },
      _: unknown,
      ctm: number[],
    ) => collect(p, ctm),
  });
  page.run(device, (mupdf as unknown as { Matrix: { identity: unknown } }).Matrix.identity);

  return { layerNames, segments, segmentsPerLayer, pageWidthPt, pageHeightPt };
}
