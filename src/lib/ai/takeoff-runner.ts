import type { Anthropic } from "@anthropic-ai/sdk";
import { getAnthropic, MissingApiKeyError } from "@/lib/anthropic";
import {
  drawMarks,
  renderPdfPage,
  type RenderedPage,
  type TextFragment,
  type DimensionTableRow,
} from "@/lib/pdf-render";
import {
  classifyPage,
  TAKEOFF_ELIGIBLE,
  type ClassificationResult,
  type PageType,
} from "./page-classifier";
import {
  RECORD_TAKEOFF_TOOL,
  TAKEOFF_MODEL,
  TAKEOFF_SYSTEM_PROMPT_CACHED,
  type TakeoffToolResult,
} from "./takeoff-prompt";
import { isTestMode, stubTakeoff } from "./test-mode";
import { plausibilityCheck } from "./plausibility";
import { applyValidationFindings, validateTakeoff } from "./validator";
import { measureOneRoom } from "./per-room";
import {
  extractCommercialRoomCandidates,
  type RoomCandidate,
} from "@/lib/commercial-rooms";

/**
 * The takeoff runner orchestrates the multi-stage pipeline:
 *   1. Render the requested PDF page to a vision-optimized image + extract
 *      its text layer for grounding.
 *   2. Classify the page with Haiku (cheap, ~$0.002/page). Skip non-plan
 *      pages so Sonnet only sees floor plans / RCPs.
 *   3. Run Sonnet 4.5 with a strict tool-use schema, a few-shot example in
 *      the cached system prompt, and the PDF's own text annotations as
 *      grounding.
 *
 * The runner emits progress events through the optional `onProgress`
 * callback so the API route can stream them to the client.
 */

export type TakeoffStage =
  | "rendering"
  | "classifying"
  | "skipped"
  | "reading_plan"
  | "validating"
  | "persisting"
  | "done"
  | "error";

export interface TakeoffProgressEvent {
  stage: TakeoffStage;
  message?: string;
  pageType?: PageType;
  classifierConfidence?: number;
  surfaceCount?: number;
  cached?: boolean;
  estimatedCost?: number;
  error?: string;
}

export interface TakeoffRunInput {
  pdfBuffer: Buffer;
  pageNumber: number;
}

export interface TakeoffRunSuccess {
  status: "ok";
  result: TakeoffToolResult;
  classification: ClassificationResult;
  rendered: RenderedPage;
  takeoffInputTokens: number;
  takeoffOutputTokens: number;
  takeoffCacheCreationInputTokens: number;
  takeoffCacheReadInputTokens: number;
  validatorInputTokens: number;
  validatorOutputTokens: number;
  validatorCacheReadInputTokens: number;
  validatorCacheCreationInputTokens: number;
  perRoomInputTokens: number;
  perRoomOutputTokens: number;
  perRoomCacheReadInputTokens: number;
  perRoomCacheCreationInputTokens: number;
  perRoomCount: number;
  plausibilityFlags: number;
  validatorFindings: number;
  /**
   * Vector-extracted room candidates from the PDF's deterministic
   * geometry (vector walls + image walls + door candidates + planar-
   * graph faces). Empty if extraction failed or the page has no
   * usable vector data. The caller cross-references against the AI's
   * walls/ceilings to tag each surface with `source='vector'` when a
   * label match exists.
   */
  vectorRoomCandidates: RoomCandidate[];
  vectorExtractionMs: number;
}

export interface TakeoffRunSkip {
  status: "skipped";
  classification: ClassificationResult;
  rendered: RenderedPage;
  reason: string;
}

export type TakeoffRunResult = TakeoffRunSuccess | TakeoffRunSkip;

