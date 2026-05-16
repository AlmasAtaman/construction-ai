// Score the chat agent against an adversarial prompt suite. Creates a
// project with realistic surfaces, fires each test prompt through
// /api/ai/chat, and checks both the assistant's text AND the actual
// database state for the expected post-condition.
//
// Usage: node scripts/benchmark-chat.mjs
//
// Requires the dev server running at localhost:3000 with the real
// Anthropic key (not TEST_MODE — we want to see the real model handle
// these prompts).

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BASE = process.env.PAINTERDESK_URL ?? "http://localhost:3000";

// ---------------------------------------------------------------
// Test fixtures: realistic surfaces seeded into a fresh project.
// ---------------------------------------------------------------
const SEED_SURFACES = [
  // Bathrooms
  { type: "wall", roomLabel: "Bathroom 101", paintType: "flat", coats: 2, substrate: "drywall", area: 220 },
  { type: "wall", roomLabel: "Bathroom 102", paintType: "flat", coats: 2, substrate: "drywall", area: 240 },
  { type: "wall", roomLabel: "Powder Room", paintType: "flat", coats: 2, substrate: "drywall", area: 80 },
  // Offices (multiple floors)
  { type: "wall", roomLabel: "Office 201 - Ground", paintType: "eggshell", coats: 2, substrate: "drywall", area: 380 },
  { type: "wall", roomLabel: "Office 301 - Second Floor", paintType: "eggshell", coats: 2, substrate: "drywall", area: 420 },
  { type: "wall", roomLabel: "Office 302 - Second Floor", paintType: "eggshell", coats: 2, substrate: "drywall", area: 380 },
  { type: "wall", roomLabel: "Open Office - Center", paintType: "eggshell", coats: 2, substrate: "drywall", area: 1850 },
  // Corridors
  { type: "wall", roomLabel: "Corridor East", paintType: "eggshell", coats: 2, substrate: "drywall", area: 540 },
  { type: "wall", roomLabel: "Corridor West", paintType: "eggshell", coats: 2, substrate: "drywall", area: 480 },
  // Elevators (multiple distinct rooms)
  { type: "wall", roomLabel: "ELEVATORS Core", paintType: "flat", coats: 2, substrate: "CMU", area: 540 },
  { type: "wall", roomLabel: "SERVICE ELEVATOR", paintType: "flat", coats: 2, substrate: "CMU", area: 220 },
  // Stairwells
  { type: "wall", roomLabel: "STAIRWELLS East", paintType: "flat", coats: 2, substrate: "CMU", area: 420 },
  { type: "wall", roomLabel: "STAIRWELLS West", paintType: "flat", coats: 2, substrate: "CMU", area: 420 },
  // Kitchen
  { type: "wall", roomLabel: "Kitchen", paintType: "semi-gloss", coats: 2, substrate: "drywall", area: 320 },
  // Ceilings
  { type: "ceiling", roomLabel: "Bathroom 101", paintType: "flat", coats: 2, substrate: "drywall", area: 80 },
  { type: "ceiling", roomLabel: "Kitchen", paintType: "flat", coats: 2, substrate: "drywall", area: 210 },
];

