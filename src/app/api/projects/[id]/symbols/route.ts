import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { db } from "@/lib/db";
import { countSymbolsOnPage } from "@/lib/ai/symbol-counter";
import { MissingApiKeyError } from "@/lib/anthropic";

export const dynamic = "force-dynamic";

/** GET — return previously counted symbols for the project. */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const surfaces = await db.surface.findMany({
    where: { projectId: id, type: { startsWith: "symbol:" } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({
    symbols: surfaces.map((s) => ({
      id: s.id,
      type: s.type.replace(/^symbol:/, ""),
      roomLabel: s.roomLabel,
      count: s.count ?? 0,
      confidence: s.confidence,
      notes: s.notes,
      source: s.source,
      planPageId: s.planPageId,
    })),
  });
}

/**
 * POST — scan the project's plan pages and persist symbol counts.
 * Each unique (page, symbolType, roomLabel) tuple becomes one Surface
 * record with type = "symbol:<symbolType>".
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const project = await db.project.findUnique({
    where: { id },
    include: { plans: { include: { pages: true } } },
  });
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  const pages = project.plans.flatMap((p) =>
    p.pages.map((pg) => ({ ...pg, planFilePath: p.filePath })),
  );
  if (pages.length === 0) {
    return NextResponse.json(
      { error: "Upload a plan before running symbol detection." },
      { status: 400 },
    );
  }

  // Existing room labels (for per-room breakdown context).
  const surfaces = await db.surface.findMany({
    where: { projectId: id, type: { in: ["wall", "ceiling"] } },
    select: { roomLabel: true },
  });
  const roomLabels = [
    ...new Set(
      surfaces.map((s) => s.roomLabel ?? "").filter((l) => l.length > 0),
    ),
  ];

  // For each page, count symbols. Persist as type="symbol:<type>".
  const results: Array<{
    pageId: string;
    pageNumber: number;
    symbolsCounted: number;
    inputTokens: number;
    outputTokens: number;
  }> = [];
  let totalInput = 0;
  let totalOutput = 0;

  // Cache: PDF path → loaded mupdf doc. Pages from the same Plan reuse.
  const mupdf = await import("mupdf");
  const docCache = new Map<string, ReturnType<typeof mupdf.Document.openDocument>>();
  function getDoc(filePath: string): ReturnType<typeof mupdf.Document.openDocument> {
    let doc = docCache.get(filePath);
    if (!doc) {
      const buf = readFileSync(filePath);
      doc = mupdf.Document.openDocument(new Uint8Array(buf), "application/pdf");
      docCache.set(filePath, doc);
    }
    return doc;
  }

  try {
    for (const page of pages) {
      // Always render from the source PDF — imagePath is optional.
      let imgBuf: Buffer;
      if (page.imagePath) {
        imgBuf = readFileSync(
          path.resolve(process.cwd(), "public", page.imagePath.replace(/^\//, "")),
        );
      } else {
        // Render from PDF.
        const planFilePath = path.join(
          process.cwd(),
          "uploads",
          page.planFilePath,
        );
        const doc = getDoc(planFilePath);
        const mupdfPage = doc.loadPage(page.pageNumber - 1);
        const matrix = mupdf.Matrix.scale(150 / 72, 150 / 72);
        const pixmap = mupdfPage.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB);
        imgBuf = Buffer.from(pixmap.asPNG());
      }
      // Resize for vision tokens.
      const small = await sharp(imgBuf)
        .resize({
          width: 1568,
          height: 1568,
          fit: "inside",
          withoutEnlargement: true,
        })
        .png()
        .toBuffer();

      const result = await countSymbolsOnPage({
        pageImageBase64: small.toString("base64"),
        pageImageMediaType: "image/png",
        roomLabels,
      });
      totalInput += result.inputTokens;
      totalOutput += result.outputTokens;

      let countedThisPage = 0;
      for (const sym of result.symbols) {
        const placeholderPoly = JSON.stringify([
          { x: 0.45, y: 0.45 },
          { x: 0.55, y: 0.45 },
          { x: 0.55, y: 0.55 },
          { x: 0.45, y: 0.55 },
        ]);
        if (sym.byRoom && sym.byRoom.length > 0) {
          for (const r of sym.byRoom) {
            await db.surface.create({
              data: {
                projectId: id,
                planPageId: page.id,
                type: `symbol:${sym.type}`,
                roomLabel: r.roomLabel,
                polygon: placeholderPoly,
                count: r.count,
                confidence: sym.confidence,
                source: "AI",
                notes: sym.notes,
              },
            });
            countedThisPage++;
          }
        } else {
          // No per-room breakdown — single row for the page total.
          await db.surface.create({
            data: {
              projectId: id,
              planPageId: page.id,
              type: `symbol:${sym.type}`,
              roomLabel: null,
              polygon: placeholderPoly,
              count: sym.count,
              confidence: sym.confidence,
              source: "AI",
              notes: sym.notes,
            },
          });
          countedThisPage++;
        }
      }
      results.push({
        pageId: page.id,
        pageNumber: page.pageNumber,
        symbolsCounted: countedThisPage,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });
    }
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return NextResponse.json(
        { error: "Add your Anthropic API key in .env.local first." },
        { status: 401 },
      );
    }
    return NextResponse.json(
      { error: (err as Error).message ?? "Symbol detection failed." },
      { status: 500 },
    );
  }

  // Estimated cost — Sonnet 4.5 pricing.
  const costUsd =
    (totalInput / 1_000_000) * 3 + (totalOutput / 1_000_000) * 15;

  return NextResponse.json({
    pages: results,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    estimatedCostUsd: costUsd,
  });
}
