import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { db } from "@/lib/db";
import { ptPerFootFromTwoPoints } from "@/lib/extract/scale";
import { detectPageScale } from "@/lib/extract/page-extract";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

/**
 * Below these confidences we don't auto-persist a detected scale — the
 * user is shown nothing and asked to calibrate, rather than silently
 * measuring against a guess. (Wrong scale = wrong bid = lost money.)
 *
 * A printed "SCALE: 1/4\" = 1'-0\"" notation is the architect's own
 * declaration and is authoritative on a vector PDF — so we trust it at a
 * lower bar. The door cross-check (which assumes ~3 ft doors) routinely
 * misfires on commercial sheets full of 2'-0"/2'-6" openings and only
 * knocks a clean ~0.92 parse down to ~0.52; we still keep that. A
 * scale-bar (geometry-only) needs the higher bar.
 */
const MIN_CONFIDENCE_TEXT = 0.45;
const MIN_CONFIDENCE_OTHER = 0.6;

async function pageDimensionsPt(
  planPageId: string,
): Promise<{ widthPt: number; heightPt: number } | null> {
  const page = await db.planPage.findUnique({
    where: { id: planPageId },
    include: { plan: true },
  });
  if (!page) return null;
  try {
    const buf = await readFile(path.join(UPLOADS_DIR, page.plan.filePath));
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise;
    const pdfPage = await doc.getPage(page.pageNumber);
    const viewport = pdfPage.getViewport({ scale: 1 });
    return { widthPt: viewport.width, heightPt: viewport.height };
  } catch {
    return null;
  }
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET the current scale for a plan page. Used by the banner on page
 * load so the user can see what scale is in effect even when the AI
 * takeoff hasn't been rerun yet.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const page = await db.planPage.findUnique({
    where: { id },
    include: { plan: true },
  });
  if (!page) {
    return NextResponse.json({ error: "Page not found." }, { status: 404 });
  }
  const dims = await pageDimensionsPt(page.id);

  let scale =
    page.scaleRatio != null
      ? {
          ptPerFoot: page.scaleRatio,
          method: page.scaleMethod ?? "user",
          label: page.scaleLabel ?? "Set by you",
        }
      : null;

  // A one-time, non-blocking heads-up returned only on the detection turn
  // (once persisted, GET short-circuits above and never re-runs detection).
  let warning: string | null = null;

  // No stored scale → try to read it straight off the sheet (the
  // architect's printed "SCALE: 1/4\" = 1'-0\"" notation or a scale bar).
  // Persist confident hits so measurements use them and the banner shows
  // the source; leave a low-confidence guess unset so the user calibrates.
  if (scale == null) {
    try {
      const buf = await readFile(path.join(UPLOADS_DIR, page.plan.filePath));
      const detected = await detectPageScale(buf, page.pageNumber);
      const minConf =
        detected?.method === "text-notation"
          ? MIN_CONFIDENCE_TEXT
          : MIN_CONFIDENCE_OTHER;
      if (detected && detected.confidence >= minConf) {
        await db.planPage.update({
          where: { id },
          data: {
            scaleRatio: detected.ptPerFoot,
            scaleMethod: detected.method,
            scaleLabel: detected.label,
          },
        });
        scale = {
          ptPerFoot: detected.ptPerFoot,
          method: detected.method,
          label: detected.label,
        };
        // Trusted the printed scale but a cross-check was uneasy — tell the
        // user so they can eyeball one measurement before bidding.
        if (detected.confidence < MIN_CONFIDENCE_OTHER) {
          warning =
            "Auto-read from the sheet, but a cross-check was inconclusive. Double-check one known dimension; click Edit to recalibrate if it's off.";
        }
      }
    } catch {
      /* detection failed — fall through with scale = null */
    }
  }

  return NextResponse.json({
    planPageId: page.id,
    pageNumber: page.pageNumber,
    scale,
    warning,
    pageWidthPt: dims?.widthPt ?? null,
    pageHeightPt: dims?.heightPt ?? null,
  });
}

/**
 * Two body shapes are accepted, validated by Zod:
 *
 *   1. Direct  — { ptPerFoot, label? }
 *   2. Two-point — { p1, p2, realFeet, pageWidthPt, pageHeightPt }
 *
 *   3. Clear   — { clear: true } removes any user-set scale so the
 *                engine's auto-detection takes over on the next run.
 *
 * On success the page's `scaleRatio`, `scaleMethod`, and `scaleLabel`
 * are written and the new values are returned. Surfaces are NOT
 * mutated — the user re-runs "Measure my plan" to refresh measurements
 * with the new scale.
 */
const directSchema = z.object({
  ptPerFoot: z.number().positive(),
  label: z.string().optional(),
});

const twoPointSchema = z.object({
  p1: z.object({ x: z.number(), y: z.number() }),
  p2: z.object({ x: z.number(), y: z.number() }),
  realFeet: z.number().positive(),
  pageWidthPt: z.number().positive(),
  pageHeightPt: z.number().positive(),
});

const clearSchema = z.object({ clear: z.literal(true) });

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const page = await db.planPage.findUnique({ where: { id }, select: { id: true } });
  if (!page) {
    return NextResponse.json({ error: "Page not found." }, { status: 404 });
  }

  // Try each shape in turn — the first one that validates wins.
  const clear = clearSchema.safeParse(body);
  if (clear.success) {
    const updated = await db.planPage.update({
      where: { id },
      data: { scaleRatio: null, scaleMethod: null, scaleLabel: null },
      select: { scaleRatio: true, scaleMethod: true, scaleLabel: true },
    });
    return NextResponse.json({ scale: null, page: updated });
  }

  const direct = directSchema.safeParse(body);
  if (direct.success) {
    const label = direct.data.label?.trim() || "Set by you";
    const updated = await db.planPage.update({
      where: { id },
      data: {
        scaleRatio: direct.data.ptPerFoot,
        scaleMethod: "user",
        scaleLabel: label,
      },
      select: { scaleRatio: true, scaleMethod: true, scaleLabel: true },
    });
    return NextResponse.json({
      scale: {
        ptPerFoot: updated.scaleRatio!,
        method: "user",
        label,
      },
    });
  }

  const tp = twoPointSchema.safeParse(body);
  if (tp.success) {
    const result = ptPerFootFromTwoPoints({
      p1Norm: tp.data.p1,
      p2Norm: tp.data.p2,
      pageWidthPt: tp.data.pageWidthPt,
      pageHeightPt: tp.data.pageHeightPt,
      realFeet: tp.data.realFeet,
    });
    if (!result) {
      return NextResponse.json(
        {
          error:
            "Those two points are too close together to measure reliably. Try clicking on a longer printed dimension and entering its value.",
        },
        { status: 400 },
      );
    }
    const label = `${tp.data.realFeet} ft = ${result.pixelDistancePt.toFixed(1)} pt (set by you)`;
    const updated = await db.planPage.update({
      where: { id },
      data: {
        scaleRatio: result.ptPerFoot,
        scaleMethod: "user",
        scaleLabel: label,
      },
      select: { scaleRatio: true, scaleMethod: true, scaleLabel: true },
    });
    return NextResponse.json({
      scale: {
        ptPerFoot: updated.scaleRatio!,
        method: "user",
        label,
      },
    });
  }

  return NextResponse.json(
    {
      error:
        "Send either { ptPerFoot } (direct), { p1, p2, realFeet, pageWidthPt, pageHeightPt } (two-point), or { clear: true }.",
    },
    { status: 400 },
  );
}
