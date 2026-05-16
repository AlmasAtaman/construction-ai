# Per-room accuracy — round 2

Same benchmark: ListSimple residential plan, page 1 (MAIN floor), 8
interior rooms with printed dimensions table.

## Aggregate progression

| Run | Median per-room wall % | Worst-room wall % | Total wall sqft (truth 3,081) | Total ceiling sqft (truth 933) |
|---|---|---|---|---|
| Baseline | 21% | +141% | 4,581 (+49%) | 1,576 (+69%) |
| + validator + plausibility | 9% | +123% | 3,065 (-0.5%) | 877 (-6%) |
| + room enum + dim-table override | 8% | -28% | 3,099 (+0.6%) | 892 (-4%) |
| **Final (full Tier-1 stack)** | **0%** | **-1%** | **3,080 (-0.03%)** | **933 (0%)** |

## Per-room final

| Room | True walls | AI walls | Δ | Δ% |
|---|---|---|---|---|
| Entrance | 438 | 437 | -1 | **-0%** |
| Living | 443 | 443 | 0 | **+0%** |
| Formal Dining | 375 | 374 | -1 | **-0%** |
| Kitchen | 525 | 526 | +1 | **+0%** |
| Family Room | 493 | 493 | 0 | **-0%** |
| Bathroom 2P | 177 | 176 | -1 | **-0%** |
| Den | 324 | 324 | 0 | **0%** |
| Laundry/Mud Room | 306 | 306 | 0 | **0%** |

## What was actually wrong

Three bugs hidden behind each other:

1. **pdfjs-dist version mismatch**. We had `pdfjs-dist@4.8.69` installed,
   but `pdf-to-img` bundles `pdfjs-dist@5.6.205`. The text-layer
   extraction failed silently with "API version does not match Worker
   version", we caught the error in a `catch {}` and returned an empty
   array. The dim-table parser had nothing to work with. After upgrading
   to `pdfjs-dist@~5.6.205`, all 47 fragments + 11 dim-table rows
   appeared.
2. **Silent `catch {}` swallowed the version-mismatch error.** Replaced
   with `catch (err) { console.error(...); ... }` so future failures are
   visible.
3. **Validator was over-correcting tiny rooms.** Haiku looked at the
   image and decided a 4'×5' bathroom couldn't have 177 sqft of walls
   (it can — 4 walls × ~5 ft × 9 ft = ~180), and "fixed" it down to
   50. Now the validator is skipped entirely when a dim table was
   applied — the table IS the validation.

## Pipeline as it stands

1. Render PDF page → grayscale JPEG at ~180 DPI.
2. Extract every text fragment from the PDF's vector layer with its
   normalized (x, y) position.
3. Detect a printed Room × Dimensions table by clustering fragments
   with dimension-string patterns next to nearby labels.
4. Classify the page with Haiku (skip cover/elevation/schedule pages).
5. Call Sonnet 4.5 with the cached system prompt + the rendered image
   + the room enumeration + the dim-table announcement. The AI is
   instructed to set area_sqft to 0 when a table is present — the
   server overwrites it.
6. **Deterministic dim-table override**: for each table row, compute
   floor area = W × H, wall area = perimeter × 9 ft. Drop any AI
   wall/ceiling entry whose room isn't in the table.
7. Plausibility check (server-side, free) catches any remaining
   geometric impossibility.
8. Validator pass (Haiku) — only runs when there's no dim table.

## Cost / time

- $0.0889 per page (Sonnet $0.07 + Haiku $0.003 + cache).
- 48 seconds wall-clock.
- Without the dim-table override (pure VLM): error climbs to 9-21%
  median, but cost and time are the same.

## What still costs accuracy on plans WITHOUT a dim table

- IQ Buildings commercial blueprint has no printed dimensions table.
  On that plan we measured "~1% on total project sqft, 9% median
  per-room error" — meaningful but not 100%. The dim-table override
  doesn't fire; we're back to pure VLM with prompt + validator.
- Real-world residential plans frequently DO have dimension tables
  (MLS sheets, lease documents, design-build worked plans). Real-
  world commercial plans rarely do.

## Suite status

`6/6` Playwright tests pass in 50 seconds.
