/**
 * Accuracy benchmark suite.
 *
 * Runs the takeoff pipeline against a fixed set of plans with
 * ground-truth room schedules, reports per-room accuracy + cost, and
 * produces a single summary row so we can MEASURE whether changes
 * improve things.
 *
 * Two approaches are measured:
 *   A. Deterministic (commercial-rooms vector pipeline only)
 *      — no AI room measurement, just polygons + scale + callouts
 *   B. AI per-room (measure-with-context.ts) using whichever model is configured
 *
 * For each (plan, approach) we compute:
 *   - Room ID rate: how many GT rooms got a matching candidate by label substring
 *   - Per-room area error
 *   - Total area error
 *   - Wall-clock time + estimated cost
 *
 * Output: console table + JSON snapshot in tests/fixtures/benchmark-suite-results.json
 *
 * Usage:
 *   npx tsx scripts/benchmark-suite.mts            # both approaches, all plans
 *   npx tsx scripts/benchmark-suite.mts --skip-ai  # vector only (cheap, fast)
 *   npx tsx scripts/benchmark-suite.mts --plans hawksnest,inhp
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

const cr = await import("../src/lib/commercial-rooms.ts");
const mr = await import("../src/lib/ai/measure-with-context.ts");
const hr = await import("../src/lib/ai/high-res-takeoff.ts");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const mupdf = await import("mupdf");

interface PlanEntry {
  /** Short id used in CLI args. */
  id: string;
  /** Path relative to repo root. */
  pdfPath: string;
  pageNumber: number;
  /** GT JSON path relative to repo root. */
  gtPath: string;
  /** Human description. */
  description: string;
}

const PLANS: PlanEntry[] = [
  {
    id: "va-commercial",
    pdfPath: "tests/fixtures/commercial-bench.pdf",
    pageNumber: 1,
    gtPath: "tests/fixtures/commercial-bench-ground-truth.json",
    description: "VA Building 28 — partially raster commercial",
  },
  {
    id: "inhp",
    pdfPath: "tests/fixtures/benchmark-commercial/inhp-revit.pdf",
    pageNumber: 4,
    gtPath: "tests/fixtures/benchmark-commercial/inhp-p4-ground-truth.json",
    description: "INHP — Revit-direct residential",
  },
  {
    id: "hawksnest",
    pdfPath: "tests/fixtures/benchmark-commercial/hawksnest.pdf",
    pageNumber: 5,
    gtPath: "tests/fixtures/benchmark-commercial/hawksnest-p5-ground-truth.json",
    description: "Hawksnest — Chief Architect residential",
  },
  {
    id: "transforming",
    pdfPath: "tests/fixtures/benchmark-commercial/transforming-cd-sample.pdf",
    pageNumber: 3,
    gtPath: "tests/fixtures/benchmark-commercial/transforming-p3-ground-truth.json",
    description: "Transforming CD — residential basement",
  },
];

// ── CLI args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const skipAi = args.includes("--skip-ai");
const skipHighRes = args.includes("--skip-high-res");
const onlyHighRes = args.includes("--only-high-res");
const planFilter = (() => {
  const i = args.indexOf("--plans");
  if (i < 0) return null;
  return args[i + 1]?.split(",").map((s) => s.trim());
})();

const plans = planFilter
  ? PLANS.filter((p) => planFilter.includes(p.id))
  : PLANS;
if (plans.length === 0) {
  console.error(`No plans match filter ${planFilter}. Available:`);
  for (const p of PLANS) console.error(`  ${p.id} — ${p.description}`);
  process.exit(1);
}

console.log(`\n=== ACCURACY BENCHMARK ===`);
console.log(`Plans: ${plans.map((p) => p.id).join(", ")}`);
console.log(`Approaches: vector pipeline${skipAi ? "" : " + Opus per-room"}\n`);

// ── Helpers ───────────────────────────────────────────────────────────

