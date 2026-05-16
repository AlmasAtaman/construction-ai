/**
 * Scale anchor extraction.
 *
 * Architectural plans declare their scale in plain text near the title
 * block (e.g. `SCALE: 1/8" = 1'-0"`). Once parsed, every measurement on
 * the page converts deterministically from PDF points to real feet —
 * no AI guessing, no calibration drift.
 *
 * Conversion math (1 PDF point = 1/72 inch):
 *   ratio = drawingInchesPerFoot (the small number, e.g. 1/8")
 *   ptPerFoot = 72 × ratio
 *   sqftPerSqPt = 1 / ptPerFoot²
 *
 * Common arch scales:
 *   1/16" = 1'  → 4.5 pt/ft  →   20.25 pt²/sqft
 *   3/32" = 1'  → 6.75 pt/ft →   45.56 pt²/sqft
 *   1/8"  = 1'  → 9 pt/ft    →   81 pt²/sqft     (most floor plans)
 *   3/16" = 1'  → 13.5 pt/ft → 182.25 pt²/sqft
 *   1/4"  = 1'  → 18 pt/ft   →  324 pt²/sqft     (small spaces)
 *   3/8"  = 1'  → 27 pt/ft   →  729 pt²/sqft
 *   1/2"  = 1'  → 36 pt/ft   → 1296 pt²/sqft     (details)
 *
 * The parser also accepts the implicit form ("1/8 = 1'-0") without
 * the inch marks, and metric scales (1:50, 1:100) for export-from-EU
 * plans. Metric: 1:N means 1 mm = N mm in reality. 1 pt = 0.3528 mm.
 *
 * Returns null if no recognizable scale is found — the caller should
 * fall back to AI-estimated geometry in that case.
 */

export interface ScaleAnchor {
  /** Raw matched text, e.g. `SCALE: 1/8" = 1'-0"` */
  rawText: string;
  /** Position of the matched text in PDF page space, if known. */
  x?: number;
  y?: number;
  /** PDF points per foot. e.g. 1/8":1' → 9. */
  ptPerFoot: number;
  /** PDF points² per square foot. ptPerFoot². */
  ptPerSqFt: number;
  /** Source notation kind. */
  kind: "imperial" | "metric";
  /** Human-readable label for UI. */
  label: string;
  /** Confidence in the match. */
  confidence: number;
}

export interface ScaleSearchInput {
  text: string;
  x?: number;
  y?: number;
}

const FRACTION_MAP: Record<string, number> = {
  "1/64": 1 / 64,
  "1/32": 1 / 32,
  "3/64": 3 / 64,
  "1/16": 1 / 16,
  "3/32": 3 / 32,
  "1/8": 1 / 8,
  "5/32": 5 / 32,
  "3/16": 3 / 16,
  "1/4": 1 / 4,
  "5/16": 5 / 16,
  "3/8": 3 / 8,
  "1/2": 1 / 2,
  "3/4": 3 / 4,
  "1": 1,
  "1 1/2": 1.5,
  "3": 3,
};

/**
 * Try to find a scale anchor in the text fragments. Returns the highest-
 * confidence match (or null if no plausible match exists).
 */
