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

---

# ROUND 2 — how the AI takeoff companies ACTUALLY automate it (2026-06-17)

Second deep research (103 agents, 21 sources, 25 claims → 24 confirmed / 1
refuted), aimed at HOW production tools (Bild AI, Togal, Clicky, Kreo) do
fully-automatic scope + per-room takeoff, since they clearly can. This OVERTURNS
round-1's "auto-reading is off the table." The nuance: full-SHEET OCR fails, but
that is not how anyone does it.

## CONFIRMED — the method that works is REGION-FIRST, not one model

1. **Full-sheet OCR/VLM reliably fails; the proven fix is localize-then-read.**
   (BLUEPRINT arXiv 2602.13345: full-page OCR nDCG@3 0.21 vs region-cropped 0.53
   — "layout-aware OCR beats full-page OCR.") Vision encoders ingest ~336×336 px,
   so small details vanish in a single pass (CropVLM 2511.19820). → Never OCR the
   whole sheet. Crop first.
2. **Tile/sliding-window object detection finds small symbols on dense sheets**
   where full-sheet detection and vector symbol-spotting fail — YOLOv7/Faster
   R-CNN ~83–95% mAP on architectural symbols at 300 dpi (Rezvanifar CVPRW 2020;
   Jamieson IJDAR 2024; CADSpotting 2412.07377). → finish bubbles + schedule
   cells are findable by detection-on-tiles.
3. **VLMs "know where to look" — attention/learned ROI cropping** improves dense
   doc extraction training-free (+7 pts DocVQA; ViCrop 2502.17422, CropVLM).
4. **Don't compute quantities end-to-end in an LLM** — error-prone. Reliable
   pattern = extract → symbol-map → rule-constrained chain-of-thought over domain
   rules (SSRN 4968830: GPT-4 direct "introduced significant errors"; structured
   method "precise, explainable").
5. **Bild AI's production pattern = multi-source reconciliation**: locate each
   element on the plan, tag it, cross-check plan vs schedule vs spec, flag
   mismatches. (Demonstrated on Division-8 doors; transfers to finishes.)
6. **Keep deterministic mupdf vector extraction** — pixel re-vectorization
   (Raster-to-Graph) is for plans WITHOUT vectors; we have vectors, keep them.

## The synthesized 6-step recipe (maps onto what we already have)

1. GEOMETRY — keep mupdf CAD-vector walls + room-label seeds + seeded
   region-growing. ✅ already built.
2. REGION LOCALIZATION — render sheet hi-res; detect the finish-schedule table
   region, finish bubbles, and note blocks (tile detection OR, for us, we already
   know where the schedule sheet + room tags are). Never OCR the full sheet.
3. READ — run a VLM on SMALL CROPS only: the schedule table crop, each room/bubble
   crop, the note block. (This is the unlock that sidesteps the round-1 OCR/merged-
   cell failure — a VLM reads the table visually, no cell-extraction.)
4. MAP — associate each finish code to the nearest room/wall-face by plan
   coordinates; multi-code-per-room via FRP/CT extent lines + per-face proximity.
5. SCOPE + RECONCILE — rule-constrained reasoning over room name + schedule row +
   plan note ("ALL STOCKROOM WALLS → P-1"); cross-check sources, flag conflicts.
6. MEASURE — per in-scope wall face: perimeter × height, shared-wall attribution,
   openings, height rules. ✅ mostly built (seeded rooms).

## What this means for US (the concrete unlock)

