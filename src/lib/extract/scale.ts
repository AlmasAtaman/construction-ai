/**
 * Unified scale establishment.
 *
 * The measurement engine needs *exactly one* `ptPerFoot` per page,
 * along with a record of how that value was obtained. Three sources
 * exist, tried in this priority order:
 *
 *   1. text-notation  — `SCALE: 1/8" = 1'-0"`, `1:200`, etc. Parsed
 *                       deterministically from the PDF text layer by
 *                       `detectScaleAnchor`. Cross-checked against door
 *                       widths when door-symbol candidates exist.
 *   2. scale-bar      — a graphic ruler labelled in feet (`0 4' 8' 16'`).
 *                       Detected purely from text-fragment geometry by
 *                       `detectScaleBar` — robust across PDF renderers.
 *   3. user           — two-point click calibration stored on the
 *                       PlanPage as ptPerFoot + label.
 *
 * The caller supplies what's available (text fragments, optional door
 * candidates, optional user-supplied scale). The module returns an
 * `EstablishedScale | null`. Callers MUST check for null — when no
 * scale exists, the measurement engine emits surfaces with no area
 * value and a `scale-needed` derivation, rather than guessing.
 */

import {
  detectScaleAnchor,
  type ScaleSearchInput,
} from "../scale-anchor";
import { detectScaleBar, type ScaleBarInput } from "./scale-bar";
import { verifyScaleViaDoors, type DoorCandidate } from "../scale-verifier";

export type ScaleMethod = "text-notation" | "scale-bar" | "user";

export interface EstablishedScale {
  ptPerFoot: number;
  method: ScaleMethod;
  /** Display label for the UI banner. */
  label: string;
  /** 0..1 — combines source confidence with cross-check evidence. */
  confidence: number;
  /** Free-form note for the UI (e.g. "Doors verify scale"). */
  note?: string;
  /** Optional position of the source on the page (PDF y-up). */
  source?: { x: number; y: number };
}

export interface UserSuppliedScale {
  ptPerFoot: number;
  label: string;
}

export interface EstablishScaleInput {
  /** Text fragments with PDF y-up positions. */
  fragments: ScaleSearchInput[];
  /** Optional door-symbol bounding-box widths in pt, for cross-check. */
  doorCandidates?: DoorCandidate[];
  /** A user-supplied scale from PlanPage.scaleRatio + scaleLabel. */
  userScale?: UserSuppliedScale | null;
}

/**
 * Resolve the canonical scale for a page. Returns null when no source
 * succeeds — callers must NOT invent a fallback.
 */
export function establishScale(
  input: EstablishScaleInput,
): EstablishedScale | null {
  // User-set scale always wins. The user is the authoritative source —
  // their two-point calibration overrides any text we may have parsed.
  if (input.userScale && input.userScale.ptPerFoot > 0) {
    return {
      ptPerFoot: input.userScale.ptPerFoot,
      method: "user",
      label: input.userScale.label,
      confidence: 0.99,
      note: "Set by you",
    };
  }

  const anchor = detectScaleAnchor(input.fragments);
  if (anchor && anchor.ptPerFoot > 0) {
    let confidence = anchor.confidence;
    let note: string | undefined;
    if (input.doorCandidates && input.doorCandidates.length >= 3) {
      const v = verifyScaleViaDoors(input.doorCandidates, {
        ptPerFoot: anchor.ptPerFoot,
        label: anchor.label,
      });
      if (v.status === "verified") {
        confidence = Math.min(0.99, confidence + 0.05);
        note = `Doors at ~${v.impliedDoorWidthFt.toFixed(1)} ft verify scale.`;
      } else if (v.status === "mismatch") {
        confidence = Math.max(0.2, confidence - 0.4);
        note = v.message;
      } else if (v.status === "weak") {
        note = v.message;
      }
    }
    return {
      ptPerFoot: anchor.ptPerFoot,
      method: "text-notation",
      label: anchor.label,
      confidence,
      note,
      source:
        anchor.x !== undefined && anchor.y !== undefined
          ? { x: anchor.x, y: anchor.y }
          : undefined,
    };
  }

  const barInput: ScaleBarInput[] = input.fragments.map((f) => ({
    text: f.text,
    x: f.x ?? 0,
    y: f.y ?? 0,
  }));
  const bar = detectScaleBar(barInput);
  if (bar) {
    let confidence = bar.confidence;
    let note: string | undefined;
    if (input.doorCandidates && input.doorCandidates.length >= 3) {
      const v = verifyScaleViaDoors(input.doorCandidates, {
        ptPerFoot: bar.ptPerFoot,
        label: bar.label,
      });
      if (v.status === "verified") {
        confidence = Math.min(0.95, confidence + 0.05);
        note = `Doors at ~${v.impliedDoorWidthFt.toFixed(1)} ft verify scale.`;
      } else if (v.status === "mismatch") {
        confidence = Math.max(0.2, confidence - 0.3);
        note = v.message;
      }
    }
    return {
      ptPerFoot: bar.ptPerFoot,
      method: "scale-bar",
      label: bar.label,
      confidence,
      note,
      source: { x: bar.bboxPt.x0, y: bar.bboxPt.y0 },
    };
  }

  return null;
}

/**
 * Compute ptPerFoot from a two-point user calibration. Inputs are in
 * normalized 0..1 page coords (the SurfaceOverlay's native space) plus
 * the page's PDF point dimensions. realFeet is the dimension the user
 * typed in.
 *
 * Returns null when the click distance is too small to trust (< 6 PDF pt
 * apart) or realFeet is non-positive.
 */
export function ptPerFootFromTwoPoints(input: {
  p1Norm: { x: number; y: number };
  p2Norm: { x: number; y: number };
  pageWidthPt: number;
  pageHeightPt: number;
  realFeet: number;
}): { ptPerFoot: number; pixelDistancePt: number } | null {
  if (!Number.isFinite(input.realFeet) || input.realFeet <= 0) return null;
  if (input.pageWidthPt <= 0 || input.pageHeightPt <= 0) return null;
  const dx = (input.p2Norm.x - input.p1Norm.x) * input.pageWidthPt;
  const dy = (input.p2Norm.y - input.p1Norm.y) * input.pageHeightPt;
  const distPt = Math.hypot(dx, dy);
  if (distPt < 6) return null;
  const ptPerFoot = distPt / input.realFeet;
  if (!Number.isFinite(ptPerFoot) || ptPerFoot <= 0) return null;
  return { ptPerFoot, pixelDistancePt: distPt };
}

/**
 * Friendly label for the UI banner. Used both server-side (when the
 * engine establishes scale automatically) and client-side (when the
 * user calibrates).
 */
export function formatScaleLabel(s: EstablishedScale): string {
  switch (s.method) {
    case "text-notation":
      return s.label;
    case "scale-bar":
      return s.label;
    case "user":
      return s.label || "Set by you";
  }
}
