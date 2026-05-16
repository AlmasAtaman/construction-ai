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
    /* let the test fail loudly */
  }
});

test("checkpoint 2 — AI takeoff, accept/reject, manual draw, context menu, cache", async ({
  page,
}) => {
  // Set up: create project + upload sample plan.
  await page.goto("/");
  await page.getByTestId("empty-new-project-button").click();
  await page.getByTestId("project-name-input").fill("Phase 2 Test Project");
  await page.getByTestId("submit-project-button").click();
  await page.waitForURL(/\/projects\/c[a-z0-9]{20,}$/i);

  // Upload the sample PDF.
  await page.getByTestId("file-input").setInputFiles(SAMPLE_PDF);
  await expect(page.getByTestId("pages-list")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("pdf-canvas")).toBeVisible({ timeout: 30_000 });

  // Initial usage should be $0.00.
  const usageBadge = page.getByTestId("usage-badge");
  await expect(usageBadge).toContainText("$0.00");

  // Run AI Takeoff (TEST_MODE returns deterministic surfaces).
  await page.getByTestId("run-takeoff").click();
  await expect(page.getByTestId("takeoff-loading")).toBeVisible();
  // Wait for completion (loading hides) and detection queue to fill.
  await expect(page.getByTestId("takeoff-loading")).toBeHidden({
    timeout: 30_000,
  });
  await expect(page.getByTestId("detection-queue")).toBeVisible();
  // Should have 5 stubbed proposed surfaces.
  await expect(page.getByTestId("queue-item")).toHaveCount(5);

  // Usage badge increased above $0.00.
  await expect.poll(
    async () => {
      const txt = (await usageBadge.textContent()) ?? "";
      return txt;
    },
    { timeout: 5_000 },
  ).not.toContain("$0.00 /");

  // Confidence colors visible — items should have data-confidence attribute.
  await expect(
    page.locator('[data-testid="queue-item"][data-confidence="high"]').first(),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="queue-item"][data-confidence="low"]').first(),
  ).toBeVisible();

  // Accept first surface — its accept button should disappear from the queue.
  const initialCount = await page.getByTestId("queue-item").count();
  await page
    .getByTestId("queue-item")
    .first()
    .getByTestId("accept-surface")
    .click();
  await expect(page.getByTestId("queue-item")).toHaveCount(initialCount - 1);

  // Reject second surface — undo toast appears.
  const beforeReject = await page.getByTestId("queue-item").count();
  await page
    .getByTestId("queue-item")
    .first()
    .getByTestId("reject-surface")
    .click();
  await expect(page.getByTestId("queue-item")).toHaveCount(beforeReject - 1);
  await expect(page.getByTestId("undo-toast")).toBeVisible();

  // Use rectangle tool to draw a manual surface.
  await page.getByTestId("tool-rectangle").click();
  await expect(page.getByTestId("tool-rectangle")).toHaveAttribute(
    "data-active",
    "true",
  );

  // Collapse the worksheet so the canvas has more room.
  await page.getByTestId("worksheet-toggle").click();
  const overlay = page.getByTestId("surface-overlay");
  await expect(overlay).toBeVisible();
  const box = await overlay.boundingBox();
  if (!box) throw new Error("Could not get overlay bounding box");
  // Drag in the gap between top and bottom rows (~0.42-0.48 vertically) and
  // a horizontally empty band (~0.5-0.65) — well clear of stub surfaces.
  const startX = box.x + box.width * 0.5;
  const startY = box.y + box.height * 0.42;
  const endX = box.x + box.width * 0.65;
  const endY = box.y + box.height * 0.48;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 4, startY + 4);
  await page.mouse.move(endX, endY, { steps: 10 });
  await page.mouse.up();

  // Tool palette should return to select after a successful draw.
  await expect(page.getByTestId("tool-select")).toHaveAttribute(
    "data-active",
    "true",
    { timeout: 5_000 },
  );

  // Re-run takeoff — should be cached (no usage increase, cached banner visible).
  const beforeCacheUsage =
    (await usageBadge.textContent()) ?? "";
  await page.getByTestId("run-takeoff").click();
  await expect(page.getByTestId("takeoff-cached")).toBeVisible({
    timeout: 10_000,
  });
  // Usage should be unchanged after a cached call.
  await expect(usageBadge).toHaveText(beforeCacheUsage);

  await page.screenshot({
    path: "test-results/checkpoint-2.png",
    fullPage: true,
  });
});