function normalize(s: string): string {
  // Strip qualifiers in parens/brackets ("(MASTER)", "(Bedroom 3 ensuite)").
  // Strip leading/trailing punctuation. Replace # with space (BEDROOM #2 → BEDROOM 2).
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/#/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tokenize a normalized label into meaningful keywords. Filters out
 * stop words and short numeric noise.
 */
function tokenize(normalized: string): string[] {
  const STOP = new Set([
    "the", "a", "of", "to", "and", "or", "for", "in", "on", "at",
    "room", "area", "main", "master", "suite", "no", "the",
  ]);
  return normalized
    .split(" ")
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

function tokensOverlap(a: string[], b: string[]): boolean {
  // Bidirectional substring match between any token pair.
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
      if (x.length >= 4 && y.includes(x)) return true;
      if (y.length >= 4 && x.includes(y)) return true;
    }
  }
  return false;
}

/**
 * Match each GT room to the closest candidate. When the GT label has
 * multiple meaningful tokens (e.g. "MASTER BEDROOM"), require at least
 * one strong token match. Pick the candidate whose normalized label is
 * MOST SIMILAR (by token overlap fraction) rather than just the largest
 * sqft, to handle plans with multiple BATH/CLOSET rooms.
 *
 * Each candidate is used AT MOST ONCE across the GT (greedy match by
 * label-similarity desc), so two GT rooms don't both claim the same AI
 * candidate.
 */
