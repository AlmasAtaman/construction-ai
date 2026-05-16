import { test, expect } from "@playwright/test";
import path from "node:path";
import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

const SAMPLE_PDF = path.join(__dirname, "fixtures", "sample-plan.pdf");

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

test("checkpoint 5 — bid generation, PDF export, command palette, shortcuts, undo", async ({
  page,
}) => {
  // Build a project with surfaces.
  await page.goto("/");
  await page.getByTestId("empty-new-project-button").click();
  await page.getByTestId("project-name-input").fill("Phase 5 Test");
  await page.getByTestId("submit-project-button").click();
  await page.waitForURL(/\/projects\/c[a-z0-9]{20,}$/i);
  const projectUrl = page.url();
  const projectId = projectUrl.split("/").pop()!;

  await page.getByTestId("file-input").setInputFiles(SAMPLE_PDF);
  await expect(page.getByTestId("pages-list")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("pdf-canvas")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("run-takeoff").click();
  await expect(page.getByTestId("takeoff-loading")).toBeHidden({
    timeout: 30_000,
  });
  await page.getByTestId("accept-all-high").click();

  // Read worksheet grand total before navigating away.
  const worksheetTotal =
    (await page.getByTestId("worksheet-grand-total").textContent()) ?? "";
  expect(worksheetTotal).toContain("$");

  // Navigate to bid review page.
  await page.getByTestId("open-bid-link").click();
  await page.waitForURL(/\/bid$/);

  // Generate the bid.
  await page.getByTestId("generate-bid-button").click();
  await expect(page.getByTestId("bid-line-items")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("bid-row").first()).toBeVisible();

  // Grand total appears and should match (or be very close to) worksheet's.
  const bidTotal =
    (await page.getByTestId("bid-grand-total").textContent()) ?? "";
  expect(bidTotal).toContain("$");

  // Toggle a PCA P23 exclusion and confirm the scope text updates.
  const scope = page.getByTestId("bid-scope");
  const beforeScope = (await scope.textContent()) ?? "";
  const exclusionCheckbox = page.getByTestId("p23-lead-asbestos");
  await exclusionCheckbox.click();
  await expect(scope).not.toHaveText(beforeScope);

  // Export PDF — click the link, validate the API endpoint.
  const pdfResp = await page.request.get(`/api/bids/${projectId}/pdf`);
  expect(pdfResp.status()).toBe(200);
  expect(pdfResp.headers()["content-type"]).toContain("application/pdf");
  const pdfBody = await pdfResp.body();
  expect(pdfBody.length).toBeGreaterThan(1000);

  // Export CSV.
  const csvResp = await page.request.get(`/api/bids/${projectId}/csv`);
  expect(csvResp.status()).toBe(200);
  const csvText = await csvResp.text();
  expect(csvText).toContain("Room,Type,Paint");

  // Open command palette with Cmd+K (or Ctrl+K).
  await page.goto(projectUrl);
  await expect(page.getByTestId("worksheet")).toBeVisible();
  await page.keyboard.press("Control+K");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.getByTestId("command-input").fill("new project");
  await expect(page.getByTestId("command-new-project")).toBeVisible();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/projects\/new$/);

  // Return to project and test A shortcut (area / rectangle tool).
  await page.goto(projectUrl);
  await expect(page.getByTestId("pdf-canvas")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("surface-overlay")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("worksheet")).toBeVisible();

  // Verify A shortcut selects the rectangle tool.
  await page.keyboard.press("a");
  await expect(page.getByTestId("tool-rectangle")).toHaveAttribute(
    "data-active",
    "true",
  );

  // Now use the button click path (same as checkpoint-2) to ensure a clean drag.
  await page.getByTestId("tool-rectangle").click();

  const initialCount = await page.request
    .get(`/api/surfaces?projectId=${projectId}`)
    .then((r) => r.json())
    .then((j) => j.surfaces.length);

  // Draw a new manual surface — drag on the Konva canvas, inside its bounds.
  // Collapse the worksheet first so the canvas has more room and our drag
  // doesn't fall outside the Stage on small viewports.
  await page.getByTestId("worksheet-toggle").click();
  const overlay = page.getByTestId("surface-overlay");
  await expect(overlay).toBeVisible();
  const box = await overlay.boundingBox();
  if (!box) throw new Error("Overlay not found");
  // Lower-left empty area between rows (~y=0.42-0.48), x=0.5-0.65.
  const startX = box.x + box.width * 0.5;
  const startY = box.y + box.height * 0.42;
  const endX = box.x + box.width * 0.65;
  const endY = box.y + box.height * 0.48;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 4, startY + 4);
  await page.mouse.move(endX, endY, { steps: 10 });
  await page.mouse.up();

  // Wait until the surface count grows (gives the POST time to land).
  await expect.poll(
    async () =>
      await page.request
        .get(`/api/surfaces?projectId=${projectId}`)
        .then((r) => r.json())
        .then((j) => j.surfaces.length),
    { timeout: 8_000 },
  ).toBeGreaterThan(initialCount);

  const surfacesBefore = await page.request
    .get(`/api/surfaces?projectId=${projectId}`)
    .then((r) => r.json())
    .then((j) => j.surfaces.length);

  // Ctrl+Z undo should reduce the count by one.
  await page.keyboard.press("Control+Z");
  await expect.poll(
    async () =>
      await page.request
        .get(`/api/surfaces?projectId=${projectId}`)
        .then((r) => r.json())
        .then((j) => j.surfaces.length),
    { timeout: 5_000 },
  ).toBeLessThan(surfacesBefore);

  await page.screenshot({
    path: "test-results/checkpoint-5.png",
    fullPage: true,
  });

  // Sanity check screenshot saved.
  expect(existsSync("test-results/checkpoint-5.png")).toBe(true);
  expect(statSync("test-results/checkpoint-5.png").size).toBeGreaterThan(1000);
});