// ---------------------------------------------------------------
// The adversarial suite. Each test sends `message` to /api/ai/chat
// and then runs `expect(state)` against the surfaces table to verify
// the right rooms were touched.
// ---------------------------------------------------------------
const TESTS = [
  {
    name: "filter precision: 'bathroom walls' should match 3 rooms (Bathroom 101/102 + Powder Room)",
    message: "Change all bathroom walls to semi-gloss epoxy",
    expect: (surfaces) => {
      const changed = surfaces.filter(
        (s) => s.type === "wall" && s.paintType === "semi-gloss epoxy",
      );
      const labels = changed.map((s) => s.roomLabel).sort();
      // STRICT: AI should hit only labelled-bathroom and powder rooms,
      // NOT generic "Office" or "Corridor".
      const expected = ["Bathroom 101", "Bathroom 102", "Powder Room"].sort();
      const offBudgetHits = labels.filter((l) => !expected.includes(l));
      const missed = expected.filter((l) => !labels.includes(l));
      return {
        ok: offBudgetHits.length === 0 && missed.length === 0,
        detail: `changed=${labels.length} expected=${expected.length} extras=[${offBudgetHits.join(",")}] missed=[${missed.join(",")}]`,
      };
    },
  },
  {
    name: "synonym: 'restroom' should match Bathroom rooms",
    message: "Add a third coat to all restroom walls",
    expect: (surfaces) => {
      const triple = surfaces.filter(
        (s) =>
          s.type === "wall" &&
          (s.roomLabel.toLowerCase().includes("bathroom") ||
            s.roomLabel.toLowerCase().includes("powder")) &&
          s.coats === 3,
      );
      const overhit = surfaces.filter(
        (s) =>
          s.type === "wall" &&
          s.coats === 3 &&
          !s.roomLabel.toLowerCase().includes("bathroom") &&
          !s.roomLabel.toLowerCase().includes("powder"),
      );
      return {
        ok: triple.length >= 2 && overhit.length === 0,
        detail: `triple-coat walls=${triple.length} (rooms: ${triple.map((s) => s.roomLabel).join(",")}) | over-hits=${overhit.length}`,
      };
    },
  },
  {
    name: "specificity: 'second floor offices' should match only floor 2 offices",
    message: "Set all second floor office walls to high-gloss enamel",
    // Use a paint type NOT present in any seed surface so the matcher
    // only counts surfaces that were actually changed by this command.
    expect: (surfaces) => {
      const changed = surfaces.filter(
        (s) => s.type === "wall" && s.paintType === "high-gloss enamel",
      );
      const labels = changed.map((s) => s.roomLabel);
      const onSecondFloor = labels.filter((l) =>
        l.toLowerCase().includes("second floor"),
      );
      const offBudgetHits = labels.filter(
        (l) => !l.toLowerCase().includes("second floor"),
      );
      return {
        ok: onSecondFloor.length === 2 && offBudgetHits.length === 0,
        detail: `second-floor hits=${onSecondFloor.length} (${onSecondFloor.join(", ")}) extras=[${offBudgetHits.join(",")}]`,
      };
    },
  },
  {
    name: "exclude with reason: 'elevator walls — stainless finished'",
    message: "Exclude all elevator walls from the bid because they're stainless finished",
    expect: (surfaces) => {
      const excluded = surfaces.filter(
        (s) => s.status === "excluded" && s.roomLabel.toLowerCase().includes("elevator"),
      );
      const overhit = surfaces.filter(
        (s) =>
          s.status === "excluded" && !s.roomLabel.toLowerCase().includes("elevator"),
      );
      return {
        ok: excluded.length >= 2 && overhit.length === 0,
        detail: `excluded elevator surfaces=${excluded.length} | over-hits=${overhit.length}`,
      };
    },
  },
  {
    name: "numerical: 'waste 12 percent' → 0.12",
    message: "Set the waste factor to 12 percent",
    expectProject: (project) => ({
      ok: Math.abs((project.wasteFactor ?? 0) - 0.12) < 0.001,
      detail: `wasteFactor=${project.wasteFactor}`,
    }),
  },
  {
    name: "query: 'how many surfaces in the kitchen'",
    message: "How many surfaces do I have in the kitchen?",
    expectAssistant: (text) => {
      const t = text.toLowerCase();
      // Truth: 2 surfaces in Kitchen (1 wall + 1 ceiling) seeded.
      const hasNumber = /\b2\b/.test(t);
      const hasContext = t.includes("kitchen") || t.includes("surfaces");
      return {
        ok: hasNumber && hasContext,
        detail: `assistant said: "${text.slice(0, 100)}"`,
      };
    },
  },
  {
    name: "no-op safety: 'change purple walls to semi-gloss' — there are no purple walls",
    message: "Change all purple walls to semi-gloss",
    expect: (surfaces) => {
      // Nothing should change. AI should report 0 affected, not invent matches.
      const semiGlossWalls = surfaces.filter(
        (s) => s.type === "wall" && s.paintType === "semi-gloss",
      );
      // Kitchen was originally semi-gloss; that one should remain.
      const onlyKitchen = semiGlossWalls.length === 1 && semiGlossWalls[0].roomLabel === "Kitchen";
      return {
        ok: onlyKitchen,
        detail: `semi-gloss walls = ${semiGlossWalls.length} (${semiGlossWalls.map((s) => s.roomLabel).join(",")})`,
      };
    },
  },
  {
    name: "ambiguity: 'change the office walls' (4 office-y rooms in two floors) — should preview or affect all",
    message: "Change the office walls to high-gloss enamel",
    expect: (surfaces) => {
      const changed = surfaces.filter(
        (s) => s.type === "wall" && s.paintType === "high-gloss enamel",
      );
      const offices = changed.filter((s) => s.roomLabel.toLowerCase().includes("office"));
      const nonOffices = changed.filter(
        (s) => !s.roomLabel.toLowerCase().includes("office"),
      );
      return {
        ok: offices.length >= 3 && nonOffices.length === 0,
        detail: `office walls changed=${offices.length} | non-office hits=${nonOffices.length}`,
      };
    },
  },
];

