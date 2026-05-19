/**
 * Graphic scale-bar detection.
 *
 * Architectural plans without a printed `1/8" = 1'-0"` notation still
 * usually carry a *graphic* scale bar near the title block: a short
 * horizontal (or vertical) ruler labelled with feet, like
 *
 *     0    4'        8'                  16'
 *     |————|—————————|————————————————————|
 *
 * The labels are short text fragments matching `\d+'`. They share a
 * y-coordinate (within a few PDF points), they're proportionally spaced,
 * and the ratio is recoverable directly from their printed values and
 * positions — no graphic primitive analysis required.
 *
 * Algorithm (deliberately simple — graphic-primitive matching is brittle
 * across renderers):
 *
 *   1. Filter text fragments down to ones whose trimmed text matches
 *      a "feet label" pattern: an integer optionally followed by `'`.
 *      e.g. "0", "4", "4'", "8'", "16'".
 *   2. Cluster fragments by y-coordinate (within `Y_TOLERANCE_PT`). Same
 *      with x for vertical bars.
 *   3. Inside a cluster of ≥ 3 labels, sort by position, and check that
 *      `ptPerFoot` derived from every consecutive pair is consistent
 *      within `CONSISTENCY_TOL` (15 %). The cluster's ptPerFoot is the
 *      median of the pairwise estimates.
 *   4. Discard clusters whose derived ptPerFoot is outside a plausible
 *      arch range (1 pt/ft to 200 pt/ft).
 *   5. Return the highest-feet cluster (a `0..16'` bar is more reliable
 *      than a `0..4'` bar — it integrates over more pixels).
 *
 * False-positive guards:
 *   - Labels must include at least one value ≥ 4 ft. Two `0` and `1`
 *     fragments don't qualify.
 *   - The cluster x-span must be at least 30 PDF pt — anything shorter
 *     is a row of room-number callouts, not a scale ruler.
 *   - The implied ratio must round-trip: re-applying it to the labels
 *     must reproduce their positions within ±15 % of the printed values.
 */

export interface FeetLabel {
  text: string;
  /** Position in PDF user space (y-up). */
  x: number;
  y: number;
  /** Parsed value in feet. */
  ft: number;
}

export interface ScaleBarHit {
  ptPerFoot: number;
  /** Display label for the UI, e.g. "Scale bar: 16 ft = 144 pt". */
  label: string;
  /** 0..1 — increases with bar length and consistency. */
  confidence: number;
  /** Orientation of the bar. */
  orientation: "horizontal" | "vertical";
  /** Bbox of the cluster in PDF user space (y-up). */
  bboxPt: { x0: number; y0: number; x1: number; y1: number };
  /** Labels used (debug). */
  labels: FeetLabel[];
}

export interface ScaleBarInput {
  text: string;
  /** PDF user space (y-up). */
  x: number;
  y: number;
}

const Y_TOLERANCE_PT = 6;
const X_TOLERANCE_PT = 6;
const CONSISTENCY_TOL = 0.15;
const MIN_SPAN_PT = 30;
const MIN_BAR_FEET = 4;
const MIN_PT_PER_FT = 1;
const MAX_PT_PER_FT = 200;