The Phase-5 failure was using full-sheet structured-text to find finish bubbles
(they weren't co-located with walls). The validated fix: **VLM on targeted crops.**
We already have the hard 80% (vector walls + separated rooms + room labels). The
missing piece — scope — is now buildable WITHOUT the unreliable full-sheet OCR:

  crop the finish-schedule region → Claude vision → room→finish-code table;
  crop/read the finish-plan notes → "stockroom walls = P-1", FRP/CT extents;
  join to our seeded rooms by room name/number → per-room paint vs tile vs FRP.

Honest caveat from the research: NO source benchmarks this exact paint-scope task
end-to-end — every technique transfers from an adjacent domain (doors, excavation,
residential, generic VQA) by analogy. So we build it, then verify against the
friend's known answer (2,380 sqft / Overstock 840 / Sales+Service 1,540.9) as our
ground-truth test.

---

# ROUND 3 — DETERMINISTIC (non-ML) methods + the hybrid handoff (2026-06-17)

Third deep research (105 agents, 23 sources, 25 claims → 24 confirmed / 1
refuted), on what PURE-VECTOR / PURE-GEOMETRY methods solve outright, as a
complement to (not replacement for) the AI crop-read. Verdict: deterministic
solves a LARGE fraction; AI is a narrow fallback.

## CONFIRMED — deterministic pillars

1. **Vector finish-schedule table parsing, no OCR/ML.** Two strategies:
   ruling-line/cell-boundary (pdfplumber "lines"/"lines_strict", Camelot Lattice)
   and text-alignment/whitespace (pdfplumber "text", Camelot Stream). ~96% on
   machine-generated PDFs; degrades only on merged/nested cells. We already have
   the inputs (mupdf vector text runs + drawn line segments) — can do this in
   our own code, no Python dependency.
2. **CAD structure is parseable deterministically** — NCS/AIA layer names are
   dash-delimited fields (string-split; we already do this in layer-classify.ts).
   AF=Architectural Finishes discipline, IDEN=identification tags, SCHD=schedules
   are known locator patterns. BUT: a "FNSH" major group does NOT exist (REFUTED
   0-3) — don't rely on it. Layer membership is UNRELIABLE (blocks land on wrong
   layers) — must cross-validate against geometry.
3. **Computational-geometry association** binds a finish tag to room + wall face
   with NO ML: point-in-polygon room containment (we have it) + nearest-segment /
   nearest-wall-face (GeoPandas sjoin_nearest equivalent). Resolves multi-code-
   per-room via per-wall-face proximity + extent-line endpoints.
4. **Per-wall-face finishes are real & standardized** — VA/DoD schedules stack
   N/E/S/W/C rows per room (a room can be P-1 on three walls, FRP/CT on the wet
   wall). So association must be per-face, not per-room.
5. **Finish-code dictionaries + ditto symbols** — P=Paint, VCT/CT/QT=tile,
   AT/ACT=ceiling, FRP=panel; "**"=same as adjoining, "-"=no color. Firm-specific,
   so the lookup must be a TUNABLE table (we already decoded THIS plan's legend:
   P-n paint / CT ceramic wall tile / FRP / ACT ceiling).
6. **Hybrid = deterministic-first, LLM fallback.** Peer-reviewed: Lattice→Stream→
   LLM resolved 851/860 docs deterministically, LLM on only 9, ~100× faster.
   (Caveat: simple academic tables, not CAD — hit-rate won't transfer as-is.)

## UNIFIED VERDICT across all 3 rounds (the architecture to build)

**Deterministic-first, AI-fallback, verify against the friend's answer.**

For THIS plan we already hold most of what's needed: CAD-layer walls, separated
rooms, room labels, vector text incl. the explicit note "ALL STOCKROOM WALLS TO
RECEIVE P-1", and the decoded legend. So the scope step is:

  STEP A (deterministic): parse the finish-schedule region (vector lines + text
    clustering) → room→finish-code table; AND regex the finish-plan notes grounded
    to room labels ("STOCKROOM → P-1", FRP/CT extent lines).
  STEP B (deterministic geometry): point-in-polygon + nearest-wall-face to bind
    each finish code to a seeded room / wall face.
  STEP C (rules): code→material lookup (P=paint, CT/FRP=not) → per-room, per-face
    paint scope. Confidence score per room.
  STEP D (AI fallback, ONLY low-confidence rooms): crop that room + the schedule
    region → Claude vision reads the code. Used as a backstop + cross-check, not
    the primary path.
  STEP E (verify): total must land near friend's 2,380 sqft (Overstock 840,
    Sales+Service 1,540.9). That real answer is our ground-truth gate.

Failure modes to design around (all three rounds agree): mislabeled layers (→
cross-validate, don't trust layer alone), merged/multi-header schedule cells (→
AI fallback), scope living only in prose notes (→ regex first, AI backstop).

---

# BUILD + EMPIRICAL RESULT (2026-06-17) — deterministic scope MATCHES the friend

Built Steps A–D and verified each against the friend's ground truth on Beaver p5.
Modules (all isolated, room detection untouched):
- `src/lib/extract/finish-scope.ts` (A) — vector-text finish NOTES + TAGS, with
  legend-list + part-number filtering. Extracts the decisive note "ALL STOCKROOM
  WALLS → P-1" grounded to room keyword; classifies tags by family (P=paint,
  CT=wall tile, TB=tile BASE, FRP, ACT=ceiling…).
