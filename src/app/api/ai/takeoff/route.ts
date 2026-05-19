import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "node:path";
import { z } from "zod";
import { db } from "@/lib/db";
import { MissingApiKeyError } from "@/lib/anthropic";
import { gateAiCall, trackApiUsage } from "@/lib/rate-limit";
import { getCached, hashBuffer, makeCacheKey, setCached } from "@/lib/cache";
import {
  DEFAULT_MODEL,
  MAX_TAKEOFF_RUNS_PER_PAGE_PER_DAY,
} from "@/lib/constants";
import {
  runTakeoff,
  type TakeoffProgressEvent,
  type TakeoffRunResult,
} from "@/lib/ai/takeoff-runner";
import {
  TAKEOFF_SYSTEM_PROMPT_CACHED,
  type TakeoffToolResult,
} from "@/lib/ai/takeoff-prompt";
import { CLASSIFIER_MODEL } from "@/lib/ai/page-classifier";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

const querySchema = z.object({ planPageId: z.string().min(1) });

/**
 * SSE stream of pipeline progress + the final surface list. The client
 * fetches this endpoint and reads `data: ...` events to drive the multi-
 * stage loading UI.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = querySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Missing the plan page to analyze." },
      { status: 400 },
    );
  }

  const planPage = await db.planPage.findUnique({
    where: { id: parsed.data.planPageId },
    include: { plan: { include: { project: true } } },
  });
  if (!planPage) {
    return NextResponse.json(
      { error: "We couldn't find that plan page. Try refreshing." },
      { status: 404 },
    );
  }

  let fullPdf: Buffer;
  try {
    fullPdf = await readFile(
      path.join(UPLOADS_DIR, planPage.plan.filePath),
    );
  } catch {
    return NextResponse.json(
      {
        error:
          "We couldn't read your blueprint file. Try re-uploading the PDF.",
      },
      { status: 500 },
    );
  }

  // Build the user-supplied scale (set via the scale banner) so the
  // engine can use the user's two-point calibration as the canonical
  // pt/ft for every measurement on this page.
  const userScale =
    planPage.scaleRatio != null && planPage.scaleLabel != null
      ? { ptPerFoot: planPage.scaleRatio, label: planPage.scaleLabel }
      : null;
  const ceilingHeightFt = planPage.plan.project.ceilingHeightFt;

  const cacheKey = makeCacheKey({
    // Bumped to v11 when the scale engine took over measurements — old
    // cached results would replay AI-estimated areas + a hardcoded
    // table-derived rectangle, both of which we no longer trust.
    // The user-set scale is part of the cache key so re-calibrating
    // produces a fresh extraction.
    endpoint: "takeoff-v11",
    model: DEFAULT_MODEL,
    prompt: TAKEOFF_SYSTEM_PROMPT_CACHED,
    inputHash:
      `${hashBuffer(fullPdf)}#${planPage.pageNumber}` +
      (userScale ? `#user:${userScale.ptPerFoot.toFixed(4)}` : "") +
      `#ceil:${ceilingHeightFt.toFixed(2)}`,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function send(event: TakeoffProgressEvent) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      }
      function done(payload: Record<string, unknown>) {
        controller.enqueue(
          encoder.encode(
            `event: complete\ndata: ${JSON.stringify(payload)}\n\n`,
          ),
        );
        controller.close();
      }
      function fail(msg: string, status = 500) {
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ error: msg, status })}\n\n`,
          ),
        );
        controller.close();
      }

      try {
        // Cache check first — never bill cached responses against limits.
        const cached = await getCached<{
          result: TakeoffToolResult;
          pageType: string;
        }>(cacheKey);
        if (cached) {
          send({ stage: "rendering" });
          send({ stage: "classifying" });
          send({ stage: "reading_plan", message: "Using cached AI results." });
          const created = await persistSurfaces(
            planPage.plan.projectId,
            planPage.id,
            cached.result,
          );
          done({
            cached: true,
            surfaceCount: created,
            pageType: cached.pageType,
          });
          return;
        }

        // Rate-limit gate (per-page, global per-min, daily budget).
        const gate = await gateAiCall({
          perCallerKey: `takeoff:${planPage.id}`,
          perCallerMax: MAX_TAKEOFF_RUNS_PER_PAGE_PER_DAY,
          perCallerWindowSeconds: 24 * 60 * 60,
        });
        if (!gate.allowed) {
          fail(gate.reason, gate.status);
          return;
        }

        let runResult: TakeoffRunResult;
        try {
          runResult = await runTakeoff(
            {
              pdfBuffer: fullPdf,
              pageNumber: planPage.pageNumber,
              userScale,
              ceilingHeightFt,
            },
            send,
          );
        } catch (err) {
          if (err instanceof MissingApiKeyError) {
            fail(err.message, 500);
            return;
          }
          fail(
            err instanceof Error
              ? err.message
              : "The AI couldn't analyze this page. Wait a moment and try again.",
            502,
          );
          return;
        }

        if (runResult.status === "skipped") {
          // Track classifier cost only.
          await trackApiUsage(
            "takeoff-classify",
            CLASSIFIER_MODEL,
            runResult.classification.inputTokens,
            runResult.classification.outputTokens,
          );
          done({
            skipped: true,
            pageType: runResult.classification.type,
            reason: runResult.reason,
          });
          return;
        }

        send({ stage: "persisting" });

        // Track both calls. Cache reads bill at 10% of input, so split it out.
        await trackApiUsage(
          "takeoff-classify",
          CLASSIFIER_MODEL,
          runResult.classification.inputTokens,
          runResult.classification.outputTokens,
        );
        await trackApiUsage(
          "takeoff",
          DEFAULT_MODEL,
          runResult.takeoffInputTokens,
          runResult.takeoffOutputTokens,
          {
            cacheReadInputTokens: runResult.takeoffCacheReadInputTokens,
            cacheCreationInputTokens:
              runResult.takeoffCacheCreationInputTokens,
          },
        );
        if (runResult.validatorInputTokens > 0) {
          await trackApiUsage(
            "takeoff-validate",
            CLASSIFIER_MODEL,
            runResult.validatorInputTokens,
            runResult.validatorOutputTokens,
            {
              cacheReadInputTokens: runResult.validatorCacheReadInputTokens,
              cacheCreationInputTokens:
                runResult.validatorCacheCreationInputTokens,
            },
          );
        }
        if (runResult.perRoomInputTokens > 0) {
          await trackApiUsage(
            "takeoff-perroom",
            DEFAULT_MODEL,
            runResult.perRoomInputTokens,
            runResult.perRoomOutputTokens,
            {
              cacheReadInputTokens: runResult.perRoomCacheReadInputTokens,
              cacheCreationInputTokens:
                runResult.perRoomCacheCreationInputTokens,
            },
          );
        }

        await setCached(cacheKey, "takeoff-v2", {
          result: runResult.result,
          pageType: runResult.classification.type,
        });

        const created = await persistSurfaces(
          planPage.plan.projectId,
          planPage.id,
          runResult.result,
        );

        // Persist the established scale unless the user has already set
        // one — `userScale != null` means PlanPage.scaleRatio came from
        // the user's two-point calibration and is authoritative.
        const established = runResult.establishedScale;
        const scaleUpdate =
          userScale == null && established != null
            ? {
                scaleRatio: established.ptPerFoot,
                scaleMethod: established.method,
                scaleLabel: established.label,
              }
            : {};
        await db.planPage.update({
          where: { id: planPage.id },
          data: { aiProcessed: true, ...scaleUpdate },
        });

        done({
          cached: false,
          surfaceCount: created,
          pageType: runResult.classification.type,
          scale: established
            ? {
                ptPerFoot: established.ptPerFoot,
                method: established.method,
                label: established.label,
                confidence: established.confidence,
                note: established.note,
              }
            : null,
          warnings: runResult.result.warnings,
        });
      } catch (err) {
        fail(
          err instanceof Error
            ? err.message
            : "Something went wrong analyzing the page.",
          500,
        );
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

async function persistSurfaces(
  projectId: string,
  planPageId: string,
  result: TakeoffToolResult,
): Promise<number> {
  // Replace prior proposed AI surfaces on this page only.
  await db.surface.deleteMany({
    where: { planPageId, status: "proposed", source: "ai" },
  });

  let count = 0;
  // Walls
  for (const w of result.walls ?? []) {
    if (!w.polygon) continue; // empty array still persists — surface shows in queue without a canvas marker
    await db.surface.create({
      data: {
        projectId,
        planPageId,
        type: "wall",
        roomLabel: w.room_label,
        substrate: w.substrate,
        polygon: JSON.stringify(w.polygon),
        squareFootage: w.area_sqft ?? null,
        linearFootage: w.linear_ft ?? null,
        count: null,
        confidence: w.confidence,
        status: "proposed",
        source: "ai",
        derivation: w.derivation ?? "ai-fallback",
        coats: 2,
      },
    });
    count++;
  }
  // Ceilings
  for (const c of result.ceilings ?? []) {
    if (!c.polygon) continue; // empty array still persists — surface shows in queue without a canvas marker
    await db.surface.create({
      data: {
        projectId,
        planPageId,
        type: "ceiling",
        roomLabel: c.room_label,
        substrate: c.substrate,
        polygon: JSON.stringify(c.polygon),
        squareFootage: c.area_sqft ?? null,
        linearFootage: null,
        count: null,
        confidence: c.confidence,
        status: "proposed",
        source: "ai",
        derivation: c.derivation ?? "ai-fallback",
        coats: 2,
      },
    });
    count++;
  }
  // Trim
  for (const t of result.trim ?? []) {
    if (!t.polygon) continue; // empty array still persists — surface shows in queue without a canvas marker
    await db.surface.create({
      data: {
        projectId,
        planPageId,
        type: "trim",
        roomLabel: t.room_label,
        substrate: t.substrate,
        polygon: JSON.stringify(t.polygon),
        squareFootage: null,
        linearFootage: t.linear_ft ?? null,
        count: null,
        confidence: t.confidence,
        status: "proposed",
        source: "ai",
        derivation: t.derivation ?? "ai-fallback",
        coats: 2,
      },
    });
    count++;
  }
  // Doors
  for (const d of result.doors ?? []) {
    if (!d.polygon) continue; // empty array still persists — surface shows in queue without a canvas marker
    await db.surface.create({
      data: {
        projectId,
        planPageId,
        type: "door",
        roomLabel: d.room_label,
        substrate: d.substrate,
        polygon: JSON.stringify(d.polygon),
        squareFootage: null,
        linearFootage: null,
        count: d.count,
        confidence: d.confidence,
        status: "proposed",
        source: "ai",
        derivation: d.derivation ?? "ai-fallback",
        coats: 2,
      },
    });
    count++;
  }
  // Windows
  for (const w of result.windows ?? []) {
    if (!w.polygon) continue; // empty array still persists — surface shows in queue without a canvas marker
    await db.surface.create({
      data: {
        projectId,
        planPageId,
        type: "window",
        roomLabel: w.room_label,
        substrate: w.substrate,
        polygon: JSON.stringify(w.polygon),
        squareFootage: null,
        linearFootage: null,
        count: w.count,
        confidence: w.confidence,
        status: "proposed",
        source: "ai",
        derivation: w.derivation ?? "ai-fallback",
        coats: 2,
      },
    });
    count++;
  }
  return count;
}