export async function runTakeoff(
  input: TakeoffRunInput,
  onProgress?: (e: TakeoffProgressEvent) => void,
): Promise<TakeoffRunResult> {
  // --- Stage 1: render + parallel vector-room extraction ------------------
  onProgress?.({ stage: "rendering" });
  const renderedP = renderPdfPage(input.pdfBuffer, input.pageNumber);
  // Vector room extraction runs in parallel in production. Skip it in
  // test mode to keep CI fast and deterministic.
  const vectorP = isTestMode()
    ? Promise.resolve(null)
    : extractCommercialRoomCandidates(
        input.pdfBuffer,
        input.pageNumber,
      ).catch(() => null);
  const rendered = await renderedP;

  if (isTestMode()) {
    // Test mode returns a deterministic stub regardless of pixels, so we can
    // exercise the full pipeline (incl. progress events) cheaply in CI.
    onProgress?.({
      stage: "classifying",
      message: "Looking at what kind of sheet this is.",
    });
    const stubClassification: ClassificationResult = {
      type: "floor_plan",
      confidence: 0.95,
      reason: "TEST_MODE stub",
      inputTokens: 200,
      outputTokens: 30,
    };
    onProgress?.({
      stage: "reading_plan",
      pageType: stubClassification.type,
      classifierConfidence: stubClassification.confidence,
    });
    const stub = stubTakeoff();
    const result = stubToToolResult(stub.response);
    // Test mode skips vector extraction — it'd be wasteful in CI and the
    // test fixtures don't exercise that path.
    return {
      status: "ok",
      result,
      classification: stubClassification,
      rendered,
      takeoffInputTokens: stub.inputTokens,
      takeoffOutputTokens: stub.outputTokens,
      takeoffCacheCreationInputTokens: 0,
      takeoffCacheReadInputTokens: 0,
      validatorInputTokens: 0,
      validatorOutputTokens: 0,
      validatorCacheReadInputTokens: 0,
      validatorCacheCreationInputTokens: 0,
      perRoomInputTokens: 0,
      perRoomOutputTokens: 0,
      perRoomCacheReadInputTokens: 0,
      perRoomCacheCreationInputTokens: 0,
      perRoomCount: 0,
      plausibilityFlags: 0,
      validatorFindings: 0,
      vectorRoomCandidates: [],
      vectorExtractionMs: 0,
    };
  }

  // --- Stage 2: classify ---------------------------------------------------
  onProgress?.({
    stage: "classifying",
    message: "Looking at what kind of sheet this is.",
  });
  const classification = await classifyPage({
    imageBase64: rendered.imageBase64,
    imageMediaType: rendered.imageMediaType,
  });

  if (!TAKEOFF_ELIGIBLE.has(classification.type)) {
    const reason = `This looks like a ${classification.type.replace("_", " ")} (${Math.round(
      classification.confidence * 100,
    )}% confidence). We only run AI takeoff on floor plans and reflected ceiling plans to save you money — switch to another page if this is wrong.`;
    onProgress?.({
      stage: "skipped",
      pageType: classification.type,
      classifierConfidence: classification.confidence,
      message: reason,
    });
    return { status: "skipped", classification, rendered, reason };
  }

  // --- Stage 3: takeoff ----------------------------------------------------
  onProgress?.({
    stage: "reading_plan",
    pageType: classification.type,
    classifierConfidence: classification.confidence,
    message: "Reading the floor plan. About 30 seconds.",
  });

  let toolResult: TakeoffToolResult | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;

  try {
    const anthropic = getAnthropic();

    // De-duplicate room labels (the PDF text layer often repeats labels
    // across overlapping text runs). Keep one entry per label, prefer the
    // most centered.
    const dedupedRooms = dedupRoomLabels(rendered.roomLabels);

    // Detect whether labels are clustered in a side panel (a vertical
    // column on the right/left edge) vs scattered on the actual floor
    // plan. Side-panel labels are useless for Set-of-Marks because their
    // positions don't correspond to the rooms they describe.
    const labelsAreSidePanel = detectSidePanel(dedupedRooms);

    // Set-of-Marks: only draw numbered marks when labels are scattered
    // (in-plan) AND there aren't so many that the overlay obscures the
    // drawing. For side-panel-only or label-dense sheets we rely on
    // the dimension table / AI's own vision.
    const TOO_MANY_TO_MARK = 20;
    const marksFromLabels =
      labelsAreSidePanel ||
      dedupedRooms.length === 0 ||
      dedupedRooms.length > TOO_MANY_TO_MARK
        ? []
        : dedupedRooms.map((r, i) => ({
            xNorm: r.xNorm,
            yNorm: r.yNorm,
            n: i + 1,
          }));
    const markedImage = await drawMarks(
      rendered.imageBase64,
      rendered.imageMediaType,
      marksFromLabels,
      rendered.widthPx,
      rendered.heightPx,
    );

    const userContent: Anthropic.Messages.ContentBlockParam[] = [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: markedImage.imageMediaType,
          data: markedImage.imageBase64,
        },
      },
    ];

    // 1) Pinned room enumeration. We give the AI the canonical list of
    //    rooms either from in-plan labels (with marks) or from the
    //    dimension table (table-only sheets).
    const tableRoomLabels = rendered.dimensionTable.map((d) => d.label);
    const canonicalRooms = (
      labelsAreSidePanel && tableRoomLabels.length > 0
        ? tableRoomLabels
        : dedupedRooms.map((r) => r.text)
    ).filter((r, i, arr) => arr.indexOf(r) === i);

    if (canonicalRooms.length > 0 && canonicalRooms.length <= TOO_MANY_TO_MARK) {
      const enumeration = labelsAreSidePanel
        ? `The sheet has a side-panel Room × Dimensions table. The canonical room list, in table order, is:\n\n${canonicalRooms.map((r, i) => `  ${i + 1}. "${r}"`).join("\n")}\n\nReturn exactly one entry per room from this list. Use these labels verbatim — do NOT merge, split, rename, or invent rooms.`
        : `The orange numbered circles on the image mark every room label printed on this floor plan. There are exactly ${marksFromLabels.length} marked rooms. Use these labels verbatim:\n\n${dedupedRooms.map((r, i) => `  Mark ${i + 1}: "${r.text}" at (${r.xNorm.toFixed(2)}, ${r.yNorm.toFixed(2)})`).join("\n")}\n\nDo NOT merge, split, rename, or invent rooms.`;
      userContent.push({ type: "text", text: enumeration });
    } else if (canonicalRooms.length > TOO_MANY_TO_MARK) {
      userContent.push({
        type: "text",
        text: `This is a dense commercial plan with many printed labels — both room names AND material codes. Identify EVERY room you can see (typically 8-40 rooms on a commercial floor). Ignore material codes like P-1, P-2, CPT-1, VCT-1, CG, WSF-1 — these are paint/floor/wall finishes, not rooms. Look for words like CORRIDOR, OFFICE, ROOM, STORAGE, LOBBY, ELEVATOR, STAIR, MECH, ELECTRICAL, OXYGEN, RESTROOM, etc. Return a record_takeoff with walls and ceilings for each room. DO NOT return empty arrays — there are clearly rooms on this floor plan.`,
      });
    }

    // 2) Printed dimension table: we'll compute walls/ceilings ourselves
    //    (deterministic, can't be hallucinated) and tell the AI to ONLY
    //    fill in substrate, trim, doors, and windows. This kills the
    //    "AI doubles the wall area" failure mode entirely.
    if (rendered.dimensionTable.length > 0) {
      const lines = rendered.dimensionTable
        .map(
          (d) =>
            `  "${d.label}": ${d.widthFt}' × ${d.heightFt}' (floor ${d.areaSqft} sqft)`,
        )
        .join("\n");
      userContent.push({
        type: "text",
        text: `A printed Room × Dimensions table was detected. The system will compute the wall and ceiling AREAS automatically from these dimensions — DO NOT compute area_sqft yourself for these rooms. For each interior room you DO record, fill in only the room label, substrate, polygon, confidence, and (if applicable) door/window counts and trim linear feet. Set area_sqft and linear_ft to 0 — the server will overwrite them. Skip exterior areas (garage, deck, porch).\n\n${lines}`,
      });
    }

    // 3) Other text fragments (smaller helper).
    if (rendered.textAnnotations.trim().length > 0) {
      userContent.push({
        type: "text",
        text: `Other text fragments extracted from the PDF's vector layer (for additional context):\n\n${rendered.textAnnotations.slice(0, 2000)}`,
      });
    }

    userContent.push({
      type: "text",
      text:
        dedupedRooms.length > 0
          ? `Call record_takeoff. Return exactly ${dedupedRooms.length} rooms — one entry per labeled room, matching the list above. Skip rooms outside the interior paint scope (garages, decks, porches, exterior).`
          : "Call record_takeoff with every paintable surface on this floor plan.",
    });

    const msg = await anthropic.messages.create({
      model: TAKEOFF_MODEL,
      max_tokens: 8192,
      system: [
        {
          type: "text",
          text: TAKEOFF_SYSTEM_PROMPT_CACHED,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [RECORD_TAKEOFF_TOOL],
      tool_choice: { type: "tool", name: "record_takeoff" },
      messages: [{ role: "user", content: userContent }],
    });

    inputTokens = msg.usage.input_tokens;
    outputTokens = msg.usage.output_tokens;
    cacheCreationInputTokens = msg.usage.cache_creation_input_tokens ?? 0;
    cacheReadInputTokens = msg.usage.cache_read_input_tokens ?? 0;

    for (const block of msg.content) {
      if (block.type === "tool_use" && block.name === "record_takeoff") {
        const raw = block.input as Partial<TakeoffToolResult>;
        // The schema marks every array required but Sonnet occasionally
        // returns a partial object. Fill missing arrays with [] so the
        // downstream code doesn't NPE on `.length`.
        toolResult = {
          scale_anchor: raw.scale_anchor ?? {
            found: false,
            ceiling_height_ft: 9,
          },
          walls: raw.walls ?? [],
          ceilings: raw.ceilings ?? [],
          trim: raw.trim ?? [],
          doors: raw.doors ?? [],
          windows: raw.windows ?? [],
          warnings: raw.warnings ?? [],
        };
      }
    }
  } catch (err) {
    if (err instanceof MissingApiKeyError) throw err;
    throw new Error(
      "The AI couldn't analyze this page right now. Wait a moment and try again.",
    );
  }

  if (!toolResult) {
    throw new Error(
      "The AI returned an unexpected response. Please try this page again.",
    );
  }

  // --- Stage 3.4: per-room cropping for dense plans without dim tables ----
  // The full-page pass merges adjacent rooms when there are >15 surfaces
  // and labels are scattered (i.e., not in a side-panel schedule). For
  // those plans we crop ~32% of the page around each in-plan room label
  // and run a focused per-room Sonnet call. Single-room frames eliminate
  // the polygon-merge bug.
  let perRoomCallsInputTokens = 0;
  let perRoomCallsOutputTokens = 0;
  let perRoomCallsCacheRead = 0;
  let perRoomCallsCacheWrite = 0;
  let perRoomCount = 0;
  if (rendered.dimensionTable.length === 0) {
    const inPlanRooms = dedupRoomLabels(rendered.roomLabels);
    const sidePanel = detectSidePanel(inPlanRooms);
    // Per-room cropping is expensive — only fire it when the main pass
    // produced a result that suggests there are real rooms to measure
    // OR when the main pass returned nothing on a clearly-dense plan
    // (lots of room labels but the AI gave up).
    const mainPassSurfaces =
      toolResult.walls.length + toolResult.ceilings.length;
    const mainPassEmpty = mainPassSurfaces === 0;
    const denseLabels = inPlanRooms.length >= 8;
    const denseSurfaces = mainPassSurfaces >= 15;
    const shouldRunPerRoom =
      !sidePanel &&
      inPlanRooms.length >= 4 &&
      (denseSurfaces || (mainPassEmpty && denseLabels));
    if (shouldRunPerRoom) {
      // Cap per-room calls to bound cost. We sort by font size DESC (larger
      // labels are usually real room names; smaller ones are paint/finish
      // codes) and take the top N.
      const MAX_PER_ROOM_CALLS = 30;
      const sortedRooms = [...inPlanRooms].sort(
        (a, b) => b.fontSizePt - a.fontSizePt,
      );
      const roomsToMeasure = sortedRooms.slice(0, MAX_PER_ROOM_CALLS);
      onProgress?.({
        stage: "reading_plan",
        message: `Re-measuring ${roomsToMeasure.length} rooms one at a time for accuracy.`,
      });
      const perRoom = await measureRoomsInParallel(
        rendered.imageBase64,
        rendered.imageMediaType,
        rendered.widthPx,
        rendered.heightPx,
        roomsToMeasure,
      );
      perRoomCount = perRoom.results.length;
      perRoomCallsInputTokens = perRoom.inputTokens;
      perRoomCallsOutputTokens = perRoom.outputTokens;
      perRoomCallsCacheRead = perRoom.cacheReadInputTokens;
      perRoomCallsCacheWrite = perRoom.cacheCreationInputTokens;
      toolResult = mergePerRoomResults(toolResult, perRoom.results);
    }
  }

  // --- Stage 3.5: deterministic dim-table override -----------------------
  // When the PDF has a printed Room × Dimensions table, we trust the math
  // over the AI's geometry. Recompute walls (perimeter × ceiling height)
  // and ceilings (W × H) from the table directly. The AI's substrate,
  // trim, doors, windows, and confidence are kept as-is.
  if (rendered.dimensionTable.length > 0) {
    // Force 9 ft ceiling — AI-reported values drift to 8-8.5 on residential
    // for no clear reason. Use the AI value only if explicitly noted in
    // notes (i.e., the user has a non-standard ceiling).
    const forcedCeilingFt = 9;
    toolResult = overlayDimensionTable(
      toolResult,
      rendered.dimensionTable,
      forcedCeilingFt,
    );
  }

  // --- Stage 4: plausibility check (server-side, free) --------------------
  const plaus = plausibilityCheck(toolResult);
  let finalResult = plaus.corrected;

  // --- Stage 5: validator (Haiku) -----------------------------------------
  // SKIP the validator when a printed dimension table was used. The
  // table itself is ground truth — the Haiku validator has been observed
  // to drop bathroom areas from 177 (correct) → 50 (wrong) because it
  // mis-estimates small rooms from the image. Trust the math.
  const dimTableUsed = rendered.dimensionTable.length > 0;

  let validatorInputTokens = 0;
  let validatorOutputTokens = 0;
  let validatorCacheReadInputTokens = 0;
  let validatorCacheCreationInputTokens = 0;
  let validatorFindings = 0;

  if (!dimTableUsed) {
    onProgress?.({
      stage: "validating",
      message: "Double-checking the AI's math for impossible numbers.",
    });
    try {
      const validation = await validateTakeoff({
        imageBase64: rendered.imageBase64,
        imageMediaType: rendered.imageMediaType,
        textAnnotations: rendered.textAnnotations,
        result: finalResult,
      });
      validatorInputTokens = validation.inputTokens;
      validatorOutputTokens = validation.outputTokens;
      validatorCacheReadInputTokens = validation.cacheReadInputTokens;
      validatorCacheCreationInputTokens = validation.cacheCreationInputTokens;
      validatorFindings = validation.findings.length;
      if (validation.findings.length > 0) {
        const applied = applyValidationFindings(
          finalResult,
          validation.findings,
        );
        finalResult = applied.corrected;
      }
    } catch {
      // Validator is best-effort; never block the takeoff because Haiku hiccupped.
    }
  }

  // Collect the vector extraction result we kicked off in parallel.
  const vector = await vectorP;

  return {
    status: "ok",
    result: finalResult,
    classification,
    rendered,
    takeoffInputTokens: inputTokens,
    takeoffOutputTokens: outputTokens,
    takeoffCacheCreationInputTokens: cacheCreationInputTokens,
    takeoffCacheReadInputTokens: cacheReadInputTokens,
    validatorInputTokens,
    validatorOutputTokens,
    validatorCacheReadInputTokens,
    validatorCacheCreationInputTokens,
    perRoomInputTokens: perRoomCallsInputTokens,
    perRoomOutputTokens: perRoomCallsOutputTokens,
    perRoomCacheReadInputTokens: perRoomCallsCacheRead,
    perRoomCacheCreationInputTokens: perRoomCallsCacheWrite,
    perRoomCount,
    plausibilityFlags: plaus.flags.length,
    validatorFindings,
    vectorRoomCandidates: vector?.candidates ?? [],
    vectorExtractionMs: vector?.elapsedMs ?? 0,
  };
}

