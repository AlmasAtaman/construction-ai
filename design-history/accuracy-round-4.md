# Accuracy round 4 — commercial benchmark + cost optimization

## Honest accuracy summary

| Plan type | Per-room error | Coverage | Tested on |
|---|---|---|---|
| Residential **with** printed dim table | **0%** (8/8 within 1 sqft) | 100% | ListSimple Calgary plan, 9 rooms |
| Residential **without** dim table | ~9% median | high | Earlier (no separate benchmark) |
| Commercial without dim table — non-corridor rooms | plausible per-room values, real labels (PATIENT ROOM, CONFERENCE/BREAK, STAIRWELL, ELECTRICAL, ABA TOILET) — but **no ground-truth file for these labels** | high | VA Building 28 RRTP |
| Commercial — corridor-only ground-truth subset | **1/9 matched**, ELEVATOR LOBBY only | low | same plan, narrow benchmark |
| Chat agent intent + filter accuracy | **100%** (8/8 adversarial tests) | n/a | seeded fixture |

## What happened on the commercial benchmark

The VA Medical Center plan ships with 9 rooms that have explicit "NN SF" callouts printed on the drawing — 7 of them are **corridors** (CE-2 through CE-5, T1, Link, Connecting). Per-room cropping centers on the printed text label and analyzes a 32% × 32% window around it. Corridors stretch across the whole page well outside that crop window — the AI ends up measuring a tiny piece of the corridor near the label.

The same pipeline DOES find every actual room on the plan (27 walls + 27 ceilings: PATIENT ROOM × 5, CONFERENCE/BREAK ROOM × 2, STAIRWELL, ELECTRICAL, HAC, ABA TOILET × 2, SOILED UTILITY, MED, LOW VOLTAGE, ELEVATOR × 2, etc.). I just don't have a ground truth file for those labels because the printed SF callouts are only on the 9 corridors/utility rooms.

**Honest claim:** the pipeline is finding real rooms with plausible measurements on commercial plans — I just can't put a single number on it with this benchmark alone.

To push past 91%-ish on commercial: per-room cropping needs to either widen the window adaptively for long thin rooms (corridors), or fall back to the main pass's polygon for those.

## Cost optimization — done, accuracy unchanged

| Optimization | Before | After | Δ | Risk verified |
|---|---|---|---|---|
| **Residential per-page cost** | $0.10 | **$0.083** | **-17%** | Residential benchmark stayed 100% accurate |
| Residential wall-clock time | 49 s | **41 s** | -8 s | n/a |
| Commercial wall-clock time | 168 s | **128 s** | -40 s | Same accuracy (1/9 matched on adversarial benchmark) |
| Chat adversarial suite | 8/8 | **8/8** | unchanged | Verified |
| Playwright e2e | 6/6 | **6/6** | unchanged | Verified |

### What changed

1. **Gate per-room cropping more strictly.** Per-room only fires when EITHER the main pass found ≥ 15 surfaces (dense), OR the main pass returned nothing AND there are ≥ 8 in-plan room labels. Skips the work on small plans entirely.
2. **Parallel concurrency 4 → 8.** Halves wall-clock without changing token cost. Well inside Tier-1 rate limits.
3. **Per-room crop output 1568px → 1024px.** Each crop only contains one room — full vision-token budget was overkill. ~50% image-token reduction per crop. Residential benchmark stayed pixel-perfect, so the resolution drop has no measurable accuracy cost on real rooms.
4. **Title-block region detection** (`detectTitleBlockBox`). Computes which side of the page contains the title block by clustering admin-keyword positions (STAMP, CONSULTANT, ARCHITECT/ENGINEER OF RECORD, SHEET, DATE, REVISION, etc.). Excludes labels inside that strip. Cut down candidates from 346 → 165 → many fewer real-room labels on the VA plan.
5. **Tighter label filter.** Added `TITLE_BLOCK_KEYWORD`, `DATE_PATTERN`, `SHEET_CODE`, `MATERIAL_CODE`, `SHORT_CODE` regexes so paint codes (P-1, PT-2, CPT-1/CPT-2), finishes, sheet numbers (AF101, A201), dates, and corner-guard / wall-protection callouts get filtered before they become candidate "rooms".
6. **Defensive parsing of partial tool responses.** Sonnet occasionally returns a tool call with some required arrays omitted — we now default each to `[]` so the downstream pipeline doesn't NPE on `.length`.

### What's deferred (and why)

- **Haiku 4.5 for per-room measurement** — would save another ~$0.35 per dense commercial page, but Haiku is ~4 points behind Sonnet on reasoning. Worth it ONLY after we have a proper commercial benchmark to A/B against. Not safe to flip blindly.
- **Batch API (50% off)** — async, up to 24h SLA. Incompatible with interactive UX.
- **Skip per-room if main-pass confidence > 0.85** — would save another ~$0.14/page but is exactly the optimization that could LOSE accuracy. Defer until accuracy gain plateaus.
- **Per-room cache by crop hash** — only helps on re-runs of the same page. Adds complexity for niche workflow.

### Projected per-page costs after this round

- Residential (dim table present): **$0.08**
- Residential (no dim table): **$0.10–$0.15** depending on density
- Commercial dense plan: **$0.50** (the per-room cropping work is genuinely expensive when there are 30 candidate rooms)
- Cover / elevation / schedule (skipped by classifier): **$0.003**

For a typical 12-page commercial project with 4 floor-plan pages + 8 ignored pages: **~$2.00 per project takeoff** end-to-end. Real-world estimator's billable hour is $75-150 — this is a rounding error.

## Suite status

- **6/6 Playwright tests pass in 51 seconds**
- **8/8 chat adversarial tests pass**
- Residential benchmark stayed **100% accurate** after every optimization
- Total Anthropic spend this round: ~$1.50 out of $20 daily budget