// ---------------------------------------------------------------
// Plumbing.
// ---------------------------------------------------------------
async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${path} → ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

async function seedProject() {
  const { project } = await postJson("/api/projects", {
    name: `Chat benchmark ${new Date().toISOString()}`,
  });
  // Upload a tiny PDF just so we have a planPage to attach surfaces to.
  const pdfBytes = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<<>>>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000100 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n160\n%%EOF\n",
    "latin1",
  );
  const form = new FormData();
  form.append("projectId", project.id);
  form.append(
    "file",
    new Blob([pdfBytes], { type: "application/pdf" }),
    "seed.pdf",
  );
  const upRes = await fetch(`${BASE}/api/upload`, {
    method: "POST",
    body: form,
  });
  if (!upRes.ok) throw new Error(`upload failed ${upRes.status}`);
  const { plan } = await upRes.json();
  const planPageId = plan.pages[0].id;

  for (const s of SEED_SURFACES) {
    await postJson("/api/surfaces", {
      projectId: project.id,
      planPageId,
      type: s.type,
      polygon: [
        { x: 0.1, y: 0.1 },
        { x: 0.2, y: 0.1 },
        { x: 0.2, y: 0.2 },
        { x: 0.1, y: 0.2 },
      ],
      paintType: s.paintType,
      coats: s.coats,
      substrate: s.substrate,
      roomLabel: s.roomLabel,
      squareFootage: s.area,
      status: "accepted",
      source: "manual",
    });
  }
  return project.id;
}

async function sendChat(projectId, message) {
  return postJson("/api/ai/chat", { projectId, message });
}

async function getSurfaces(projectId) {
  const { surfaces } = await getJson(`/api/surfaces?projectId=${projectId}`);
  return surfaces;
}

async function getProject(projectId) {
  const { project } = await getJson(`/api/projects/${projectId}`);
  return project;
}

// ---------------------------------------------------------------
async function main() {
  const results = [];
  for (const t of TESTS) {
    process.stdout.write(`▶ ${t.name}\n`);
    const projectId = await seedProject();
    let assistantText = "";
    let toolCalls = [];
    let confirmation = null;
    try {
      const r = await sendChat(projectId, t.message);
      assistantText = r.assistantText ?? "";
      toolCalls = r.executions ?? [];
      confirmation = r.pendingConfirmation ?? null;
    } catch (err) {
      results.push({ name: t.name, ok: false, detail: `request failed: ${err.message}` });
      continue;
    }
    // For tests where bulk confirmation is expected, auto-confirm.
    if (confirmation?.token) {
      try {
        const c = await postJson("/api/ai/chat", {
          projectId,
          message: "[confirm]",
          confirmBulkToken: confirmation.token,
        });
        toolCalls = toolCalls.concat(c.executions ?? []);
        assistantText += " | " + (c.assistantText ?? "");
      } catch {
        /* keep going */
      }
    }
    const surfaces = await getSurfaces(projectId);
    const project = await getProject(projectId);
    let check;
    if (t.expect) check = t.expect(surfaces);
    else if (t.expectProject) check = t.expectProject(project);
    else if (t.expectAssistant) check = t.expectAssistant(assistantText);
    else check = { ok: false, detail: "no expectation set" };
    results.push({
      name: t.name,
      ok: check.ok,
      detail: check.detail,
      tools: toolCalls.length,
      assistant: assistantText.slice(0, 120),
    });
    process.stdout.write(
      `  ${check.ok ? "✓" : "✘"} ${check.detail}\n` +
        `  tools=${toolCalls.length} text="${assistantText.slice(0, 80)}"\n`,
    );
  }

  console.log("\n=== Chat benchmark summary ===");
  const passed = results.filter((r) => r.ok).length;
  console.log(`  ${passed} / ${results.length} passed`);
  const usage = await getJson("/api/usage").catch(() => null);
  if (usage) console.log(`  AI spend today: $${usage.spend.toFixed(4)}`);
  if (passed !== results.length) {
    console.log("");
    console.log("  Failures:");
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`    - ${r.name}`);
      console.log(`        ${r.detail}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
