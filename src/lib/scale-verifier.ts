/**
 * Scale verification via door symbol width.
 *
 * Architectural doors are standardized: residential interior 30-36",
 * commercial interior 36", ADA 36-42", commercial main entrance often
 * 36" single or 72" double. Across all of these the dominant width is
 * 36" = 3 feet. If our detected door symbols cluster around N PDF pt
 * wide on the page, and the scale anchor says X pt/ft, then we expect
 * N ≈ 3 × X.
 *
 * If N/X is well outside 2.5-4.5 ft, the scale anchor or the door
 * detection (or both) is wrong — flag the page for human review.
 *
 * This is a free deterministic sanity check on top of vector text
 * scale parsing.
 */

export interface DoorCandidate {
  x: number;
  y: number;
  /** Door symbol extent in PDF points (arc bounding-box max dimension). */
  size: number;
}

export interface ScaleAnchorIn {
  /** From the parsed text scale notation. */
  ptPerFoot: number;
  /** Label like "1/8" = 1'-0"". */
  label: string;
}

export type VerificationStatus =
  | "verified" // doors cluster near expected width, scale confirmed
  | "weak" // some doors match but variance is high
  | "mismatch" // doors cluster at a clearly different width — scale is wrong
  | "insufficient_data"; // not enough door candidates to verify

export interface ScaleVerification {
  status: VerificationStatus;
  /** Median detected door width in PDF points. */
  medianDoorWidthPt: number;
  /** Implied feet per door = medianDoorWidthPt / ptPerFoot. */
  impliedDoorWidthFt: number;
  /** Expected door width in feet (3.0). */
  expectedDoorWidthFt: number;
  /** Number of door candidates used. */
  doorSampleSize: number;
  /** Human-readable explanation. */
  message: string;
}

const EXPECTED_DOOR_WIDTH_FT = 3.0;

export function verifyScaleViaDoors(
  doors: DoorCandidate[],
  scale: ScaleAnchorIn,
): ScaleVerification {
  if (doors.length < 3) {
    return {
      status: "insufficient_data",
      medianDoorWidthPt: 0,
      impliedDoorWidthFt: 0,
      expectedDoorWidthFt: EXPECTED_DOOR_WIDTH_FT,
      doorSampleSize: doors.length,
      message:
        "Not enough door candidates on this page to cross-check the scale.",
    };
  }
  const widths = doors.map((d) => d.size).sort((a, b) => a - b);
  // Trim outliers: drop top + bottom 10% before taking median.
  const trimCount = Math.floor(widths.length * 0.1);
  const trimmed = widths.slice(trimCount, widths.length - trimCount);
  const median = trimmed[Math.floor(trimmed.length / 2)];
  const impliedFt = median / scale.ptPerFoot;
  const error = impliedFt / EXPECTED_DOOR_WIDTH_FT;

  let status: VerificationStatus;
  let message: string;
  if (error >= 0.85 && error <= 1.15) {
    status = "verified";
    message = `Scale ${scale.label} confirmed: doors are ~${impliedFt.toFixed(1)} ft wide (expected ~3 ft).`;
  } else if (error >= 0.7 && error <= 1.4) {
    status = "weak";
    message = `Scale ${scale.label} is plausible but doors measure ${impliedFt.toFixed(1)} ft (off from expected 3 ft). Review.`;
  } else {
    status = "mismatch";
    // Suggest what the scale SHOULD be.
    const correctedPtPerFt = median / EXPECTED_DOOR_WIDTH_FT;
    message = `Detected scale ${scale.label} (${scale.ptPerFoot.toFixed(1)} pt/ft) doesn't match door widths. Doors measure ${impliedFt.toFixed(1)} ft (expected 3 ft). True scale likely ${correctedPtPerFt.toFixed(1)} pt/ft.`;
  }

  return {
    status,
    medianDoorWidthPt: median,
    impliedDoorWidthFt: impliedFt,
    expectedDoorWidthFt: EXPECTED_DOOR_WIDTH_FT,
    doorSampleSize: doors.length,
    message,
  };
}
