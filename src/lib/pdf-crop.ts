import sharp from "sharp";

/**
 * Crop a region around a normalized (x, y) point in an image, then resize
 * the crop back up to the vision-token sweet spot. Used for per-room
 * cropping: feeding the AI a focused view of one room dramatically
 * reduces the polygon-merge bug on dense commercial plans.
 *
 * The crop is centered on the label position but clamped to image bounds.
 * Crop SIZE (as a fraction of the original image's long edge) is picked
 * so a typical 50x50 ft room fills most of the frame at the resulting
 * 1568-px output.
 */
export interface CropOptions {
  /** Normalized 0..1 center of the crop. */
  xNorm: number;
  yNorm: number;
  /** Crop size as a fraction of the source image's long edge. */
  sizeNorm?: number;
  /** Target long-edge of the output, in px. */
  outputLongEdgePx?: number;
}

export interface Crop {
  imageBase64: string;
  imageMediaType: "image/jpeg";
  /** Crop window in source-image normalized coords. */
  sourceWindow: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  };
  widthPx: number;
  heightPx: number;
}

export async function cropImageAroundPoint(
  imageBase64: string,
  imageMediaType: "image/jpeg" | "image/png",
  sourceWidthPx: number,
  sourceHeightPx: number,
  opts: CropOptions,
): Promise<Crop> {
  const sizeNorm = opts.sizeNorm ?? 0.32; // ~32% of long edge default
  const outputLongEdge = opts.outputLongEdgePx ?? 1568;

  const longEdgePx = Math.max(sourceWidthPx, sourceHeightPx);
  const halfPx = Math.round((sizeNorm * longEdgePx) / 2);
  const cxPx = Math.round(opts.xNorm * sourceWidthPx);
  const cyPx = Math.round(opts.yNorm * sourceHeightPx);

  // Clamp window to image bounds.
  let x0 = Math.max(0, cxPx - halfPx);
  let y0 = Math.max(0, cyPx - halfPx);
  let x1 = Math.min(sourceWidthPx, cxPx + halfPx);
  let y1 = Math.min(sourceHeightPx, cyPx + halfPx);
  // Re-expand the other side if we clamped, so the crop keeps its
  // intended size when the label is near a page edge.
  if (x1 - x0 < 2 * halfPx) {
    if (x0 === 0) x1 = Math.min(sourceWidthPx, 2 * halfPx);
    else x0 = Math.max(0, sourceWidthPx - 2 * halfPx);
  }
  if (y1 - y0 < 2 * halfPx) {
    if (y0 === 0) y1 = Math.min(sourceHeightPx, 2 * halfPx);
    else y0 = Math.max(0, sourceHeightPx - 2 * halfPx);
  }

  const cropW = x1 - x0;
  const cropH = y1 - y0;

  const source = Buffer.from(imageBase64, "base64");
  const cropped = await sharp(source)
    .extract({ left: x0, top: y0, width: cropW, height: cropH })
    .resize({
      width: outputLongEdge,
      height: outputLongEdge,
      fit: "inside",
      withoutEnlargement: false,
    })
    .grayscale()
    .normalize()
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  return {
    imageBase64: cropped.data.toString("base64"),
    imageMediaType: "image/jpeg",
    sourceWindow: {
      x0: x0 / sourceWidthPx,
      y0: y0 / sourceHeightPx,
      x1: x1 / sourceWidthPx,
      y1: y1 / sourceHeightPx,
    },
    widthPx: cropped.info.width,
    heightPx: cropped.info.height,
  };
}
