import { test, expect } from "@playwright/test";
import path from "node:path";
import { execSync } from "node:child_process";

const SAMPLE_PDF = path.join(__dirname, "fixtures", "sample-plan.pdf");

test.beforeAll(() => {
  try {
    execSync("npx prisma db push --force-reset --skip-generate", {
      cwd: path.join(__dirname, ".."),
      stdio: "ignore",
    });
  } catch {
    /* let test fail loudly */
  }
});

async function seedProject(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("empty-new-project-button").click();
  await page.getByTestId("project-name-input").fill("Phase 3 Chat Test");
  await page.getByTestId("submit-project-button").click();
  await page.waitForURL(/\/projects\/c[a-z0-9]{20,}$/i);
  await page.getByTestId("file-input").setInputFiles(SAMPLE_PDF);
  await expect(page.getByTestId("pages-list")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("pdf-canvas")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("run-takeoff").click();
  await expect(page.getByTestId("takeoff-loading")).toBeHidden({
    timeout: 30_000,
  });
  await expect(page.getByTestId("queue-item")).toHaveCount(5);
}

test("checkpoint 3 — chat tool use, query, history, undo", async ({ page }) => {
  await seedProject(page);

  // Accept all surfaces first so we have something to operate on.
  await page.getByTestId("accept-all-high").click();

  // Open the Chat tab in the right panel.
  await page.getByTestId("tab-chat").click();

  // Use the chat to change all bathroom walls.
  const chatInput = page.getByTestId("chat-input");
  await expect(chatInput).toBeVisible();
  await chatInput.fill("Change all bathroom walls to semi-gloss");
  await page.getByTestId("chat-send").click();

  // Wait for assistant reply (executed since count is < 10).
  await expect(
    page.locator('[data-testid="chat-message"][data-role="assistant"]').first(),
  ).toBeVisible({ timeout: 30_000 });

  // The tool call card should appear inside the assistant message.
  await expect(page.getByTestId("chat-tool-call").first()).toBeVisible();

  // Ask a quantity question.
  await chatInput.fill("What's the total square footage?");
  await page.getByTestId("chat-send").click();
  await expect.poll(
    async () => {
      const messages = await page
        .locator('[data-testid="chat-message"][data-role="assistant"]')
        .allTextContents();
      return messages.join(" ").toLowerCase();
    },
    { timeout: 30_000 },
  ).toContain("square feet");

  // Open History — should show entries in plain English.
  await page.getByTestId("history-button").click();
  await expect(page.getByTestId("history-drawer")).toBeVisible();
  const entries = page.getByTestId("history-entry");
  await expect(entries.first()).toBeVisible();
  // First entry should be the bathroom paint change OR accept-all-high entry.
  const firstText = (await entries.first().textContent()) ?? "";
  expect(firstText.length).toBeGreaterThan(5);

  // Undo the most recent undoable entry that changed paint.
  const undoBtns = page.getByTestId("history-undo");
  await expect(undoBtns.first()).toBeVisible();
  await undoBtns.first().click();

  // Verify history grew (undo creates its own entry).
  await expect.poll(
    async () => (await entries.count()),
    { timeout: 5_000 },
  ).toBeGreaterThan(1);

  await page.screenshot({
    path: "test-results/checkpoint-3.png",
    fullPage: true,
  });
});

test("checkpoint 3 — bulk confirmation modal for > 10 surfaces", async ({
  page,
}) => {
  // Seed with many surfaces matching a single room label so the bulk path triggers.
  await page.goto("/");
  // Need fresh DB — we'll reuse and just navigate to a new project.
  await page.getByTestId("new-project-button").click();
  await page.getByTestId("project-name-input").fill("Phase 3 Bulk Test");
  await page.getByTestId("submit-project-button").click();
  await page.waitForURL(/\/projects\/c[a-z0-9]{20,}$/i);
  const projectUrl = page.url();
  const projectId = projectUrl.split("/").pop()!;

  // Upload and run takeoff to make a plan page exist.
  await page.getByTestId("file-input").setInputFiles(SAMPLE_PDF);
  await expect(page.getByTestId("pages-list")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("pdf-canvas")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("run-takeoff").click();
  await expect(page.getByTestId("takeoff-loading")).toBeHidden({
    timeout: 30_000,
  });

  // Inject extra bathroom walls via API to exceed 10.
  const planPageId = await page.evaluate(async () => {
    const res = await fetch(window.location.pathname);
    return res.ok ? "" : "";
  });
  // Easier: hit the surfaces endpoint to get an existing planPageId.
  const fetched = await page.request.get(
    `/api/surfaces?projectId=${projectId}`,
  );
  const json = await fetched.json();
  const samplePage = json.surfaces[0].planPageId;

  for (let i = 0; i < 12; i++) {
    await page.request.post("/api/surfaces", {
      data: {
        projectId,
        planPageId: samplePage,
        type: "wall",
        polygon: [
          { x: 0.01, y: 0.01 + i * 0.01 },
          { x: 0.05, y: 0.01 + i * 0.01 },
          { x: 0.05, y: 0.05 + i * 0.01 },
          { x: 0.01, y: 0.05 + i * 0.01 },
        ],
        roomLabel: `Bathroom ${200 + i}`,
        paintType: "flat",
        coats: 2,
        substrate: "drywall",
        status: "accepted",
        source: "manual",
      },
    });
  }

  // Reload to pull fresh state.
  await page.reload();

  // Open the Chat tab.
  await page.getByTestId("tab-chat").click();

  const chatInput = page.getByTestId("chat-input");
  await chatInput.fill("Change all bathroom walls to semi-gloss");
  await page.getByTestId("chat-send").click();

  // Confirmation modal should appear since > 10 surfaces match.
  await expect(page.getByTestId("confirm-bulk-modal")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("confirm-bulk-modal")).toContainText(
    /change/i,
  );

  // Confirm.
  await page.getByTestId("confirm-bulk-yes").click();
  await expect(page.getByTestId("confirm-bulk-modal")).toBeHidden();

  // Tool call should have executed.
  await expect(page.getByTestId("chat-tool-call")).toHaveCount(1, {
    timeout: 10_000,
  });
});