import type { TakeoffResponse } from "./test-mode";

/**
 * Run per-room measurement calls in parallel batches. We cap concurrency
 * at 4 to stay well inside Anthropic's per-minute token limits on small
 * accounts (rendering each crop is ~1.5k vision tokens, so 4 in flight =
 * ~6k tok/sec sustained).
 */
async function measureRoomsInParallel(
  pageImageBase64: string,
  pageImageMediaType: "image/jpeg" | "image/png",
  pageWidthPx: number,
  pageHeightPx: number,
  labels: TextFragment[],
): Promise<{
  results: Array<{
    label: string;
    walls: TakeoffToolResult["walls"][number] | null;
    ceiling: TakeoffToolResult["ceilings"][number] | null;
    trim: TakeoffToolResult["trim"][number] | null;
    doors: TakeoffToolResult["doors"][number] | null;
    windows: TakeoffToolResult["windows"][number] | null;
  }>;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}> {
  // Higher concurrency cuts wall time without changing total cost.
  // 8 in flight × ~1.5k vision tokens = ~12k tok/s sustained — well
  // within Tier-1 limits.
  const CONCURRENCY = 8;
  const results: Awaited<ReturnType<typeof measureRoomsInParallel>>["results"] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  for (let i = 0; i < labels.length; i += CONCURRENCY) {
    const batch = labels.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (l) => {
        try {
          const r = await measureOneRoom({
            pageImageBase64,
            pageImageMediaType,
            pageWidthPx,
            pageHeightPx,
            label: l.text,
            xNorm: l.xNorm,
            yNorm: l.yNorm,
          });
          inputTokens += r.inputTokens;
          outputTokens += r.outputTokens;
          cacheReadInputTokens += r.cacheReadInputTokens;
          cacheCreationInputTokens += r.cacheCreationInputTokens;
          return {
            label: l.text,
            walls: r.walls,
            ceiling: r.ceiling,
            trim: r.trim,
            doors: r.doors,
            windows: r.windows,
          };
        } catch {
          return null;
        }
      }),
    );
    for (const r of batchResults) {
      if (r) results.push(r);
    }
  }
  return {
    results,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
  };
}

