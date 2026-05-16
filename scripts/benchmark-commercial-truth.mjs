// Score the takeoff pipeline against a commercial plan WITHOUT a dim
// table, using per-room "NN SF" callouts as ground truth.
//
// Match strategy: each truth room has a list of `matchKeys` (e.g.,
// ["ce-5", "ce5", "corridor"]). We match an AI surface to a truth
// room when its label contains ANY of the keys (case-insensitive).
// Per-room AI sqft is summed across all matched surface entries.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PAGE_NUM = parseInt(process.argv[2] ?? "1", 10);
const BASE = process.env.PAINTERDESK_URL ?? "http://localhost:3000";
const FIXTURE_PDF = path.join(ROOT, "tests/fixtures/commercial-bench.pdf");
const GROUND_TRUTH_PATH = path.join(
  ROOT,
  "tests/fixtures/commercial-bench-ground-truth.json",
);

const truth = JSON.parse(readFileSync(GROUND_TRUTH_PATH, "utf8"));
const truthPage = truth.pages.find((p) => p.pageNumber === PAGE_NUM);
if (!truthPage) {
  console.error(`No truth for page ${PAGE_NUM}`);
  process.exit(1);
}

function fold(s) {
  return String(s ?? "").toLowerCase();
}

function matches(aiLabel, truthRoom) {
  const folded = fold(aiLabel);
  return truthRoom.matchKeys.some((k) => folded.includes(fold(k)));
}

async function postJson(p, body) {
  const r = await fetch(`${BASE}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${p} → ${r.status} ${await r.text()}`);
  return r.json();
}
async function getJson(p) {
  const r = await fetch(`${BASE}${p}`);
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
}

const t0 = Date.now();
const { project } = await postJson("/api/projects", {
  name: `Commercial-truth bench ${new Date().toISOString()}`,
});
console.log(`project: ${project.id}`);

const pdfBytes = readFileSync(FIXTURE_PDF);
const form = new FormData();
form.append("projectId", project.id);
form.append(
  "file",
  new Blob([pdfBytes], { type: "application/pdf" }),
  "commercial-bench.pdf",
);
const upRes = await fetch(`${BASE}/api/upload`, { method: "POST", body: form });
if (!upRes.ok) throw new Error(`upload failed ${upRes.status}`);
const { plan } = await upRes.json();
const planPage = plan.pages.find((p) => p.pageNumber === PAGE_NUM);
console.log(`page ${PAGE_NUM}: ${planPage.id}\nrunning takeoff…`);

const taker = await fetch(`${BASE}/api/ai/takeoff`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ planPageId: planPage.id }),
});
const reader = taker.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let errPayload = null;
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let nl;
  while ((nl = buffer.indexOf("\n\n")) !== -1) {
    const chunk = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 2);
    let evt = "message";
    let data = null;
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event: ")) evt = line.slice(7).trim();
      else if (line.startsWith("data: ")) data = JSON.parse(line.slice(6));
    }
    if (evt === "error") errPayload = data;
    else if (data?.stage)
      console.log(`  [stage] ${data.stage}${data.message ? " — " + data.message : ""}`);
  }
}
if (errPayload) {
  console.error("ERR:", errPayload);
  process.exit(1);
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const { surfaces } = await getJson(
  `/api/surfaces?planPageId=${planPage.id}`,
);
const ceilings = surfaces.filter((s) => s.type === "ceiling");
const walls = surfaces.filter((s) => s.type === "wall");

console.log(
  `\n  AI returned: ${walls.length} walls, ${ceilings.length} ceilings, ${surfaces.length} total surfaces\n`,
);

// Score each truth room.
function pctDiff(a, b) {
  if (!b) return null;
  return ((a - b) / b) * 100;
}

console.log("=== Per-room (floor / ceiling sqft) accuracy ===");
const rows = [];
let totalErr = 0;
let withinTen = 0;
let withinTwenty = 0;
let matched = 0;
for (const r of truthPage.rooms) {
  const matched_ceilings = ceilings.filter((c) => matches(c.roomLabel, r));
  const matched_walls = walls.filter((w) => matches(w.roomLabel, r));
  // Score AI's CEILING area against truth's floor area (they're equal).
  // If the AI didn't measure a ceiling for this room, fall back to the
  // largest matched wall's perimeter² / 16 — but realistically a missing
  // ceiling = a miss.
  const aiCeilingSqft = matched_ceilings.reduce(
    (a, c) => a + (c.squareFootage ?? 0),
    0,
  );
  const aiAreaSource =
    matched_ceilings.length > 0
      ? aiCeilingSqft
      : (() => {
          // Approximate floor area from wall linear_ft.
          const totalLf = matched_walls.reduce(
            (a, w) => a + (w.linearFootage ?? 0),
            0,
          );
          if (totalLf <= 0) return 0;
          // For an approx square room, floor area ≈ (perimeter/4)^2
          return Math.pow(totalLf / 4, 2);
        })();
  const err = pctDiff(aiAreaSource, r.trueFloorAreaSqft);
  rows.push({
    label: r.label,
    truth: r.trueFloorAreaSqft,
    ai: Math.round(aiAreaSource),
    matched_ceilings: matched_ceilings.length,
    matched_walls: matched_walls.length,
    err,
  });
  if (matched_walls.length + matched_ceilings.length > 0) {
    matched++;
    if (err !== null) {
      totalErr += Math.abs(err);
      if (Math.abs(err) <= 10) withinTen++;
      if (Math.abs(err) <= 20) withinTwenty++;
    }
  }
}
for (const r of rows) {
  const errStr =
    r.err === null
      ? r.matched_walls + r.matched_ceilings === 0
        ? "MISS"
        : "n/a"
      : `${r.err > 0 ? "+" : ""}${r.err.toFixed(0)}%`;
  console.log(
    `  ${r.label.padEnd(30)} truth=${String(r.truth).padStart(4)} ai=${String(r.ai).padStart(4)} (${errStr})  matched: ${r.matched_walls}W ${r.matched_ceilings}C`,
  );
}

const medianErr = (() => {
  const errs = rows
    .filter((r) => r.err !== null)
    .map((r) => Math.abs(r.err))
    .sort((a, b) => a - b);
  if (errs.length === 0) return null;
  return errs[Math.floor(errs.length / 2)];
})();

console.log("\n=== Summary ===");
console.log(`  Ground-truth rooms: ${truthPage.rooms.length}`);
console.log(`  AI matched rooms:   ${matched} / ${truthPage.rooms.length}`);
console.log(`  Within ±10%:        ${withinTen} / ${truthPage.rooms.length}`);
console.log(`  Within ±20%:        ${withinTwenty} / ${truthPage.rooms.length}`);
console.log(`  Median abs % error: ${medianErr === null ? "n/a" : medianErr.toFixed(0) + "%"}`);
const totalTruthSqft = truthPage.rooms.reduce(
  (a, r) => a + r.trueFloorAreaSqft,
  0,
);
const totalAiSqft = rows.reduce((a, r) => a + r.ai, 0);
console.log(`  Truth total sqft:   ${totalTruthSqft}`);
console.log(`  AI total sqft:      ${Math.round(totalAiSqft)}`);
console.log(`  Total Δ:            ${pctDiff(totalAiSqft, totalTruthSqft).toFixed(1)}%`);
console.log(`  Wall time:          ${elapsed}s`);

const usage = await getJson("/api/usage").catch(() => null);
if (usage) console.log(`  AI spend today:     $${usage.spend.toFixed(4)}`);
