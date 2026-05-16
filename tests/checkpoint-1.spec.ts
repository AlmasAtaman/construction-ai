import { test, expect } from "@playwright/test";
import path from "node:path";
import { execSync } from "node:child_process";

const SAMPLE_PDF = path.join(__dirname, "fixtures", "sample-plan.pdf");

// Reset the local DB between checkpoint runs so the empty-state assertions
// are deterministic. We do this via prisma db push --force-reset.
test.beforeAll(() => {
  try {
    execSync("npx prisma db push --force-reset --skip-generate", {
      cwd: path.join(__dirname, ".."),
      stdio: "ignore",
    });
  } catch {
    // If reset fails the test will fail loudly later; do not swallow silently.
  }
});

test("checkpoint 1 — empty dashboard, create project, upload PDF, render", async ({
  page,
}) => {
  await page.goto("/");

  // Empty state visible with clear call to action.
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /no projects yet/i }),
  ).toBeVisible();
  const emptyCta = page.getByTestId("empty-new-project-button");
  await expect(emptyCta).toBeVisible();
  await expect(emptyCta).toContainText(/create your first project/i);

  // UsageBadge visible showing $0.00 / $20
  const usageBadge = page.getByTestId("usage-badge");
  await expect(usageBadge).toBeVisible();
  await expect(usageBadge).toContainText("$0.00");
  await expect(usageBadge).toContainText("$20");

  // Click "New Project".
  await page.getByTestId("new-project-button").click();
  await expect(page).toHaveURL(/\/projects\/new$/);

  // Form has clear labels and a visible primary button.
  await expect(page.getByText("Project name", { exact: false })).toBeVisible();
  const submit = page.getByTestId("submit-project-button");
  await expect(submit).toBeVisible();
  await expect(submit).toContainText(/create project/i);

  // Fill in the project name and submit.
  await page.getByTestId("project-name-input").fill("Test Hospital Bid");
  await submit.click();

  // Redirected to project workspace.
  await page.waitForURL(/\/projects\/c[a-z0-9]{20,}$/i, { timeout: 15_000 });

  // Four-panel layout visible with placeholder content.
  await expect(page.getByTestId("left-sidebar")).toBeVisible();
  await expect(page.getByTestId("center-canvas")).toBeVisible();
  await expect(page.getByTestId("right-sidebar")).toBeVisible();
  await expect(page.getByTestId("bottom-panel")).toBeVisible();

  await expect(page.getByTestId("pages-placeholder")).toContainText(
    /pages appear here/i,
  );
  await expect(page.getByTestId("queue-placeholder")).toContainText(
    /no pending surfaces/i,
  );

  // Usage badge still visible in top bar.
  await expect(page.getByTestId("usage-badge")).toBeVisible();
  await expect(page.getByTestId("usage-badge")).toContainText("$0.00");

  // Upload the sample PDF.
  await page.getByTestId("file-input").setInputFiles(SAMPLE_PDF);

  // Wait until either progress bar appears or upload completes and pages list shows.
  await expect(page.getByTestId("pages-list")).toBeVisible({ timeout: 30_000 });

  // PDF rendered.
  await expect(page.getByTestId("pdf-viewer")).toBeVisible();
  // Wait for canvas (may show loading state first).
  const canvas = page.getByTestId("pdf-canvas");
  await expect(canvas).toBeVisible({ timeout: 30_000 });

  // Page navigation visible.
  await expect(page.getByTestId("page-button-1")).toBeVisible();

  // Screenshot for manual review.
  await page.screenshot({
    path: "test-results/checkpoint-1.png",
    fullPage: true,
  });
});