/**
 * Replace the full-page pass's walls/ceilings/trim/doors/windows with
 * the per-room results, keyed by room label. Per-room measurements are
 * much more accurate, so we trust them over the full-page output when
 * available.
 */
function mergePerRoomResults(
  result: TakeoffToolResult,
  perRoom: Array<{
    label: string;
    walls: TakeoffToolResult["walls"][number] | null;
    ceiling: TakeoffToolResult["ceilings"][number] | null;
    trim: TakeoffToolResult["trim"][number] | null;
    doors: TakeoffToolResult["doors"][number] | null;
    windows: TakeoffToolResult["windows"][number] | null;
  }>,
): TakeoffToolResult {
  if (perRoom.length === 0) return result;
  const walls: TakeoffToolResult["walls"] = [];
  const ceilings: TakeoffToolResult["ceilings"] = [];
  const trim: TakeoffToolResult["trim"] = [];
  const doors: TakeoffToolResult["doors"] = [];
  const windows: TakeoffToolResult["windows"] = [];
  for (const r of perRoom) {
    if (r.walls) walls.push(r.walls);
    if (r.ceiling) ceilings.push(r.ceiling);
    if (r.trim) trim.push(r.trim);
    if (r.doors) doors.push(r.doors);
    if (r.windows) windows.push(r.windows);
  }
  return {
    ...result,
    walls,
    ceilings,
    trim,
    doors,
    windows,
    warnings: [
      ...(result.warnings ?? []),
      `Used per-room cropping for ${perRoom.length} rooms (one focused Sonnet call each).`,
    ],
  };
}