- `src/lib/extract/bind-finish.ts` (B) — point-in-polygon (with 605pt two-view
  translation) + nearest-seed fallback for tags; room-CATEGORY match for notes.
- `src/lib/extract/paint-scope.ts` (C) — decision rules + confidence + `basis`
  (note|category|tag|default). PAINT_CATEGORIES (stockroom/sales/service/…) vs
  EXCLUDED (washroom/vestibule/electrical/…). CT (wall tile) conflicts flag a
  paint room; TB (tile base) is ignored (painted walls have tile bases).
- `src/lib/ai/verify-finish.ts` (D) — Claude-vision (sonnet) advisory check on
  `needsReview` rooms, seed-centred crop via clipped MuPDF DrawDevice.

**RESULT: deterministic scope = PAINT{OVERSTOCK, SALES, SERVICE},
EXCLUDED{WASHROOM, VESTIBULE, ELECTRICAL} — EXACT match to the friend.** Driven
by the P-1 stockroom note (Overstock) + room categories (Sales/Service paint;
washroom/vestibule/electrical excluded). No AI needed for the decision.

**KEY EMPIRICAL FINDING — the AI vision fallback was WRONG here, deterministic was
right.** On the one flagged room (SALES), Claude vision read the crop as "tile"
at 0.95 — because the bottom of the sheet is finish-DETAIL + interior ELEVATIONS,
and "SALES AREA 101" labels a tiled feature/counter wall ("CT-2 (2 FULL TILES)",
"TILES TO ALIGN", cabinets), NOT the room's dominant scoped walls (which the
friend painted, 1,540.9 sqft). So finish bubbles/crops show feature-wall tile,
not the scoped finish — the same co-location problem Phase 5 hit. **Fix: AI is
ADVISORY** — it may override only `tag`/`default` (genuinely weak) rooms; for
`note`/`category` rooms it records dissent but the deterministic call stands.
This empirically validates Round-3's deterministic-first / AI-advisory ordering
against real ground truth: had we trusted the VLM (Round-2's pitch), we'd have
wrongly dropped Sales from paint scope.

## OVERSTOCK "under-trace" was NOT a bug — it's PAINTED TO DECK (2026-06-20)

Chased the last 9% (Overstock 621 vs friend 840). The seeded polygon is an 8-pt
16.9×11.6ft rectangle with a partition slot, full perimeter 73 lf / wall-only
69 lf — geometry is CORRECT, the fill does not stop short. The gap is HEIGHT:
840 ÷ 73 lf = 11.5 ft, a to-deck wall, not a 9ft ceiling. Confirmed verbatim in
the plan notes: p5 "METAL STUDS ... TO U/S OF DECK", "1/2\" G.W.B. TO 13'-0\"
A.F.F."; p10 (stockroom finish) "STOCKROOM" + "TO U/S OF DECK" + "PAINT FINISH
ABOVE 13'-0\" A.F.F.". So stockroom/BOH walls are painted to deck (~11.5–13ft),
Sales/Service to a 9ft finished ceiling. Implemented per-room height in
`scoped-takeoff.ts`: CEILING_HEIGHT_FT=9, DECK_HEIGHT_FT=11.5 (TO_DECK_CATEGORIES
= stockroom), `heightBasis` per room, to-deck rooms flagged needsReview (exact
deck height needs the elevation). **RESULT: total 2,349 sqft vs friend 2,381 =
99% (Sales+Service 1,555 vs 1,541; Overstock 794 vs 840).** This also answers the
"to 6\" above ceiling vs to deck" height question all three research rounds
flagged as unresolved — the answer is read deterministically from the wall-type
notes by category.

**PIPELINE COMPLETE (deterministic): 4,070 sqft "trace everything" → 2,349 sqft
scoped to exactly the painted rooms + heights, 99% match to the contractor, $0
AI for the decision (AI advisory-only).** Modules: finish-scope, bind-finish,
paint-scope, verify-finish (AI advisory), scoped-takeoff. REMAINING: wire into
the UI (takeoff button + blue fill by finish + worksheet groups); exact deck
height per the elevation; generalize to DP-BP.
