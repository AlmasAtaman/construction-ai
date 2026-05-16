// Run the IQ Buildings commercial plan (page 4 — the multi-tenant
// office floor with labels embedded in the drawing). We don't have a
// dim-table ground truth, so this script reports surface count,
// per-room sqft, and total cost. Useful for catching regressions in
// the per-room-cropping pipeline.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BASE = process.env.PAINTERDESK_URL ?? "http://localhost:3000";
const PDF_PATH = path.join(ROOT, "tests/fixtures/real-plan.pdf");
const PAGE_NUM = 4;

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
  name: `IQ commercial bench ${new Date().toISOString()}`,
});
console.log(`project: ${project.id}`);

const pdfBytes = readFileSync(PDF_PATH);
const form = new FormData();
form.append("projectId", project.id);
form.append(
  "file",
  new Blob([pdfBytes], { type: "application/pdf" }),
  "real-plan.pdf",
);
const upRes = await fetch(`${BASE}/api/upload`, { method: "POST", body: form });
const { plan } = await upRes.json();
const planPage = plan.pages.find((p) => p.pageNumber === PAGE_NUM);
console.log(`uploaded — page ${PAGE_NUM} id: ${planPage.id}`);

console.log("running takeoff…");
const taker = await fetch(`${BASE}/api/ai/takeoff`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ planPageId: planPage.id }),
});
const reader = taker.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let complete = null;
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
    if (evt === "complete") complete = data;
    else if (evt === "error") errPayload = data;
    else if (data?.stage)
      console.log(`  [stage] ${data.stage}${data.message ? " — " + data.message : ""}`);
  }
}
if (errPayload) {
  console.error("ERR:", errPayload);
  process.exit(1);
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const { surfaces } = await getJson(`/api/surfaces?projectId=${project.id}`);
const walls = surfaces.filter((s) => s.type === "wall");
const ceilings = surfaces.filter((s) => s.type === "ceiling");
const totalWallSqft = walls.reduce((a, w) => a + (w.squareFootage ?? 0), 0);
const totalCeilingSqft = ceilings.reduce((a, w) => a + (w.squareFootage ?? 0), 0);

console.log(`\n=== Commercial benchmark — IQ Buildings page ${PAGE_NUM} ===`);
console.log(`  Wall surfaces:      ${walls.length}`);
console.log(`  Ceiling surfaces:   ${ceilings.length}`);
console.log(`  Total wall sqft:    ${Math.round(totalWallSqft)}`);
console.log(`  Total ceiling sqft: ${Math.round(totalCeilingSqft)}`);
console.log(`  Wall time:          ${elapsed}s`);

// Plausibility: ratio of total wall sqft to ceiling sqft. For a 9 ft
// commercial floor it should be roughly 1.5–3x.
const ratio = totalWallSqft / Math.max(1, totalCeilingSqft);
console.log(`  Walls / ceilings:   ${ratio.toFixed(2)} (typical 1.5–3.0)`);

console.log("\n--- Sample room walls ---");
const sample = walls.slice(0, 12).map((w) => ({
  room: w.roomLabel,
  sqft: Math.round(w.squareFootage ?? 0),
  lf: w.linearFootage ? Math.round(w.linearFootage) : null,
  conf: (w.confidence ?? 0).toFixed(2),
}));
console.table(sample);

const usage = await getJson("/api/usage").catch(() => null);
if (usage) console.log(`\nAI spend today: $${usage.spend.toFixed(4)}`);
