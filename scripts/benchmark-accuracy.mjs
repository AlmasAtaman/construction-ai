// Score the takeoff pipeline against a ground-truth fixture.
//
// Usage: node scripts/benchmark-accuracy.mjs [page-number]
//
// Assumes the dev server is running at localhost:3000 with the real
// Anthropic key (NOT TEST_MODE). Creates a one-off project, uploads
// the benchmark PDF, runs takeoff via the SSE route, reads the resulting
// Surface records from the API, and prints a per-room accuracy report.
//
// We don't care which fields ended up where — only what the AI actually
// produced compared to known dimensions on the plan.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PAGE_NUM = parseInt(process.argv[2] ?? "1", 10);
const BASE = process.env.PAINTERDESK_URL ?? "http://localhost:3000";
const FIXTURE_PDF = path.join(
  ROOT,
  process.env.PLAN_FIXTURE ?? "tests/fixtures/benchmark-plan.pdf",
);
const GROUND_TRUTH_PATH = path.join(
  ROOT,
  "tests/fixtures/benchmark-ground-truth.json",
);
const CEILING_HEIGHT_FT = 9;

const groundTruth = JSON.parse(readFileSync(GROUND_TRUTH_PATH, "utf8"));
const truthPage = groundTruth.pages.find((p) => p.pageNumber === PAGE_NUM);
if (!truthPage) {
  console.error(`No ground truth for page ${PAGE_NUM}`);
  process.exit(1);
}
const truthRooms = truthPage.rooms.filter((r) => r.interior !== false);