function matchCandidates<T extends { label: string; areaSqft: number | null }>(
  gtRooms: Array<{ label: string; floorAreaSqft: number }>,
  candidates: T[],
): Array<{ gt: typeof gtRooms[number]; match: T | null; errPct: number | null }> {
  // Score every (gt, candidate) pair, sort by score desc, greedy-assign.
  type Pairing = { gtIdx: number; candIdx: number; score: number };
  const pairs: Pairing[] = [];
  const gtNorms = gtRooms.map((g) => tokenize(normalize(g.label)));
  const candNorms = candidates.map((c) => tokenize(normalize(c.label)));
  for (let i = 0; i < gtRooms.length; i++) {
    for (let j = 0; j < candidates.length; j++) {
      if (candidates[j].areaSqft == null) continue;
      const a = gtNorms[i];
      const b = candNorms[j];
      if (a.length === 0 || b.length === 0) continue;
      if (!tokensOverlap(a, b)) continue;
      // Jaccard-ish similarity over token sets.
      const setA = new Set(a);
      const setB = new Set(b);
      let intersect = 0;
      for (const x of setA) if (setB.has(x)) intersect++;
      const union = setA.size + setB.size - intersect;
      const score = union > 0 ? intersect / union : 0;
      pairs.push({ gtIdx: i, candIdx: j, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const matchedGt = new Set<number>();
  const matchedCand = new Set<number>();
  const out: Array<{ gt: typeof gtRooms[number]; match: T | null; errPct: number | null }> =
    gtRooms.map((gt) => ({ gt, match: null, errPct: null }));
  for (const p of pairs) {
    if (matchedGt.has(p.gtIdx) || matchedCand.has(p.candIdx)) continue;
    const gt = gtRooms[p.gtIdx];
    const best = candidates[p.candIdx];
    const err = ((best.areaSqft! - gt.floorAreaSqft) / gt.floorAreaSqft) * 100;
    out[p.gtIdx] = { gt, match: best, errPct: err };
    matchedGt.add(p.gtIdx);
    matchedCand.add(p.candIdx);
  }
  return out;
}

interface PlanResult {
  planId: string;
  description: string;
  gtRoomCount: number;
  gtTotalSqft: number;
  vectorMatched: number;
  vectorMae: number;
  vectorTotalSqftDetected: number;
  vectorElapsedMs: number;
  aiMatched: number;
  aiMae: number;
  aiTotalSqftDetected: number;
  aiCost: number;
  aiElapsedMs: number;
  aiSkipped: boolean;
  // High-res Set-of-Marks single call (new pipeline C)
  highResMatched: number;
  highResMae: number;
  highResTotalSqftDetected: number;
  highResCost: number;
  highResElapsedMs: number;
  highResPrintedDimsRate: number;
  highResSkipped: boolean;
}

const allResults: PlanResult[] = [];

for (const plan of plans) {
  console.log(`\n────────────────────────────────────────`);
  console.log(`${plan.id} — ${plan.description}`);
  console.log(`────────────────────────────────────────`);

  const pdfPath = path.join(REPO, plan.pdfPath);
  const gtPath = path.join(REPO, plan.gtPath);
  const buf = readFileSync(pdfPath);

  // Load GT in a normalized form: { rooms: [{label, floorAreaSqft}] }
  const gtRaw = JSON.parse(readFileSync(gtPath, "utf8")) as Record<string, unknown>;
  const gtRoomsRaw =
    (gtRaw.rooms as Array<{ label?: string; floorAreaSqft?: number; trueFloorAreaSqft?: number; matchKeys?: string[] }> | undefined) ??
    ((gtRaw.pages as Array<{ rooms: Array<{ label: string; trueFloorAreaSqft: number; matchKeys?: string[] }> }> | undefined)?.flatMap((p) => p.rooms) ?? []);
  const gtRooms = gtRoomsRaw.map((r) => ({
    label: r.label!,
    floorAreaSqft: (r.floorAreaSqft ?? r.trueFloorAreaSqft) as number,
    matchKeys: r.matchKeys,
  }));
  const gtTotalSqft = gtRooms.reduce((a, r) => a + r.floorAreaSqft, 0);

  console.log(`  GT: ${gtRooms.length} rooms, total ${gtTotalSqft.toFixed(0)} sqft`);

  // ── Approach A: vector pipeline only ────────────────────────────────
  const t0a = Date.now();
  const result = await cr.extractCommercialRoomCandidates(
    Buffer.from(buf),
    plan.pageNumber,
    { enableAiOcr: false },
  );
  const tVector = Date.now() - t0a;

  const candidates = result.candidates.filter((c) => c.areaSqft != null);
  const matches = matchCandidates(gtRooms, candidates);
  const matchedCount = matches.filter((m) => m.match).length;
  const errors = matches.filter((m) => m.errPct != null).map((m) => Math.abs(m.errPct!));
  const mae = errors.length > 0 ? errors.reduce((a, b) => a + b, 0) / errors.length : 0;
  const totalDetected = matches.reduce(
    (a, m) => a + (m.match?.areaSqft ?? 0),
    0,
  );

  console.log(`\n  [A] Vector pipeline: ${tVector}ms, scale=${result.scaleAnchor?.label ?? "(none)"}`);
  console.log(`      Matched ${matchedCount}/${gtRooms.length} (${((matchedCount / gtRooms.length) * 100).toFixed(0)}%)`);
  console.log(`      MAE on matched: ${mae.toFixed(0)}%`);
  console.log(`      Total detected: ${totalDetected.toFixed(0)} sqft vs ${gtTotalSqft.toFixed(0)} GT`);

  // ── Approach B: Opus per-room (optional) ────────────────────────────
  let aiMatched = 0;
  let aiMae = 0;
  let aiTotalDetected = 0;
  let aiCost = 0;
  let aiElapsedMs = 0;
  let aiSkipped = false;

  if (skipAi) {
    aiSkipped = true;
    console.log(`\n  [B] AI per-room: SKIPPED (--skip-ai)`);
  } else {
    const t0b = Date.now();
    // Render page once for crops
    const doc = mupdf.Document.openDocument(new Uint8Array(buf), "application/pdf");
    const page = doc.loadPage(plan.pageNumber - 1);
    const bounds = page.getBounds();
    const pageW = bounds[2] - bounds[0];
    const pageH = bounds[3] - bounds[1];
    const pixmap = page.toPixmap(
      mupdf.Matrix.scale(150 / 72, 150 / 72),
      mupdf.ColorSpace.DeviceRGB,
    );
    const pageImagePng = Buffer.from(pixmap.asPNG());
    const pxW = pixmap.getWidth();
    const pxH = pixmap.getHeight();

    if (!result.scaleAnchor) {
      console.log(`\n  [B] AI per-room: SKIPPED (no scale anchor parsed)`);
      aiSkipped = true;
    } else {
      // Measure each GT room. Use GT label as the focal point — find a
      // candidate text-fragment position closest to a room with this name.
      const inputTokensTotal: number[] = [];
      const outputTokensTotal: number[] = [];
      const aiMatches: Array<{ gt: typeof gtRooms[number]; aiSqft: number | null; basis: string | null }> = [];

      // For each GT, find a position to crop around. Use the first
      // candidate whose label loosely matches; fall back to page center.
      for (let i = 0; i < gtRooms.length; i++) {
        const gt = gtRooms[i];
        process.stdout.write(`  [B] [${i + 1}/${gtRooms.length}] "${gt.label.slice(0, 30)}"... `);
        const candidate = candidates.find((c) =>
          normalize(c.label).includes(normalize(gt.label).split(" ")[0]) ||
          normalize(gt.label).includes(normalize(c.label).split(" ")[0]),
        );
        const focal = candidate
          ? { x: candidate.x / pageW, y: 1 - candidate.y / pageH }
          : { x: 0.5, y: 0.5 };
        // Pull nearby callouts
        const cropHalfPt = 0.16 * Math.max(pageW, pageH);
        const cropX = candidate?.x ?? pageW / 2;
        const cropY = candidate?.y ?? pageH / 2;
        const nearbyCallouts = result.dimensionCallouts
          .filter((d) => Math.abs(d.x - cropX) < cropHalfPt && Math.abs(d.y - cropY) < cropHalfPt)
          .slice(0, 12)
          .map((d) => ({
            rawText: d.rawText,
            lengthFt: d.lengthFt,
            xOffsetNorm: (d.x - cropX) / (cropHalfPt * 2),
            yOffsetNorm: (d.y - cropY) / (cropHalfPt * 2),
            orientation: d.orientation,
          }));
        try {
          const m = await mr.measureRoomWithContext({
            pageImageBase64: pageImagePng.toString("base64"),
            pageImageMediaType: "image/png",
            pageWidthPx: pxW,
            pageHeightPx: pxH,
            label: gt.label,
            xNorm: focal.x,
            yNorm: focal.y,
            ptPerFoot: result.scaleAnchor.ptPerFoot,
            scaleLabel: result.scaleAnchor.label,
            nearbyCallouts,
          });
          inputTokensTotal.push(m.inputTokens);
          outputTokensTotal.push(m.outputTokens);
          aiMatches.push({ gt, aiSqft: m.floorAreaSqft, basis: m.measurementBasis });
          console.log(`${m.floorAreaSqft?.toFixed(0) ?? "?"} sqft basis=${m.measurementBasis}`);
        } catch (err) {
          console.log(`failed: ${(err as Error).message}`);
          aiMatches.push({ gt, aiSqft: null, basis: null });
        }
      }

      aiElapsedMs = Date.now() - t0b;
      const aiErrors = aiMatches
        .filter((m) => m.aiSqft != null)
        .map((m) => Math.abs(((m.aiSqft! - m.gt.floorAreaSqft) / m.gt.floorAreaSqft) * 100));
      aiMatched = aiMatches.filter((m) => m.aiSqft != null).length;
      aiMae = aiErrors.length > 0 ? aiErrors.reduce((a, b) => a + b, 0) / aiErrors.length : 0;
      aiTotalDetected = aiMatches.reduce((a, m) => a + (m.aiSqft ?? 0), 0);
      const totalIn = inputTokensTotal.reduce((a, b) => a + b, 0);
      const totalOut = outputTokensTotal.reduce((a, b) => a + b, 0);
      // Opus 4.7 pricing approx ($15/M input, $75/M output)
      aiCost = (totalIn / 1_000_000) * 15 + (totalOut / 1_000_000) * 75;

      console.log(`\n      AI matched ${aiMatched}/${gtRooms.length} (${((aiMatched / gtRooms.length) * 100).toFixed(0)}%)`);
      console.log(`      MAE on matched: ${aiMae.toFixed(0)}%`);
      console.log(`      Total detected: ${aiTotalDetected.toFixed(0)} sqft`);
      console.log(`      Cost: $${aiCost.toFixed(2)}, time: ${aiElapsedMs}ms`);
    }
  }

  // ── Approach C: high-res Set-of-Marks single call ──────────────────
  let hrMatched = 0;
  let hrMae = 0;
  let hrTotalDetected = 0;
  let hrCost = 0;
  let hrElapsedMs = 0;
  let hrPrintedDimsRate = 0;
  let hrSkipped = false;

  if (skipHighRes) {
    hrSkipped = true;
    console.log(`\n  [C] High-res Set-of-Marks: SKIPPED (--skip-high-res)`);
  } else {
    // Pull room-label positions from text layer for Set-of-Marks markers.
    const pdfDoc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
    const pdfPage = await pdfDoc.getPage(plan.pageNumber);
    const viewport = pdfPage.getViewport({ scale: 1 });
    const tc = await pdfPage.getTextContent();
    const ROOM_KW = /\b(ROOM|CORRIDOR|OFFICE|STAIR|LOBBY|STORAGE|BATH|TOILET|MECH|ELEC|KITCHEN|PANTRY|CLOSET|UTILITY|EXAM|RECEPTION|PATIENT|BEDROOM|BED|DINING|LIVING|GARAGE|FOYER|LAUNDRY|POWDER|HALL|WIC|MASTER|ENTRY|DEN|STUDY|NOOK|PORCH|DECK|FAMILY|GREAT|MEDIA|GUEST|NURSERY|GYM|OXYGEN|VEND|VOLT)\b/i;
    const positions = (tc.items as { str: string; transform: number[] }[])
      .filter((it) => it.str.trim().length > 0 && ROOM_KW.test(it.str))
      .map((it) => ({
        label: it.str.trim(),
        xNorm: it.transform[4] / viewport.width,
        yNorm: it.transform[5] / viewport.height,
      }));

    const tC = Date.now();
    try {
      const hrResult = await hr.runHighResTakeoff({
        pdfBuffer: Buffer.from(buf),
        pageNumber: plan.pageNumber,
        maxImagePx: 2576,
        gridDivisions: 10,
        model: "claude-opus-4-7",
        roomLabelPositions: positions,
      });
      hrElapsedMs = Date.now() - tC;
      hrCost =
        (hrResult.inputTokens / 1_000_000) * 15 +
        (hrResult.outputTokens / 1_000_000) * 75;

      // Match GT rooms to AI output (uses the improved fuzzy matcher).
      const hrCandidates = hrResult.rooms.map((r) => ({
        label: r.label,
        areaSqft: r.floorAreaSqft as number | null,
        basis: r.basis,
      }));
      const hrMatches = matchCandidates(gtRooms, hrCandidates);
      hrMatched = hrMatches.filter((m) => m.match).length;
      const hrErrs = hrMatches.filter((m) => m.errPct != null).map((m) => Math.abs(m.errPct!));
      hrMae = hrErrs.length > 0 ? hrErrs.reduce((a, b) => a + b, 0) / hrErrs.length : 0;
      hrTotalDetected = hrMatches.reduce((a, m) => a + (m.match?.areaSqft ?? 0), 0);
      const printedDims = hrMatches.filter(
        (m) => m.match && (m.match as { basis?: string }).basis === "printed-dimensions",
      ).length;
      hrPrintedDimsRate = hrMatched > 0 ? printedDims / hrMatched : 0;
      console.log(`\n  [C] High-res Set-of-Marks: ${hrElapsedMs}ms, $${hrCost.toFixed(3)}`);
      console.log(`      Matched ${hrMatched}/${gtRooms.length} (${((hrMatched / gtRooms.length) * 100).toFixed(0)}%)`);
      console.log(`      MAE on matched: ${hrMae.toFixed(0)}%`);
      console.log(`      Printed-dimensions: ${printedDims}/${hrMatched}`);
    } catch (err) {
      console.log(`\n  [C] High-res failed: ${(err as Error).message}`);
      hrSkipped = true;
    }
  }

  allResults.push({
    planId: plan.id,
    description: plan.description,
    gtRoomCount: gtRooms.length,
    gtTotalSqft,
    vectorMatched: matchedCount,
    vectorMae: mae,
    vectorTotalSqftDetected: totalDetected,
    vectorElapsedMs: tVector,
    aiMatched,
    aiMae,
    aiTotalSqftDetected: aiTotalDetected,
    aiCost,
    aiElapsedMs,
    aiSkipped,
    highResMatched: hrMatched,
    highResMae: hrMae,
    highResTotalSqftDetected: hrTotalDetected,
    highResCost: hrCost,
    highResElapsedMs: hrElapsedMs,
    highResPrintedDimsRate: hrPrintedDimsRate,
    highResSkipped: hrSkipped,
  });
}

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n\n════════════════════════════════════════════════════════════`);
console.log(`SUMMARY`);
console.log(`════════════════════════════════════════════════════════════`);
console.log(`\nPlan              | Vector ID%  MAE  | OpusPerRoom ID%  MAE   $$  | HighRes ID%  MAE   $$    PD%`);
console.log(`${"─".repeat(106)}`);
for (const r of allResults) {
  const vectorIdPct = ((r.vectorMatched / r.gtRoomCount) * 100).toFixed(0).padStart(4) + "%";
  const vectorMae = r.vectorMae.toFixed(0).padStart(4) + "%";
  const aiIdPct = r.aiSkipped ? " skip" : (((r.aiMatched / r.gtRoomCount) * 100).toFixed(0).padStart(4) + "%");
  const aiMae = r.aiSkipped ? "    " : (r.aiMae.toFixed(0).padStart(4) + "%");
  const aiCost = r.aiSkipped ? "     " : ("$" + r.aiCost.toFixed(2)).padStart(6);
  const hrIdPct = r.highResSkipped ? " skip" : (((r.highResMatched / r.gtRoomCount) * 100).toFixed(0).padStart(4) + "%");
  const hrMae = r.highResSkipped ? "    " : (r.highResMae.toFixed(0).padStart(4) + "%");
  const hrCost = r.highResSkipped ? "     " : ("$" + r.highResCost.toFixed(2)).padStart(6);
  const hrPd = r.highResSkipped ? "    " : ((r.highResPrintedDimsRate * 100).toFixed(0).padStart(3) + "%");
  console.log(`  ${r.planId.padEnd(15)} |  ${vectorIdPct}  ${vectorMae}  |   ${aiIdPct}      ${aiMae}  ${aiCost} |  ${hrIdPct}    ${hrMae}  ${hrCost}  ${hrPd}`);
}

const totalVectorMatched = allResults.reduce((a, r) => a + r.vectorMatched, 0);
const totalGtRooms = allResults.reduce((a, r) => a + r.gtRoomCount, 0);
const totalAiMatched = allResults.reduce((a, r) => a + r.aiMatched, 0);
const totalAiCost = allResults.reduce((a, r) => a + r.aiCost, 0);
const totalHrMatched = allResults.reduce((a, r) => a + r.highResMatched, 0);
const totalHrCost = allResults.reduce((a, r) => a + r.highResCost, 0);
const allHrMaes = allResults.filter((r) => !r.highResSkipped).map((r) => r.highResMae);
const hrAvgMae = allHrMaes.length > 0 ? allHrMaes.reduce((a, b) => a + b, 0) / allHrMaes.length : 0;
const allAiMaes = allResults.filter((r) => !r.aiSkipped).map((r) => r.aiMae);
const aiAvgMae = allAiMaes.length > 0 ? allAiMaes.reduce((a, b) => a + b, 0) / allAiMaes.length : 0;
console.log(`${"─".repeat(106)}`);
console.log(
  `  ${"OVERALL".padEnd(15)} |  ${((totalVectorMatched / totalGtRooms) * 100).toFixed(0).padStart(4)}%       |   ${((totalAiMatched / totalGtRooms) * 100).toFixed(0).padStart(4)}%   ${aiAvgMae.toFixed(0).padStart(4)}% $${totalAiCost.toFixed(2)} |  ${((totalHrMatched / totalGtRooms) * 100).toFixed(0).padStart(4)}%  ${hrAvgMae.toFixed(0).padStart(4)}% $${totalHrCost.toFixed(2)}`,
);

const outPath = path.join(REPO, "tests/fixtures/benchmark-suite-results.json");
writeFileSync(
  outPath,
  JSON.stringify({ runAt: new Date().toISOString(), results: allResults }, null, 2),
);
console.log(`\nSaved: ${path.relative(REPO, outPath)}`);
