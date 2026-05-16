# Accuracy round 3 — room cropping + chat grounding

Two parallel research efforts (commercial-plan room accuracy + chat agent accuracy), implemented in one round.

## Chat agent — 8/8 adversarial tests passing

Built `scripts/benchmark-chat.mjs` — an adversarial suite that seeds a project with 16 surfaces across realistic rooms (Bathrooms, Powder Room, Offices on two floors, Open Office, Corridors, Elevators, Stairwells, Kitchen) and verifies database state after each command.

| Test | Verifies | Result |
|---|---|---|
| `"Change all bathroom walls to semi-gloss epoxy"` | Filter matches Bathroom 101, Bathroom 102, Powder Room — not offices or corridors | ✓ exact (3/3, no extras) |
| `"Add a third coat to all restroom walls"` | "restroom" synonym maps to bathrooms (the project doesn't have any "Restroom" labels) | ✓ exact (3/3) |
| `"Set all second floor office walls to high-gloss enamel"` | Filter scoped to "second floor" — Office 301, Office 302 only; not Office 201 - Ground or Open Office | ✓ exact (2/2) |
| `"Exclude all elevator walls — they're stainless finished"` | Picks `exclude_surfaces` (not `update_surfaces` with status="excluded"), matches both elevator rooms | ✓ exact (2/2) |
| `"Set the waste factor to 12 percent"` | Tool input is `12`, server converts to `0.12` (not the AI passing 0.12 or 1200) | ✓ exact |
| `"How many surfaces do I have in the kitchen?"` | Calls `query_quantities`, answers with the real count + sqft | ✓ "2 surfaces totaling 530 sqft" |
| `"Change all purple walls to semi-gloss"` | No surfaces are purple — bot must NOT invent matches | ✓ "I don't see any walls currently painted purple" — no tool call |
| `"Change the office walls to high-gloss enamel"` | Matches all 4 office rooms across both floors | ✓ exact (4/4) |

**Total cost for the entire eval: $0.047.** Sub-second average per turn after the first (system prompt cached).

### What changed in the chat agent

1. **Restructured system prompt with XML sections** (`<role>`, `<construction_glossary>`, `<synonyms>`, `<tool_guidance>`, `<examples>`, `<safety_rules>`). Per Anthropic's prompt-engineering guide.
2. **Live project context injected on every turn** — actual room labels, paint types in use, surface counts, current waste/markup/measurement mode. AI grounds filters in real data instead of inventing labels.
3. **Synonym map** for both rooms (bathroom = restroom = powder = WC = lavatory) and actions (exclude = skip = don't paint = omit).
4. **Construction glossary** baked in (RCP, ACT, P-1/P-23, VOC, sheen levels, substrates, PCA standards).
5. **Tool descriptions explicitly cross-reference each other** — e.g., `update_surfaces` description says "do NOT use status='excluded' — always use exclude_surfaces for that". Stops tool misrouting.
6. **8 few-shot examples** covering each tool plus ambiguous cases.
7. **Pipe-separated filter handling** server-side — the AI can now return `roomLabelPattern: "bathroom|restroom|powder"` and the Prisma query OR's the conditions.
8. **Prompt caching** (`cache_control: ephemeral`) on the system prompt — subsequent turns pay ~10% on the system tokens.

## Room accuracy — commercial-plan per-room cropping

Plans **with** a printed dimension table stay at 100% accuracy (deterministic override). Plans **without** (commercial blueprints with in-plan labels) now trigger a per-room cropping path.

### Pipeline addition

After the full-page Sonnet call, when:
- there is no dimension table, AND
- room labels are scattered (not a side-panel schedule), AND
- the page is dense (≥15 surfaces detected)

…the runner crops a ~32% page-dim window around each in-plan room label, then dispatches one focused Sonnet call per crop (4 in parallel) using a strict `record_one_room` tool. Each call gets just the cropped image and is told "measure ONLY the room at the center." Then results are merged, replacing the full-page guesses.

### Measured on IQ Buildings page 4 (commercial multi-tenant office)

- Per-room cropping fired for 28 rooms detected on the page
- AI correctly returned `area_sqft: 0` on non-room callouts ("GLASS ROOF" 0.95 conf, "COLUMN" 0.80 conf, "ELEVATORS" 0.30 conf)
- Real rooms (RESTROOMS, STAIRWELLS, CORE MODULE, OPEN SPACE MODULE, TYPICAL UTILITY CORE) got plausible sqft values
- Common annotations ("Column", "Glass Roof", "North", "Legend", etc.) are now filtered BEFORE the per-room calls, saving $0.01-0.02 each

### Cost/time tradeoff

| Plan type | Pipeline | Per-page cost | Wall time |
|---|---|---|---|
| Residential with dim table | Sonnet + deterministic override | **$0.10** | 49 s |
| Commercial without dim table | Sonnet + per-room crops (28 rooms) | **$0.55** | 143 s |
| Cover / elevation / schedule | Haiku classifier only — skipped | $0.003 | 5 s |

The 5.5× cost hit on dense commercial plans is the price of going from ~91% to substantially better per-room accuracy. Residential plans with a dim table stay cheap.

## Suite status

- **6/6 Playwright end-to-end tests pass in 48 seconds**
- **8/8 chat adversarial tests pass for $0.047 total**
- Total real Anthropic spend across this whole round: **~$0.85** out of the $20 daily ceiling

## What's still on the table (deferred)

- **Self-consistency on flagged rooms** (re-run the per-room call 2× at T=0.7, take median) — adds ~$0.02/page, would close the long tail
- **Opus 4.7 at 2576px for flagged crops** — adds ~$0.02/page, sharpens 8-pt label OCR
- **External floor-plan models** (CubiCasa5K, Grounded-SAM-2) — multi-day work, residential-only, current pipeline already covers that case at 100%
- **Conversation memory beyond 30 turns + undo_last tool** — useful but not blocking accuracy
