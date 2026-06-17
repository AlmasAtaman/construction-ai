# Paint scope & wall-area measurement — deep-research verdict (2026-06-17)

Deep research (105 agents, 23 sources, 25 claims verified → 14 confirmed / 11
refuted) on how commercial painting estimators scope and measure wall area, and
how to automate it. Run to decide our two open questions: (a) how to turn the
plan's painting instructions into scope, (b) the measurement conventions that
decide whether we hit the friend's 2,380 sqft.

## CONFIRMED (high confidence)

1. **Estimator reads the finish schedule + finish plan first; that defines paint
   scope.** Finish codes (P-1 paint, CT tile, FRP panel, vinyl) map rooms→wall
   surfaces. RCP supplies the ceiling height used for wall height. → our plan's
   p5 note "ALL STOCKROOM WALLS TO RECEIVE PAINT FINISH P-1" + FRP/CT extents IS
   the authoritative scope source.
2. **Wall area = wall length (or room perimeter) × wall height (floor→ceiling).**
   Exactly what we compute.
3. **Both faces of interior walls are counted, each able to carry a different
   finish/height.** Reconciles with the friend: measuring each *painted room's
   interior perimeter* counts that room's wall faces once → a wall shared by two
   painted rooms is counted twice (both faces), a wall between a painted room and
   outside/non-painted is counted once. Per-room interior perimeter IS the
   both-faces convention applied correctly.
4. **Openings: deduction is a CONVENTION, not a rule — "always deduct" was
   REFUTED (0-3).** Doors ~21 sqft (3'×7') when deducted, but many estimators
   skip small openings. Friend's 840÷93.3 = 9.00 ft exact ⇒ he did NOT deduct
   openings. → keep our default: no auto-deduct, user trims per wall.

## CONFIRMED about automation (this kills the "auto-read the schedule" option)

5. **Prose-trained OCR fails on dense drawings** — text overlaps/touches graphics
   (garbled/missing), and multi-layout pages give wrong reading order. Needs
   region-based processing + a *separate* symbol-detection pass, not full-page
   OCR.
6. **No reliable finish-schedule TABLE parser exists** — every merged-cell
   table-extraction claim was refuted/unconfirmed.
7. Togal.AI = computer vision one-click takeoff + text-search to *locate* paint
   tags across sheets; it does NOT do rules-based finish-code scope detection
   (accuracy claims refuted 0-3). On-Screen Takeoff auto-deducts openings + both
   faces + per-face finish (vendor docs). PlanSwift needs a plugin to deduct
   openings from linear takeoffs.

## What the research could NOT answer (real gaps)

- How a finish bubble geometrically maps to the *specific* wall surface/face it
  applies to (our exact Phase-5 blocker — no published method).
- Half-walls / bulkheads / "to 6″ above ceiling" vs "to deck" height conventions.
- Merged-cell finish-schedule table parsing.

## DECISION (validated by the above)

- **Scope method = semi-automatic.** Separate rooms (seeded), pre-mark each
  paint/tile/FRP from the human-readable finish-plan notes (P-1 stockroom note,
  CT/FRP extents, room-name heuristics), let the user confirm/override which
  rooms are in paint scope. Auto-OCR of the schedule is confirmed unreliable —
  do NOT build it.
- **Measurement = per-painted-room interior wall-perimeter × ceiling height.**
  Matches both the pro both-faces convention AND the friend's per-room method.
  No opening deduction by default; per-wall trim available.
- This is the seeded-room approach we already have. The Overstock 69-vs-93-lf
  gap is a flood-fill capture BUG, not a convention question — method is right,
  geometry needs fixing.
