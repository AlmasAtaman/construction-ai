# Reconciling against the contractor's takeoff (Beaver Tails Milton)

We have the finished takeoff a real contractor produced in PlanSwift
(`tests/fixtures/friend-commercial-walls-ANSWER.pdf`) and the source plan
(`friend-commercial-plan.pdf`, p5). He cannot answer questions for a while,
so this is our own decoding. Numbers below are reproducible via
`scripts/reconcile-friend.mts`.

## What his takeoff actually contains (decoded from the PlanSwift photos)

| Item (his label) | Colour | Value | What it is |
|---|---|---|---|
| Wall Area | green | **840.0 sq ft** | Overstock room walls |
| "1" | yellow | **1,540.9 sq ft** | Sales + Service area walls |
| Area | teal | 549.3 sq ft | A ceiling/floor area (RCP sheet) |
| New Count | red | 2.0 EA | Unknown — likely doors |
| New Segment | blue | 0 ft | empty |

**Paint wall total = 840.0 + 1,540.9 = 2,380.9 sq ft.** At a flat 9 ft
ceiling that is **264.5 linear feet** of wall.

## Our measurement vs his

Our deterministic CAD-layer takeoff of p5 (single-line wall centerlines,
all wall layers, dimensions/hatch rejected):

```
BB-E-WALL   275.6 lf   (base-building shell)
FP-N-WALL   116.9 lf   (new full-height partitions)
FP-N-HWALL  110.7 lf   (new half-height partitions)
FP-E-HWALL   23.7 lf   (existing half walls)
TOTAL       526.9 lf   →  4,742 sq ft at flat 9 ft
```

**Our 527 lf is 1.99× his 265 lf.** That ratio is the whole story.

## Why the gap exists (the mechanism)

He and we are measuring two different things:

- **He measures per-room interior perimeters of the *in-scope painted
  rooms only*** — Overstock (93.3 lf) and the Sales/Service space
  (171.2 lf). Washrooms, vestibule, electrical room, the building shell,
  and adjacent-tenant walls are **not** in his paint scope (they're FRP /
  tile / existing / out of scope), so he never traces them.
- **We trace every wall centerline on the sheet** — shell, every
  partition, washroom walls, all of it.

So the gap is **scope**, not bad geometry. His 2,380.9 sq ft is a subset
of our 4,742 sq ft, restricted to two rooms and the paint finish.

## What we adopt as defaults (since he can't confirm)

| Question | Evidence | Our default |
|---|---|---|
| Wall height | 840 ÷ 93.3 lf = 9.00 ft exactly | **Flat 9 ft** for full walls; 4 ft for `HWALL` half-walls (editable per wall) |
| Openings (doors/glazing) | can't tell from photos | **Not auto-subtracted** — conservative (over- not under-bills); user trims per wall |
| Non-paint finishes | washrooms clearly excluded from his wall items | **Tracked but not billed** (FRP/tile/glazing), shown separately in the scope summary |

## How to reproduce his number in the app today

The product now supports his exact workflow (per-room, per-finish):

1. **Room wand** for the enclosed in-scope rooms → one click = perimeter ×
   9 ft. Tag finish = Paint on the HUD.
2. **Washrooms etc.** → trace with finish = FRP/Tile so they're tracked
   but excluded from the paint total.
3. The **"Wall scope by finish"** panel in the worksheet then reads like
   his tree: *Paint — Overstock …, Sales …* with a separate
   *FRP — tracked, not billed* block.

### The one place it isn't one-click: open-plan rooms

Overstock opens to the Sales floor through a wide partition gap, so the
room detector cannot close it as its own face — it merges the entire left
half of the plan into one 222 lf "footprint" face. The truly-enclosed
sub-rooms (service/sales sub-areas, washrooms: 50–71 lf faces) one-click
cleanly; Overstock and the open Sales floor must be traced with **polyline
mode** (click along the walls, close the loop across the opening) — a few
clicks, the same manual judgment the contractor used to draw his green
loop. This matches every estimator review we found: AI proposes the easy
rooms, the human closes the open ones.

## Open items that genuinely need his input (or more of our own work)

- Exact Overstock / Sales boundaries (where one room's paint stops and the
  next begins on a shared wall) — his green/yellow split.
- Whether he paints one face or both faces of interior partitions.
- The 549.3 teal "Area" — which ceiling, and what's excluded (T-bar?).
- "New Count 2.0" — what is counted.

Until then, the per-room wand + finish workflow gets a user to his
structure and, on the enclosed rooms, to his numbers; the open-plan rooms
are an honest manual trace.