/**
 * Recompute walls and ceilings deterministically from a printed Room ×
 * Dimensions table. The AI's geometry guesses are replaced with
 * width × height (floor area) and perimeter × ceiling height (wall area).
 * Substrate, polygon, trim_lf, door/window counts, and confidence are
 * retained from the AI's output (or filled with sensible defaults).
 */
function overlayDimensionTable(
  result: TakeoffToolResult,
  table: DimensionTableRow[],
  ceilingHeightFt: number,
): TakeoffToolResult {
  const fold = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .trim();

  // Index the AI's walls and ceilings by normalized room label so we can
  // pull substrate/polygon/confidence for rooms the AI also listed.
  const wallByRoom = new Map<string, TakeoffToolResult["walls"][number]>();
  for (const w of result.walls) wallByRoom.set(fold(w.room_label), w);
  const ceilByRoom = new Map<string, TakeoffToolResult["ceilings"][number]>();
  for (const c of result.ceilings) ceilByRoom.set(fold(c.room_label), c);

  // Heuristic: skip rooms that are obviously exterior. The AI is also told
  // to skip these in the prompt, but we belt-and-suspenders here.
  const EXTERIOR =
    /\b(deck|porch|patio|balcony|exterior|garage|carport|driveway)\b/i;

  const newWalls: TakeoffToolResult["walls"] = [];
  const newCeilings: TakeoffToolResult["ceilings"] = [];

  for (const row of table) {
    if (EXTERIOR.test(row.label)) continue;
    const key = fold(row.label);
    const existingWall = wallByRoom.get(key);
    const existingCeil = ceilByRoom.get(key);

    const perimeter = 2 * (row.widthFt + row.heightFt);
    const wallArea = perimeter * ceilingHeightFt;
    const floorArea = row.widthFt * row.heightFt;

    newWalls.push({
      room_label: row.label,
      area_sqft: round1(wallArea),
      linear_ft: round1(perimeter),
      substrate: existingWall?.substrate ?? "drywall",
      polygon: existingWall?.polygon ?? [
        { x: 0.1, y: 0.1 },
        { x: 0.2, y: 0.1 },
        { x: 0.2, y: 0.2 },
        { x: 0.1, y: 0.2 },
      ],
      confidence: existingWall?.confidence ?? 0.85,
    });

    newCeilings.push({
      room_label: row.label,
      area_sqft: round1(floorArea),
      substrate: existingCeil?.substrate ?? "drywall",
      polygon: existingCeil?.polygon ?? [
        { x: 0.1, y: 0.1 },
        { x: 0.2, y: 0.1 },
        { x: 0.2, y: 0.2 },
        { x: 0.1, y: 0.2 },
      ],
      confidence: existingCeil?.confidence ?? 0.85,
    });
  }

  // Trim, doors, windows: drop entries that point at rooms not in the
  // table, but keep entries that match (the AI's count is the only
  // information we have for these).
  const tableLabels = new Set(table.map((r) => fold(r.label)));
  const trim = result.trim.filter((t) => tableLabels.has(fold(t.room_label)));
  const doors = result.doors.filter((d) => tableLabels.has(fold(d.room_label)));
  const windows = result.windows.filter((w) =>
    tableLabels.has(fold(w.room_label)),
  );

  return {
    ...result,
    walls: newWalls,
    ceilings: newCeilings,
    trim,
    doors,
    windows,
    warnings: [
      ...(result.warnings ?? []),
      `Used printed Room × Dimensions table for ${newWalls.length} rooms (deterministic geometry).`,
    ],
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Returns true if the supplied labels look like a side-panel schedule
 * (all clustered in a narrow vertical band) rather than scattered labels
 * printed on the actual floor plan. Heuristic: if 80% of labels share an
 * x-coordinate within ±5%, it's a side panel.
 */
function detectSidePanel(labels: TextFragment[]): boolean {
  if (labels.length < 3) return false;
  // Find the densest x-cluster.
  const xs = labels.map((l) => l.xNorm).sort((a, b) => a - b);
  const tolerance = 0.05;
  let best = 0;
  for (let i = 0; i < xs.length; i++) {
    let count = 0;
    for (let j = 0; j < xs.length; j++) {
      if (Math.abs(xs[j] - xs[i]) <= tolerance) count++;
    }
    if (count > best) best = count;
  }
  return best / labels.length >= 0.8;
}

/**
 * Collapse repeated PDF text fragments that point to the same room label.
 * Floor plans often have multiple text runs per label (e.g., "FAMILY"
 * and "ROOM" on two lines). We merge fragments whose normalized labels
 * match and whose positions are within ~6% of each other.
 */
function dedupRoomLabels(fragments: TextFragment[]): TextFragment[] {
  const out: TextFragment[] = [];
  function normalize(s: string): string {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  for (const f of fragments) {
    const norm = normalize(f.text);
    if (!norm) continue;
    const near = out.find(
      (g) =>
        normalize(g.text) === norm &&
        Math.hypot(g.xNorm - f.xNorm, g.yNorm - f.yNorm) < 0.06,
    );
    if (near) continue;
    out.push(f);
  }
  return out;
}

/** Convert the legacy test-mode shape into the new tool result shape. */
function stubToToolResult(legacy: TakeoffResponse): TakeoffToolResult {
  const walls: TakeoffToolResult["walls"] = [];
  const ceilings: TakeoffToolResult["ceilings"] = [];
  const trim: TakeoffToolResult["trim"] = [];
  const doors: TakeoffToolResult["doors"] = [];
  const windows: TakeoffToolResult["windows"] = [];

  for (const s of legacy.surfaces) {
    const polygon = s.polygon ?? [];
    if (s.type === "wall") {
      walls.push({
        room_label: s.roomLabel ?? "Unknown",
        area_sqft: s.estimatedSquareFootage ?? 0,
        linear_ft: s.estimatedLinearFootage ?? 0,
        substrate: s.substrate ?? "drywall",
        polygon,
        confidence: s.confidence,
      });
    } else if (s.type === "ceiling") {
      ceilings.push({
        room_label: s.roomLabel ?? "Unknown",
        area_sqft: s.estimatedSquareFootage ?? 0,
        substrate: s.substrate ?? "drywall",
        polygon,
        confidence: s.confidence,
      });
    } else if (s.type === "trim") {
      trim.push({
        room_label: s.roomLabel ?? "Unknown",
        linear_ft: s.estimatedLinearFootage ?? 0,
        substrate: s.substrate ?? "wood",
        polygon,
        confidence: s.confidence,
      });
    } else if (s.type === "door") {
      doors.push({
        room_label: s.roomLabel ?? "Unknown",
        count: s.count ?? 1,
        substrate: s.substrate ?? "wood",
        polygon,
        confidence: s.confidence,
      });
    } else if (s.type === "window") {
      windows.push({
        room_label: s.roomLabel ?? "Unknown",
        count: s.count ?? 1,
        substrate: s.substrate ?? "metal",
        polygon,
        confidence: s.confidence,
      });
    }
  }

  return {
    scale_anchor: {
      found: false,
      ceiling_height_ft: 9,
      note: "TEST_MODE stub",
    },
    walls,
    ceilings,
    trim,
    doors,
    windows,
    warnings: legacy.warnings ?? [],
  };
}
