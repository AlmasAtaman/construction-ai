# UI redesign — workflow-first editor (2026-07-01)

## Why

Playwright audit of every screen found the product's real problem is not the
visual skin (tokens are a coherent Bluebeam-ish industrial system) but that
**the UI does not express the workflow**. Findings:

1. **No visible sequence.** An estimator's job is a pipeline — plan → scale →
   takeoff → review → estimate — but the UI presents an undifferentiated
   toolbox. Nothing says "you are here / do this next."
2. **Three orange CTAs compete** (Takeoff whole plan, Paint takeoff, Get
   price), and two header buttons go to the same /bid page (See estimate,
   Get price).
3. **The canvas is starved.** At default the plan gets ~35% of the viewport:
   cost breakdown open at 288px + scale row + toolbar row + header rows.
   The drawing is the product; it should dominate.
4. **Takeoff actions are scattered** across the canvas toolbar (Paint
   takeoff, Trace all walls, Layers, Reset), the left sidebar (Takeoff whole
   plan), and the command palette (whose "run takeoff" event targets a
   retired button and silently no-ops).
5. Review queue items on unscaled pages read "Wall path — TRACED" with no
   measurement/room; provenance badges exist but wall-path items don't show
   their CAD layer.
6. Statusbar shows "MODEL Opus 4.7" (internal detail, zero contractor value).
7. W-tool HUD is unlabeled chips; snap modes are hidden knowledge.

## Direction

**Subject:** a takeoff workbench for a commercial painting estimator who
already knows PlanSwift/Bluebeam. Single job of the editor: from plan set to
a defensible painted-wall estimate, every number traceable.

**Signature element — the takeoff spine.** A full-width workflow strip under
the top bar, styled like a drawing sheet's title block: five numbered
segments (Plan · Scale · Takeoff · Review · Estimate), each showing LIVE data
("SCALE 1/4″ = 1′-0″ ✓", "REVIEW 3 waiting", "ESTIMATE $3,410.02"), each
clickable to act. It is a status instrument, not a wizard — nothing is gated,
the numbering encodes the real dependency order of a takeoff. This is the
"make it make sense" device, and it consolidates ALL takeoff triggers in one
place (Paint takeoff primary, Trace all walls, whole plan, layers, reset).

**Trust element — provenance everywhere.** Every measurement shows where it
came from (CAD layer name, plan note, scale-measured, hand-drawn). The data
already exists (sourceLayer, derivation, basis); the redesign surfaces it.

**One orange rule.** Safety orange = the single next action for the current
step. Everything else is blue (navigation/selection) or neutral.

**Typography.** Barlow Semi Condensed (600/700) for the spine, section
titles and headline figures — DIN-adjacent, the face of drawing title blocks;
body stays system sans; all numbers tabular.

## Layout (editor)

```
┌ TopBar: name · status · client        [Specs Settings History]  [Estimate→]┐
├ SPINE: ①PLAN 34p ②SCALE 1/4″✓ ③TAKEOFF ▾ ④REVIEW 3 ⑤ESTIMATE $3,410 ────────┤
├──────┬──────────────────────────────────────────────────────────┬──────────┤
│PAGES │ [zoom][scale chip]              [surfaces][overlay]       │ REVIEW(3)│
│ list │                                                          │  Chat    │
│      │                    CANVAS (dominant)                     │  queue   │
│      │  tool strip                                              │  items   │
├──────┴──────────────────────────────────────────────────────────┴──────────┤
├ Estimate bar (collapsed): $3,410.02 · 3 rooms · 2,349 sqft   [expand/open] ┤
└ statusbar: page · scale · tool hint · walls kept · AI spend ───────────────┘
```

- Left sidebar: Pages only (Measure-plan block moves into spine Takeoff panel).
- Canvas toolbar keeps VIEW concerns only: zoom, compact scale chip (full
  banner row only when scale is missing/unconfirmed), surface-type toggles,
  overlay toggle.
- Bottom worksheet: renamed "Estimate", collapsed by default to a live
  summary bar (total · rooms · sqft), expandable as before.
- Statusbar: page, scale, active-tool hint, kept-walls count, AI spend; Model
  segment removed.
- Copy: "Get price" removed; "See estimate" → "Estimate"; queue placeholder
  and sidebar copy name the real buttons; W-tool HUD gets a one-line hint.

## Constraints honored

- No behavioral changes to tracing/scope/bid math; all existing testids kept
  (paint-takeoff, ai-takeoff, accept-all-high, page-button-N, worksheet-*,
  usage-badge…); command-palette run-takeoff event retargeted to the live
  Trace-all-walls button.
- DetectionQueue/SurfaceOverlay/EstimateWorksheet internals reused; only
  their homes/derived labels change.

## Market research inputs (see agents' reports)

- Competitor UX patterns (Togal/PlanSwift/Stack/Bluebeam/Kreo) and painter
  estimator workflow/trust requirements — folded into spine step naming and
  review provenance emphasis.