// ---- helpers ----------------------------------------------------------
function normalize(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Tokens we ignore when matching — they appear in many room names and
// would cause false matches like Family Room ↔ Laundry Room.
const STOPWORDS = new Set([
  "room",
  "area",
  "space",
  "the",
  "of",
  "at",
]);

function fuzzyMatch(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Strict substring match (a contains b or vice versa).
  if (na.includes(nb) || nb.includes(na)) return true;
  // Token overlap on non-stopword tokens, weighted by min-set size.
  const tokenize = (s) =>
    new Set(
      s
        .split(" ")
        .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
    );
  const ta = tokenize(na);
  const tb = tokenize(nb);
  if (ta.size === 0 || tb.size === 0) return false;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  // Require majority of the shorter set to overlap.
  return overlap >= Math.min(ta.size, tb.size);
}

function trueFloorArea(room) {
  return room.widthFt * room.heightFt;
}
function trueWallPerimeter(room) {
  return 2 * (room.widthFt + room.heightFt);
}
function trueWallArea(room) {
  return trueWallPerimeter(room) * CEILING_HEIGHT_FT;
}

function pct(actual, expected) {
  if (!expected) return 0;
  return ((actual - expected) / expected) * 100;
}

// ---- pipeline driver --------------------------------------------------
async function main() {
  // 1. Create a benchmark project.
  console.log("Creating benchmark project...");
  let res = await fetch(`${BASE}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `Benchmark — Page ${PAGE_NUM} — ${new Date().toISOString()}`,
    }),
  });
  if (!res.ok) throw new Error(`Project create failed: ${res.status}`);
  const { project } = await res.json();
  console.log(`  Project: ${project.id}`);

  // 2. Upload the benchmark PDF.
  console.log("Uploading benchmark PDF...");
  const pdfBytes = readFileSync(FIXTURE_PDF);
  const form = new FormData();
  form.append("projectId", project.id);
  form.append("file", new Blob([pdfBytes], { type: "application/pdf" }), "benchmark-plan.pdf");
  res = await fetch(`${BASE}/api/upload`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  const { plan } = await res.json();
  const planPage = plan.pages.find((p) => p.pageNumber === PAGE_NUM);
  if (!planPage) throw new Error(`Page ${PAGE_NUM} not in uploaded plan.`);
  console.log(`  Plan page: ${planPage.id}`);

  // 3. Run the takeoff via SSE, swallowing progress events.
  console.log("Running AI takeoff (this takes ~30 seconds)...");
  const t0 = Date.now();
  res = await fetch(`${BASE}/api/ai/takeoff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planPageId: planPage.id }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Takeoff start failed: ${res.status} ${await res.text()}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = null;
  let errorPayload = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      let evtName = "message";
      let data = null;
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) evtName = line.slice(7).trim();
        else if (line.startsWith("data: ")) data = JSON.parse(line.slice(6));
      }
      if (evtName === "complete") completed = data;
      else if (evtName === "error") errorPayload = data;
      else if (data?.stage) console.log(`  [stage] ${data.stage}${data.message ? " — " + data.message : ""}`);
    }
  }
  const elapsedSec = (Date.now() - t0) / 1000;
  if (errorPayload) throw new Error(`Takeoff error: ${errorPayload.error}`);
  if (!completed) throw new Error("Takeoff did not complete.");
  console.log(`  Done in ${elapsedSec.toFixed(1)}s`);

  // 4. Pull resulting surfaces.
  res = await fetch(`${BASE}/api/surfaces?planPageId=${planPage.id}`);
  if (!res.ok) throw new Error(`Surfaces fetch failed: ${res.status}`);
  const { surfaces } = await res.json();

  // 5. Score.
  const aiWalls = surfaces.filter((s) => s.type === "wall");
  const aiCeilings = surfaces.filter((s) => s.type === "ceiling");

  const roomScores = [];
  for (const truth of truthRooms) {
    const matchedWalls = aiWalls.filter((w) => fuzzyMatch(w.roomLabel, truth.label));
    const matchedCeil = aiCeilings.filter((c) => fuzzyMatch(c.roomLabel, truth.label));
    const wallSum = matchedWalls.reduce((a, w) => a + (w.squareFootage ?? 0), 0);
    const ceilSum = matchedCeil.reduce((a, c) => a + (c.squareFootage ?? 0), 0);
    const trueWalls = trueWallArea(truth);
    const trueCeil = trueFloorArea(truth);
    roomScores.push({
      room: truth.label,
      trueWallSqft: Math.round(trueWalls),
      aiWallSqft: Math.round(wallSum),
      wallErrPct: matchedWalls.length ? pct(wallSum, trueWalls) : null,
      trueCeilSqft: Math.round(trueCeil),
      aiCeilSqft: Math.round(ceilSum),
      ceilErrPct: matchedCeil.length ? pct(ceilSum, trueCeil) : null,
      walls_found: matchedWalls.length,
      ceilings_found: matchedCeil.length,
    });
  }

  const found = roomScores.filter((r) => r.walls_found > 0).length;
  const coverage = (found / truthRooms.length) * 100;

  // Median absolute % error on rooms where we found something.
  const wallErrs = roomScores
    .map((r) => r.wallErrPct)
    .filter((v) => v !== null)
    .map(Math.abs)
    .sort((a, b) => a - b);
  const median = (xs) =>
    xs.length === 0 ? null : xs[Math.floor(xs.length / 2)];

  console.log("");
  console.log("=== Per-room accuracy ===");
  for (const r of roomScores) {
    console.log(
      `  ${r.room.padEnd(20)} | walls ${String(r.aiWallSqft).padStart(5)} vs true ${String(r.trueWallSqft).padStart(5)}` +
        ` (${r.wallErrPct === null ? "MISS" : (r.wallErrPct > 0 ? "+" : "") + r.wallErrPct.toFixed(0) + "%"})` +
        ` | ceil ${String(r.aiCeilSqft).padStart(4)} vs true ${String(r.trueCeilSqft).padStart(4)}` +
        ` (${r.ceilErrPct === null ? "MISS" : (r.ceilErrPct > 0 ? "+" : "") + r.ceilErrPct.toFixed(0) + "%"})`,
    );
  }

  console.log("");
  console.log("=== Summary ===");
  console.log(`  Interior rooms in ground truth:  ${truthRooms.length}`);
  console.log(`  Rooms the AI detected:           ${found} / ${truthRooms.length}`);
  console.log(`  Coverage:                        ${coverage.toFixed(0)}%`);
  console.log(`  Median abs % error on walls:     ${median(wallErrs)?.toFixed(0) ?? "n/a"}%`);
  console.log(`  AI walls total (sqft):           ${Math.round(aiWalls.reduce((a, w) => a + (w.squareFootage ?? 0), 0))}`);
  console.log(`  Truth walls total (sqft):        ${Math.round(truthRooms.reduce((a, r) => a + trueWallArea(r), 0))}`);
  console.log(`  AI ceilings total (sqft):        ${Math.round(aiCeilings.reduce((a, c) => a + (c.squareFootage ?? 0), 0))}`);
  console.log(`  Truth ceilings total (sqft):    ${Math.round(truthRooms.reduce((a, r) => a + trueFloorArea(r), 0))}`);

  const usageRes = await fetch(`${BASE}/api/usage`);
  const usage = usageRes.ok ? await usageRes.json() : null;
  if (usage) {
    console.log(`  AI spend today (USD):            $${usage.spend.toFixed(4)}`);
  }
  console.log(`  Elapsed:                         ${elapsedSec.toFixed(1)}s`);
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
