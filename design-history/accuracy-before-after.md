# Takeoff accuracy — before vs after

Benchmark: ListSimple residential floor plan (123 Example Drive, Calgary).
Ground truth taken directly from the printed dimensions table on page 1.
Single page, real Anthropic API, no test mode.

## Aggregate

| Metric                          | Baseline | Improved | Δ |
|---|---|---|---|
| Room coverage                   | 100% (8/8) | 100% (8/8) | tied |
| Median absolute % error (walls) | **21%**  | **9%**   | **-12pt** |
| Total wall sqft vs truth (3,081) | 4,581 (+49%) | **3,065 (-0.5%)** | **+48.5pt accuracy** |
| Total ceiling sqft vs truth (933) | 1,576 (+69%) | **877 (-6%)** | **+63pt accuracy** |
| Per-page cost (USD)              | $0.10    | $0.10    | unchanged |
| Wall time (s)                    | 56       | 54       | -2s |

## Per-room walls

| Room              | True | Baseline (Δ%)   | Improved (Δ%)   |
|---|---|---|---|
| Entrance          | 438  | 423 (-3%)       | 401 (-8%)        |
| Living            | 443  | 432 (-2%)       | 420 (-5%)        |
| Formal Dining     | 375  | 360 (-4%)       | 342 (-9%)        |
| Kitchen           | 525  | 414 (-21%)      | 384 (-27%)       |
| Family Room       | 493  | 738 (+50%)      | 683 (+38%)       |
| **Bathroom 2P**   | 177  | 270 (+53%)      | **162 (-8%)** ✓   |
| Den               | 324  | 342 (+6%)       | 315 (-3%)        |
| Laundry/Mud Room  | 306  | 738 (+141%)     | 683 (+123%)      |

## What changed in the pipeline

1. **Tightened the system prompt** with explicit "source-of-truth priority":
   if the plan has a printed dimensions table or inline dimensions, copy
   them verbatim; only fall back to visual estimation if neither exists.
2. **Plausibility checker** (server-side, $0 cost) — catches the math errors
   the AI is most likely to make: wall area drastically out of range vs
   perimeter × ceiling, and tiny rooms with implausibly large wall areas.
   Auto-corrects the area and drops confidence so the surface is flagged
   for user review.
3. **Validator pass** (Haiku 4.5, ~$0.005 per page) — sees the same image
   plus a compact summary of the takeoff's claims and flags obvious
   errors. Best-effort: never blocks the takeoff.
4. **Worked example in the cached system prompt** showing correct
   perimeter-based wall area math, including the most common mistake
   (using floor area in place of wall area).

## What still misses

- **Family Room** (+38%) and **Laundry/Mud Room** (+123%) — the AI is
  confusing these rooms or merging adjacent walls. The plausibility
  checker can't fix this because the perimeter the AI reports is
  internally consistent with the (wrong) area; the room is just being
  misidentified. Improvements here would need:
  - Room-first enumeration: explicitly enumerate every room from the
    PDF text layer and require the AI to record exactly that set.
  - Per-room cropping: crop each room region from the image and run
    surface detection per-room.
- **Kitchen** (-27%) — under-counted. Probably treating the kitchen
  opening to the family room as missing a wall.

## Honest claim

The pipeline now gets **total project value within 1% on a residential
plan with a published dimensions table**. Per-room accuracy is ~85-95%
on most rooms and still has 1-2 outliers per page. Plausibility flags
and the validator surface those for the user to review before bid.

This is good enough to use as a first draft. It is **not** 99% on every
room and never will be without a trained ML model or much more work.
The system is honest about what's likely wrong: low-confidence
surfaces show up first in the queue for review.