export function detectScaleAnchor(
  fragments: ScaleSearchInput[],
): ScaleAnchor | null {
  // Look for two-line scale notations first (the most common form):
  //   "SCALE:" or "SCALE" on one line, "1/8" = 1'-0"" on an adjacent line
  // and one-line forms:
  //   "SCALE: 1/8" = 1'-0""
  //   "1/8" = 1'-0""
  //   "SCALE 1/4\" = 1\"-0\""
  //   "1:50" or "1:100" (metric)
  const candidates: ScaleAnchor[] = [];

  for (let i = 0; i < fragments.length; i++) {
    const t = fragments[i].text;
    const x = fragments[i].x;
    const y = fragments[i].y;

    // Single-line imperial form
    const imp = matchImperialScale(t);
    if (imp) {
      candidates.push({
        rawText: t,
        x,
        y,
        ptPerFoot: imp.ptPerFoot,
        ptPerSqFt: imp.ptPerFoot * imp.ptPerFoot,
        kind: "imperial",
        label: imp.label,
        confidence: imp.confidence,
      });
    }

    // Single-line metric form
    const met = matchMetricScale(t);
    if (met) {
      candidates.push({
        rawText: t,
        x,
        y,
        ptPerFoot: met.ptPerFoot,
        ptPerSqFt: met.ptPerFoot * met.ptPerFoot,
        kind: "metric",
        label: met.label,
        confidence: met.confidence,
      });
    }

    // Two-line form: this fragment is the label, next is the value
    if (/^scale\s*:?\s*$/i.test(t.trim())) {
      // Try the next 1-2 fragments
      for (let j = 1; j <= 2 && i + j < fragments.length; j++) {
        const next = fragments[i + j].text;
        const impNext = matchImperialScale(next);
        if (impNext) {
          candidates.push({
            rawText: `${t} ${next}`,
            x,
            y,
            ptPerFoot: impNext.ptPerFoot,
            ptPerSqFt: impNext.ptPerFoot * impNext.ptPerFoot,
            kind: "imperial",
            label: impNext.label,
            // Two-line match is high confidence (explicit "SCALE:" label)
            confidence: Math.min(0.99, impNext.confidence + 0.1),
          });
          break;
        }
        const metNext = matchMetricScale(next);
        if (metNext) {
          candidates.push({
            rawText: `${t} ${next}`,
            x,
            y,
            ptPerFoot: metNext.ptPerFoot,
            ptPerSqFt: metNext.ptPerFoot * metNext.ptPerFoot,
            kind: "metric",
            label: metNext.label,
            confidence: Math.min(0.99, metNext.confidence + 0.1),
          });
          break;
        }
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates[0];
}

/**
 * Match imperial scale notations:
 *   1/8" = 1'-0"   (most common, with inch marks)
 *   1/8 = 1'-0     (no inch marks)
 *   1/8" = 1'      (short)
 *   1/4" = 1'-0"
 *   1" = 1'-0"
 */
function matchImperialScale(
  text: string,
): { ptPerFoot: number; label: string; confidence: number } | null {
  const t = text.trim();
  if (t.length === 0 || t.length > 60) return null;

  // Pattern: <fraction>["]?  =  <number>[']  [- <number>"]?
  // Examples to match:
  //   "1/8\" = 1'-0\""
  //   "1/8 = 1'-0"
  //   "3/16\" = 1'"
  //   "SCALE: 1/8\" = 1'-0\""
  const re =
    /(\d{1,2}(?:\s*\/\s*\d{1,3})?|\d+\s+\d+\s*\/\s*\d+)\s*["”″]?\s*=\s*(\d+)\s*['’′]\s*(?:[-–]\s*(\d+)\s*["”″]?)?/i;
  const m = re.exec(t);
  if (!m) return null;

  const numerator = m[1].replace(/\s/g, "");
  const inchesNumStr = FRACTION_MAP[numerator] !== undefined
    ? numerator
    : numerator.replace(/^\s+|\s+$/g, "");
  const drawingInches = FRACTION_MAP[inchesNumStr];
  if (drawingInches === undefined || drawingInches <= 0) return null;
  const realFt = parseInt(m[2], 10);
  if (!Number.isFinite(realFt) || realFt <= 0) return null;
  const realIn = m[3] ? parseInt(m[3], 10) : 0;
  if (!Number.isFinite(realIn) || realIn < 0) return null;
  const realInchesTotal = realFt * 12 + realIn;
  if (realInchesTotal <= 0) return null;

  // (drawingInches on paper) corresponds to (realInchesTotal in reality).
  // 1 pt = 1/72 inch on paper.
  // Real inches per drawing point = realInchesTotal / drawingInches / 72.
  // Real feet per pt = realInchesPerPt / 12.
  // Pt per foot = 1 / realFeetPerPt = 12 * 72 * drawingInches / realInchesTotal.
  const ptPerFoot = (12 * 72 * drawingInches) / realInchesTotal;
  if (!Number.isFinite(ptPerFoot) || ptPerFoot < 1 || ptPerFoot > 1000) return null;

  const label =
    realIn > 0
      ? `${inchesNumStr}" = ${realFt}'-${realIn}"`
      : `${inchesNumStr}" = ${realFt}'-0"`;

  // Confidence: lower if the text was just the value alone (no "SCALE"
  // prefix), higher if "SCALE" appeared in the same fragment.
  const hasScaleWord = /\bscale\b/i.test(t);
  const confidence = hasScaleWord ? 0.92 : 0.75;
  return { ptPerFoot, label, confidence };
}

/**
 * Match metric scale notations: "1:50", "1:100", "1:200", "SCALE 1:50".
 * 1 PDF pt = 1/72 inch = 0.3528 mm. So 1 m on paper at 1:N = (1000 mm × N) in reality.
 * Pt per metre real = 72 × 25.4 / N / 1000 = 1.8288 / N pt/mm = 1828.8/N pt/m.
 * Pt per foot = pt/m × 0.3048 m/ft = 557.6/N pt/ft.
 */
function matchMetricScale(
  text: string,
): { ptPerFoot: number; label: string; confidence: number } | null {
  const t = text.trim();
  if (t.length === 0 || t.length > 60) return null;
  const re = /(?:scale\s*[:=]?\s*)?1\s*:\s*(\d{2,4})\b/i;
  const m = re.exec(t);
  if (!m) return null;
  const N = parseInt(m[1], 10);
  if (!Number.isFinite(N) || N < 10 || N > 5000) return null;

  // PDF: 1 pt = 1/72 inch = 0.35278 mm.
  // At 1:N, 1 mm on paper = N mm in reality.
  // 1 pt on paper = 0.35278 mm on paper = 0.35278 × N mm in reality.
  // 1 foot = 304.8 mm.
  // Pt per foot = 304.8 / (0.35278 × N) = 863.6 / N.
  const ptPerFoot = 863.6 / N;
  if (!Number.isFinite(ptPerFoot) || ptPerFoot < 0.5 || ptPerFoot > 1000)
    return null;

  const hasScaleWord = /\bscale\b/i.test(t);
  const confidence = hasScaleWord ? 0.9 : 0.6;
  return { ptPerFoot, label: `1:${N}`, confidence };
}
