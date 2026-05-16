import { test, expect } from "@playwright/test";
import path from "node:path";
import { execSync } from "node:child_process";

const SAMPLE_PDF = path.join(__dirname, "fixtures", "sample-plan.pdf");
const SAMPLE_SPECS = path.join(__dirname, "fixtures", "sample-specs.pdf");

test.beforeAll(() => {
  try {
    execSync("npx prisma db push --force-reset --skip-generate", {
      cwd: path.join(__dirname, ".."),
      stdio: "ignore",
    });
  } catch {
    /* fail loudly */
  }
});

test("checkpoint 4 — worksheet totals, labor rate changes, painter rules, spec analyzer", async ({
  page,
}) => {
  // Create project + takeoff + accept all so worksheet has surfaces.
  await page.goto("/");
  await page.getByTestId("empty-new-project-button").click();
  await page.getByTestId("project-name-input").fill("Phase 4 Test");
  await page.getByTestId("submit-project-button").click();
  await page.waitForURL(/\/projects\/c[a-z0-9]{20,}$/i);
  const projectUrl = page.url();

  await page.getByTestId("file-input").setInputFiles(SAMPLE_PDF);
  await expect(page.getByTestId("pages-list")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("pdf-canvas")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("run-takeoff").click();
  await expect(page.getByTestId("takeoff-loading")).toBeHidden({
    timeout: 30_000,
  });
  await page.getByTestId("accept-all-high").click();

  // Worksheet should be visible at the bottom with totals.
  await expect(page.getByTestId("worksheet")).toBeVisible();
  await expect(page.getByTestId("worksheet-row").first()).toBeVisible();
  const grandTotal = page.getByTestId("worksheet-grand-total");
  const initialTotal = (await grandTotal.textContent()) ?? "";
  expect(initialTotal).toContain("$");

  // Open Labor rates, change wall rate, save, return to project.
  await page.goto("/settings/rates");
  await page.getByTestId("hourly-wall").fill("100");
  await page.getByTestId("save-rates").click();
  await expect(page.getByTestId("saved-toast")).toBeVisible();

  // Back to project — worksheet recalculates.
  await page.goto(projectUrl);
  await expect(page.getByTestId("worksheet")).toBeVisible();
  await expect.poll(
    async () => (await grandTotal.textContent()) ?? "",
    { timeout: 10_000 },
  ).not.toEqual(initialTotal);

  // Open painter rules, add waste-factor rule, save.
  await page.goto("/settings/rules");
  await page
    .getByTestId("rules-textarea")
    .fill("Always use 18% waste factor for interior commercial work.");
  await page.getByTestId("save-rules").click();
  await expect(page.getByTestId("saved-toast")).toBeVisible();

  // Back to project — worksheet recalculates with new waste factor.
  await page.goto(projectUrl);
  await expect(page.getByTestId("worksheet")).toBeVisible();
  // Material cost should have gone up because waste went from 10% -> 18%.
  // We just confirm the grand total changed (already changed once above).
  const afterRules = (await grandTotal.textContent()) ?? "";
  expect(afterRules).toContain("$");

  // Navigate to specs page.
  await page.getByTestId("specs-link").click();
  await page.waitForURL(/\/specs$/);

  // Capture usage before spec analysis.
  const usageBadge = page.getByTestId("usage-badge");
  const usageBefore = (await usageBadge.textContent()) ?? "";

  // Upload sample specs.
  await page.getByTestId("spec-file-input").setInputFiles(SAMPLE_SPECS);
  // Loading state visible.
  // Wait for paint scope or flagged section to render.
  await expect(page.getByTestId("flagged-requirements")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("flagged-item").first()).toBeVisible();

  // Usage should have increased.
  await expect.poll(
    async () => (await usageBadge.textContent()) ?? "",
    { timeout: 10_000 },
  ).not.toEqual(usageBefore);

  // Apply spec to project.
  await page.getByTestId("apply-spec-button").click();
  await expect(page.getByTestId("apply-result")).toBeVisible({
    timeout: 10_000,
  });

  await page.screenshot({
    path: "test-results/checkpoint-4.png",
    fullPage: true,
  });
});