// "0", "4", "4'", "8'", "16'", "16 ft", "20FT". Must be a pure label —
// no surrounding text. Apostrophe variants accepted.
const FEET_RE =
  /^\s*(\d{1,3})\s*(?:['‘’′]|\s*(?:ft|FT|Ft))?\s*$/;

function parseFeetLabel(text: string): number | null {
  const m = FEET_RE.exec(text);
  if (!m) return null;
  const v = parseInt(m[1], 10);
  if (!Number.isFinite(v) || v < 0 || v > 500) return null;
  return v;
}

/**
 * Detect a graphic scale bar from the page's text fragments alone.
 * Returns null when no plausible bar exists.
 */
export function detectScaleBar(fragments: ScaleBarInput[]): ScaleBarHit | null {
  const labels: FeetLabel[] = [];
  for (const f of fragments) {
    const ft = parseFeetLabel(f.text);
    if (ft === null) continue;
    labels.push({ text: f.text.trim(), x: f.x, y: f.y, ft });
  }
  if (labels.length < 3) return null;

  const hits: ScaleBarHit[] = [];

  hits.push(...detectAxis(labels, "horizontal"));
  hits.push(...detectAxis(labels, "vertical"));

  if (hits.length === 0) return null;
  // Prefer the bar with the largest feet span (more pixels averaged →
  // smaller error). Break ties on confidence.
  hits.sort((a, b) => {
    const aSpan = spanFeet(a.labels);
    const bSpan = spanFeet(b.labels);
    if (bSpan !== aSpan) return bSpan - aSpan;
    return b.confidence - a.confidence;
  });
  return hits[0];
}

function spanFeet(labels: FeetLabel[]): number {
  let min = Infinity;
  let max = -Infinity;
  for (const l of labels) {
    if (l.ft < min) min = l.ft;
    if (l.ft > max) max = l.ft;
  }
  return max - min;
}

function detectAxis(
  labels: FeetLabel[],
  orientation: "horizontal" | "vertical",
): ScaleBarHit[] {
  // Cluster labels along the bar's transverse axis. Horizontal bars
  // share y; vertical bars share x.
  const tolerance = orientation === "horizontal" ? Y_TOLERANCE_PT : X_TOLERANCE_PT;
  const transverse = (l: FeetLabel) => (orientation === "horizontal" ? l.y : l.x);
  const along = (l: FeetLabel) => (orientation === "horizontal" ? l.x : l.y);

  // Single-linkage cluster on the transverse coord.
  const sorted = [...labels].sort((a, b) => transverse(a) - transverse(b));
  const clusters: FeetLabel[][] = [];
  let current: FeetLabel[] = [];
  let lastT = -Infinity;
  for (const l of sorted) {
    const t = transverse(l);
    if (current.length === 0 || t - lastT <= tolerance) {
      current.push(l);
    } else {
      if (current.length >= 3) clusters.push(current);
      current = [l];
    }
    lastT = t;
  }
  if (current.length >= 3) clusters.push(current);

  const hits: ScaleBarHit[] = [];
  for (const cluster of clusters) {
    const hit = scoreCluster(cluster, orientation, along);
    if (hit) hits.push(hit);
  }
  return hits;
}

function scoreCluster(
  cluster: FeetLabel[],
  orientation: "horizontal" | "vertical",
  along: (l: FeetLabel) => number,
): ScaleBarHit | null {
  // Sort along the bar and de-dup same-coord same-value entries
  // (PDFs sometimes emit a label twice from overlapping text runs).
  const dedup: FeetLabel[] = [];
  for (const l of [...cluster].sort((a, b) => along(a) - along(b))) {
    const prev = dedup[dedup.length - 1];
    if (
      prev &&
      Math.abs(along(prev) - along(l)) < 1 &&
      prev.ft === l.ft
    ) {
      continue;
    }
    dedup.push(l);
  }
  if (dedup.length < 3) return null;

  // Need at least one label ≥ MIN_BAR_FEET. A `0,1,2` cluster looks like
  // a scale bar mathematically but rarely is one — those small numbers
  // appear elsewhere (room counts, callout indices).
  if (!dedup.some((l) => l.ft >= MIN_BAR_FEET)) return null;

  // Distinct printed values, please. A row of `4', 4', 4'` is the same
  // value repeated; ptPerFt is undefined.
  const distinct = new Set(dedup.map((l) => l.ft));
  if (distinct.size < 3) return null;

  // Span sanity: at least MIN_SPAN_PT and at least MIN_BAR_FEET printed
  // foot-span. Smaller spans don't measure plan distance well.
  const ptSpan = along(dedup[dedup.length - 1]) - along(dedup[0]);
  const ftSpan = dedup[dedup.length - 1].ft - dedup[0].ft;
  if (ptSpan < MIN_SPAN_PT) return null;
  if (ftSpan < MIN_BAR_FEET) return null;

  // Pairwise ptPerFt. Drop pairs with ftDelta = 0 (repeated labels);
  // demand consistency across the rest.
  const ratios: number[] = [];
  for (let i = 1; i < dedup.length; i++) {
    const dPt = along(dedup[i]) - along(dedup[i - 1]);
    const dFt = dedup[i].ft - dedup[i - 1].ft;
    if (dFt <= 0) continue;
    const r = dPt / dFt;
    if (!Number.isFinite(r) || r <= 0) continue;
    ratios.push(r);
  }
  if (ratios.length < 2) return null;

  const median = medianOf(ratios);
  if (median < MIN_PT_PER_FT || median > MAX_PT_PER_FT) return null;
  // Every pairwise estimate must be within CONSISTENCY_TOL of the median.
  for (const r of ratios) {
    if (Math.abs(r - median) / median > CONSISTENCY_TOL) return null;
  }

  // Round-trip check: predicted positions vs. actual.
  const origin = along(dedup[0]);
  const originFt = dedup[0].ft;
  let maxResidual = 0;
  for (const l of dedup) {
    const predicted = origin + (l.ft - originFt) * median;
    const residual = Math.abs(predicted - along(l));
    maxResidual = Math.max(maxResidual, residual);
  }
  // residual must be small relative to the bar's pt span
  if (maxResidual > ptSpan * CONSISTENCY_TOL) return null;

  // Confidence: scales with feet-span (more printed values = more
  // averaging) and with how tightly ratios cluster.
  const spread =
    ratios.reduce((m, r) => Math.max(m, Math.abs(r - median) / median), 0) || 0.0001;
  const confidence = Math.min(
    0.95,
    0.55 + Math.min(0.25, ftSpan / 64) + Math.min(0.15, 0.15 - spread),
  );

  // Cluster bbox in PDF y-up coords.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of dedup) {
    if (l.x < x0) x0 = l.x;
    if (l.y < y0) y0 = l.y;
    if (l.x > x1) x1 = l.x;
    if (l.y > y1) y1 = l.y;
  }

  return {
    ptPerFoot: median,
    label: `Scale bar: ${dedup[0].ft}–${dedup[dedup.length - 1].ft} ft`,
    confidence,
    orientation,
    bboxPt: { x0, y0, x1, y1 },
    labels: dedup,
  };
}

function medianOf(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
