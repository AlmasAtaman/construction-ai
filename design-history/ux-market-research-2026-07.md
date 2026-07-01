# UX market research — takeoff tools + painter-estimator PMF (2026-07-01)

Two parallel research agents; condensed here. Full detail lives in the session
transcript; the actionable synthesis drove `ui-redesign-2026-07.md`.

## A. Competitor UX (Togal, PlanSwift, STACK, Bluebeam, Kreo, Countfire, Beam, Handoff)

Converged canvas-tool layout: left = sheets/takeoff list, center = canvas with
colored overlays, right = quantities with LIVE totals (STACK shows live $ next
to the canvas), bottom = scale status + measurements table.

Patterns adopted (→ = where it landed in PainterDesk):
1. Bluebeam Markups List two-way canvas↔table linking = THE provenance
   pattern → review queue hover-highlight kept; row-click-zoom deferred.
2. Scale = visible, blocking-but-prefilled gate (STACK/Kreo "AI suggests,
   user confirms"; green when set) → spine Scale segment + banner only when
   attention needed + statusbar segment.
3. Staged AI results with explicit Commit (Kreo "Create") vs Togal
   auto-commit (its #1 complaint: correction burden, "60–85% on messy
   sheets") → our proposed→accept queue + paint-scope Apply kept prominent.
4. ONE obvious AI button (Togal's green button) → takeoff console, one
   orange action.
5. Auto-name from plan text with undo (Kreo/Togal); wizard-free linear
   defaults — "nobody in this market successfully uses multi-step wizards"
   → spine is a status instrument, not a wizard.
6. Countfire "4 stages of checking" / hide-what's-done toggle → Hide AI
   overlay covers part; record-drawing export deferred.
7. Live money always visible (STACK) → collapsed estimate bar + spine $.
8. Room auto-tagging (Bluebeam Spaces) → roomLabel already flows to bid.
9. Scope decisions must cite their plan note (Beam scope-confirmation) →
   paint-scope room rows now show "Why: …" on hover.
10. Anti-patterns: AI editing things unasked (Handoff), quantities that
    dead-end in exports, formula-builder complexity cliff → opinionated
    paint defaults instead.

Pricing/positioning: self-serve AI takeoff $175–299/user/mo (Kreo Pro,
Togal); classic tools $1–4k/yr; painters actually buy at $100–300/mo
(PaintScout/Handoff band). Unclaimed spot: instant wall detection +
per-quantity geometry provenance + painter-grade proposal in one flow.

## B. Painter-estimator PMF

- Buyer: ~220–230k US painting firms avg 1.4 employees; under ~$1.5M the
  OWNER estimates, often at 9pm. Design for tired-owner simplicity.
- Win rates 25% commercial → 75–90% of takeoff hours produce no revenue;
  cost-per-bid is the lever. Outsourced takeoffs run $150–900 (one sub pays
  $50/bid offshore) — pricing anchor for per-takeoff value.
- Workflow the UI must mirror: ITB → go/no-go → READ SPECS FIRST (Div 09,
  "specs govern over plans") → structured plan review → takeoff (wall SF =
  perimeter × height, grouped by finish code; cross-checked against the
  finish schedule) → production rates (PCA ~85–200 SF/hr) → L/M/O/M
  4-element pricing (≥30% margin) → scope letter with Base Bid/Alternates/
  Inclusions/Exclusions → GC bid leveling.
- Terminology: say takeoff/quantities, plans/drawings/sheets, finish
  schedule, wall SF (never bare $/sqft), production rate, prime + 2 coats,
  HM doors (EA), Base Bid/Alternates, scope letter. Never: blueprints,
  measurements, paint list, quote, drop ceiling.
- Trust: unpredictable accuracy worse than low accuracy; scale-verification
  ritual first; every number clickable to geometry; per-item confidence with
  review threshold; SHOW the finish-schedule note behind each scope call;
  PCA P10 §5.8 verbatim (disregard small openings; deduct floor-to-ceiling
  >5' wide or ≥100 SF openings) — encoding + citing it = instant credibility;
  "prove it on my own job" onboarding (upload a plan they already bid,
  compare to their known number — our Beaver Tails 2,349 vs 2,381 story IS
  this demo).
- Aha demo: their own already-bid plan → 10 min later wall-by-wall takeoff
  overlaid on their drawings, grouped by finish code with the schedule note
  as evidence, within a few % of their known number, exportable as marked-up
  sheets + Excel backup.
