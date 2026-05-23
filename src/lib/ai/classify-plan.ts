import { pdf } from "pdf-to-img";
import sharp from "sharp";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { db } from "@/lib/db";
import { classifyPage, type PageType } from "./page-classifier";
import { hasApiKey } from "@/lib/anthropic";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

export interface PageClassification {
  pageId: string;
  pageNumber: number;
  pageType: PageType;
}

/**
 * Classify every page of a plan as floor_plan / schedule / detail / etc. and
 * persist the type on PlanPage.pageType. Lets the UI surface floor plans and
 * collapse the dozens of schedule/detail/note sheets that otherwise crowd a
 * commercial drawing set.
 *
 * Cheap (Haiku, one small image per page) and resumable — only unclassified
 * pages are processed unless `force` is set. If no API key is configured the
 * pages are left unclassified and the UI falls back to showing them all.
 */
export async function classifyPlanPages(
  planId: string,
  opts: { force?: boolean } = {},
): Promise<PageClassification[]> {
  const plan = await db.plan.findUnique({
    where: { id: planId },
    include: { pages: { orderBy: { pageNumber: "asc" } } },
  });
  if (!plan) throw new Error("Plan not found");

  // Already-classified pages we can return as-is.
  const existing: PageClassification[] = plan.pages
    .filter((p): p is typeof p & { pageType: string } => p.pageType != null)
    .map((p) => ({
      pageId: p.id,
      pageNumber: p.pageNumber,
      pageType: p.pageType as PageType,
    }));

  if (!hasApiKey()) return existing;

  const todo = plan.pages.filter((p) => opts.force || p.pageType == null);
  if (todo.length === 0) return existing;
  const todoNumbers = new Set(todo.map((p) => p.pageNumber));
  const pageById = new Map(plan.pages.map((p) => [p.pageNumber, p]));

  const buffer = await readFile(path.join(UPLOADS_DIR, plan.filePath));
  const results: PageClassification[] = opts.force ? [] : [...existing];

  // Open the PDF once and iterate; rendering per-page would be O(N^2).
  const doc = await pdf(buffer, { scale: 1.5 });
  let n = 0;
  for await (const pageImage of doc) {
    n += 1;
    if (!todoNumbers.has(n)) continue;
    const page = pageById.get(n);
    if (!page) continue;
    try {
      const jpeg = await sharp(pageImage)
        .resize({ width: 1100, height: 1100, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      const { type } = await classifyPage({
        imageBase64: jpeg.toString("base64"),
        imageMediaType: "image/jpeg",
      });
      await db.planPage.update({
        where: { id: page.id },
        data: { pageType: type },
      });
      results.push({ pageId: page.id, pageNumber: n, pageType: type });
    } catch {
      // Leave this page unclassified; UI still shows it under "Other".
    }
  }
  return results;
}
