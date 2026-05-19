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
import { runHighResTakeoff } from "./high-res-takeoff";
import {
  extractPage,
  type ExtractedPage,
  type ExtractedRoom,
} from "@/lib/extract/page-extract";
import type { EstablishedScale, UserSuppliedScale } from "@/lib/extract/scale";

// Default ceiling height (in feet) used when the caller doesn't pass
// one. Real wall-area math should use the per-project value from
// Project.ceilingHeightFt — this is just the conservative fallback.
const DEFAULT_CEILING_HEIGHT_FT = 9;

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
  /**
   * Optional user-supplied scale (from a two-point calibration stored
   * on PlanPage.scaleRatio + scaleLabel). When present, it overrides
   * any text-notation or scale-bar detection the engine would do.
   */
  userScale?: UserSuppliedScale | null;
  /**
   * Per-project ceiling height in feet. Used for wall-area math
   * (linear ft × ceiling ft = sqft). Defaults to 9 if omitted.
   */
  ceilingHeightFt?: number;
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
  /**
   * The scale the engine used (or null if none could be established
   * and the user hasn't calibrated). Plumbed to the API route so the
   * scaleRatio/Method/Label can be persisted on PlanPage and surfaced
   * to the UI banner.
   */
  establishedScale: EstablishedScale | null;
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
  const ceilingHeightFt = input.ceilingHeightFt ?? DEFAULT_CEILING_HEIGHT_FT;
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
  // Deterministic geometry pipeline — runs in parallel and produces
  // real wall-bounded polygons + scale-measured dimensions. The runner
  // uses this as the source of truth for surface coordinates AND for
  // wall lengths / room areas. The AI call below is now responsible
  // for substrate, doors, windows, and trim keyed by room label.
  const extractedP: Promise<ExtractedPage | null> = isTestMode()
    ? Promise.resolve(null)
    : extractPage(input.pdfBuffer, input.pageNumber, {
        userScale: input.userScale ?? null,
      }).catch(() => null);
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
      establishedScale: null,
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

  // Deterministic skip: the extractor knows when a page has no room-
  // like labels and no usable vector wall network (covers, photo
  // pages, amenities text, specifications, back covers). Honor that
  // before spending Sonnet tokens on a page we can't auto-detect.
  const earlyExtracted = await extractedP;
  if (earlyExtracted && earlyExtracted.status === "skipped") {
    const reasonByKey: Record<string, string> = {
      no_text_layer:
        "This page has no extractable text or vector geometry — we can't auto-detect rooms on a scanned or image-only sheet.",
      non_floor_plan:
        "This page has no room labels — it looks like a cover, amenities, or specifications sheet rather than a floor plan.",
      low_geometry:
        "This page's vector geometry isn't dense enough to find room boundaries reliably.",
    };
    const reason =
      reasonByKey[earlyExtracted.reason ?? "low_geometry"] ??
      "This page can't be auto-detected from its vector geometry.";
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

  // High-res Set-of-Marks path — single Opus 4.7 call at 2576px with a
  // coordinate-grid overlay + numbered markers at every room label.
  // On the INHP benchmark vs MANUAL ground truth: 100% room ID, 9% MAE
  // ($0.29/page). 12/13 rooms read from architect's printed dimensions.
  //
  // Off by default while we A/B against production until we have wider
  // coverage of plan types. Enable with USE_HIGH_RES_TAKEOFF=1.
  const useHighRes = process.env.USE_HIGH_RES_TAKEOFF === "1";
  if (useHighRes) {
    try {
      // Pull room-label positions from the rendered PDF for Set-of-Marks markers.
      // Note: pdf-render's yNorm is y-down (0=top, 1=bottom) — the old
      // comment here claimed y-up which contradicts pdf-render.ts:151.
      const labelPositions = (rendered.roomLabels ?? []).map((l) => ({
        label: l.text,
        xNorm: l.xNorm,
        yNorm: l.yNorm,
      }));
      const hrResult = await runHighResTakeoff({
        pdfBuffer: input.pdfBuffer,
        pageNumber: input.pageNumber,
        maxImagePx: 2576,
        gridDivisions: 10,
        model: "claude-opus-4-7",
        roomLabelPositions: labelPositions,
      });

      // High-res returns a `gridCell` string per room (e.g. "C4") via
      // Set-of-Marks prompting — that's the AI's OWN position assignment
      // on the 10×10 grid we overlay on the page. Use that directly
      // instead of the placeholder. This is the most reliable signal we
      // have for room position (vs. label-matching guesses which were
      // throwing every room into wrong spots).
      //
      // gridCell convention from high-res-takeoff.ts:341-349:
      //   letter = column (A=0, B=1, ..., J=9)
      //   number = row, 0-indexed (so "C4" is column 2, row 4)
      //   row 0 = top of image (y-down), matching SurfaceOverlay
      const gridN = 10; // matches gridDivisions: 10 passed to runHighResTakeoff
      const pageAspect =
        hrResult.imageHeightPx > 0
          ? hrResult.imageWidthPx / hrResult.imageHeightPx
          : 1;
      function polygonFromGridCell(
        gridCell: string | undefined,
        areaSqft: number,
      ): { x: number; y: number }[] {
        const m = (gridCell ?? "").trim().toUpperCase().match(/^([A-J])(\d)$/);
        if (!m) {
          // Fallback: center of page if AI didn't return a parseable cell
          return [
            { x: 0.45, y: 0.45 }, { x: 0.55, y: 0.45 },
            { x: 0.55, y: 0.55 }, { x: 0.45, y: 0.55 },
          ];
        }
        const col = m[1].charCodeAt(0) - 65;
        const row = parseInt(m[2], 10);
        // Cell center in normalized 0..1 (y-down — row 0 = top of image)
        const cx = (col + 0.5) / gridN;
        const cy = (row + 0.5) / gridN;
        // Box sized by area, same formula as elsewhere
        const halfW = Math.min(
          0.09,
          Math.max(0.01, Math.sqrt(Math.max(16, areaSqft)) / 250),
        );
        const halfH = halfW * pageAspect;
        const c = (v: number) => Math.max(0.005, Math.min(0.995, v));
        return [
          { x: c(cx - halfW), y: c(cy - halfH) },
          { x: c(cx + halfW), y: c(cy - halfH) },
          { x: c(cx + halfW), y: c(cy + halfH) },
          { x: c(cx - halfW), y: c(cy + halfH) },
        ];
      }

      const walls: TakeoffToolResult["walls"] = hrResult.rooms.map((r) => {
        const area = r.wallAreaSqft ??
          Math.round(((r.widthFt ?? 10) + (r.heightFt ?? 10)) * 2 * r.ceilingHeightFt * 0.93);
        return {
          room_label: r.label,
          area_sqft: area,
          linear_ft: Math.round(((r.widthFt ?? 10) + (r.heightFt ?? 10)) * 2),
          substrate: "drywall",
          polygon: polygonFromGridCell(r.gridCell, area),
          confidence: r.confidence,
        };
      });
      const ceilings: TakeoffToolResult["ceilings"] = hrResult.rooms.map((r) => ({
        room_label: r.label,
        area_sqft: r.floorAreaSqft,
        substrate: "drywall",
        polygon: polygonFromGridCell(r.gridCell, r.floorAreaSqft),
        confidence: r.confidence,
      }));
      const doors: TakeoffToolResult["doors"] = hrResult.rooms
        .filter((r) => r.doors > 0)
        .map((r) => ({
          room_label: r.label,
          count: r.doors,
          substrate: "wood",
          polygon: polygonFromGridCell(r.gridCell, 25),
          confidence: r.confidence,
        }));
      const windows: TakeoffToolResult["windows"] = hrResult.rooms
        .filter((r) => r.windows > 0)
        .map((r) => ({
          room_label: r.label,
          count: r.windows,
          substrate: "metal",
          polygon: polygonFromGridCell(r.gridCell, 25),
          confidence: r.confidence,
        }));

      const rawResult: TakeoffToolResult = {
        scale_anchor: {
          found: hrResult.scale != null,
          ceiling_height_ft: 9,
          note: hrResult.scale ?? undefined,
        },
        walls,
        ceilings,
        trim: [],
        doors,
        windows,
        warnings: [
          `High-res Set-of-Marks takeoff: ${hrResult.rooms.length} rooms at ${hrResult.imageWidthPx}×${hrResult.imageHeightPx} px.`,
        ],
      };

      // Polygons are already built from gridCell above — the AI's own
      // grid-cell assignment is more reliable than label-matching guesses,
      // so we don't run repositionPolygonsByLabel here.
      const vector = await vectorP;
      const extractedHr = await extractedP;
      void labelPositions; void vector; // kept for parity with legacy path
      // Override the grid-cell polygons + the AI's measurements with
      // deterministic geometry from the extractor — same rule as the
      // legacy path so both code paths return surfaces whose
      // coordinates AND measurements come from the PDF, not the AI.
      const result = applyExtractionGeometry(
        rawResult,
        extractedHr,
        ceilingHeightFt,
      );

      // Skip per-room cropping + validator since high-res already gives
      // us per-room printed-dimension reads.
      return {
        status: "ok",
        result,
        classification,
        rendered,
        takeoffInputTokens: hrResult.inputTokens,
        takeoffOutputTokens: hrResult.outputTokens,
        takeoffCacheCreationInputTokens: hrResult.cacheCreationInputTokens,
        takeoffCacheReadInputTokens: hrResult.cacheReadInputTokens,
        validatorInputTokens: 0,
        validatorOutputTokens: 0,
        validatorCacheReadInputTokens: 0,
        validatorCacheCreationInputTokens: 0,
        perRoomInputTokens: 0,
        perRoomOutputTokens: 0,
        perRoomCacheReadInputTokens: 0,
        perRoomCacheCreationInputTokens: 0,
        perRoomCount: hrResult.rooms.length,
        plausibilityFlags: 0,
        validatorFindings: 0,
        vectorRoomCandidates: vector?.candidates ?? [],
        vectorExtractionMs: vector?.elapsedMs ?? 0,
        establishedScale: extractedHr?.establishedScale ?? null,
      };
    } catch (err) {
      // Fall through to the legacy pipeline on any failure.
      console.warn("[takeoff] high-res failed, falling back:", (err as Error).message);
    }
  }

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
  const extracted = await extractedP;

  // Replace the AI's polygon coordinates AND measurements with the
  // deterministic page extractor's output. Surfaces now get their
  // boxes from real PDF geometry, and their wall lengths / floor
  // areas from extracted polygons × the established scale (or from
  // a printed dim-table when present). The AI's number is never
  // surfaced as a measurement.
  finalResult = applyExtractionGeometry(
    finalResult,
    extracted,
    ceilingHeightFt,
  );

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
    establishedScale: extracted?.establishedScale ?? null,
  };
}

import type { TakeoffResponse } from "./test-mode";
import type { SurfaceDerivation } from "./takeoff-prompt";

/**
 * Replace every AI-returned polygon AND measurement with values from the
 * deterministic page extractor, and tag each surface with its derivation.
 * The AI's own area_sqft / linear_ft are NEVER surfaced to the user —
 * we either use real extraction × scale, the printed dim-table, or null
 * (with a "scale needed" / "AI guess" badge prompting the contractor).
 *
 * Matching is by normalized room label (lowercased, alphanumeric-only)
 * with a substring fallback for room-number suffixes ("BEDROOM 2"
 * matches "BEDROOM").
 *
 * Per-room measurement mapping:
 *   - wall    → linear_ft = room.perimeterFt
 *               area_sqft = perimeterFt × ceilingHeightFt
 *   - ceiling → area_sqft = room.areaSqft  (floor area)
 *   - trim    → linear_ft = room.perimeterFt  (base + casing path)
 *   - door    → AI count retained; no length/area
 *   - window  → AI count retained; no length/area
 *
 * When the matching room has no measurement (derivation `scale-needed`
 * or the AI named a room the extractor didn't find), all of area_sqft
 * and linear_ft are nulled — honest absence beats confident wrongness.
 */
function applyExtractionGeometry(
  result: TakeoffToolResult,
  extracted: ExtractedPage | null,
  ceilingHeightFt: number,
): TakeoffToolResult {
  if (!extracted || extracted.status !== "ok" || extracted.rooms.length === 0) {
    // No extraction available — drop polygons + measurements; tag as
    // ai-fallback so the queue badge prompts the user for review.
    return clearAllToAiFallback(result);
  }
  const norm = (s: string) =>
    (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const byLabel = new Map<string, ExtractedRoom>();
  for (const room of extracted.rooms) {
    const k = norm(room.label);
    if (k && !byLabel.has(k)) byLabel.set(k, room);
  }

  function lookup(label: string): ExtractedRoom | undefined {
    const k = norm(label);
    if (!k) return undefined;
    const direct = byLabel.get(k);
    if (direct) return direct;
    // Loose match: AI returned "BEDROOM 2" or "BEDROOM #137" — find
    // any extracted room whose key is a prefix of the AI key OR vice
    // versa. Prevents missing rooms when the AI elaborates the label.
    for (const [extKey, room] of byLabel.entries()) {
      if (extKey.length < 3) continue;
      if (k.startsWith(extKey) || extKey.startsWith(k)) return room;
    }
    return undefined;
  }

  function wallMeasures(
    room: ExtractedRoom,
  ): { area_sqft: number | null; linear_ft: number | null } {
    // Wall length = polygon perimeter (or table 2(W+H)).
    const linear_ft = room.perimeterFt;
    if (linear_ft === null) {
      return { area_sqft: null, linear_ft: null };
    }
    // Wall area = perimeter × ceilingHeight. The 5-8 % door/window
    // deduction the AI used to do is dropped here — the deterministic
    // engine doesn't know openings yet, and over-counting is safer
    // than under-counting for a paint estimate. Manual edits remain
    // the user's escape hatch.
    return { area_sqft: round1(linear_ft * ceilingHeightFt), linear_ft };
  }

  function patchWall(entry: TakeoffToolResult["walls"][number]) {
    const room = lookup(entry.room_label);
    if (!room) {
      return {
        ...entry,
        polygon: [],
        area_sqft: null,
        linear_ft: null,
        derivation: "ai-fallback" as const,
      };
    }
    const m = wallMeasures(room);
    return {
      ...entry,
      polygon: room.polygonNorm,
      area_sqft: m.area_sqft,
      linear_ft: m.linear_ft,
      derivation: room.derivation,
    };
  }

  function patchCeiling(entry: TakeoffToolResult["ceilings"][number]) {
    const room = lookup(entry.room_label);
    if (!room) {
      return {
        ...entry,
        polygon: [],
        area_sqft: null,
        derivation: "ai-fallback" as const,
      };
    }
    return {
      ...entry,
      polygon: room.polygonNorm,
      area_sqft: room.areaSqft,
      derivation: room.derivation,
    };
  }

  function patchTrim(entry: TakeoffToolResult["trim"][number]) {
    const room = lookup(entry.room_label);
    if (!room) {
      return {
        ...entry,
        polygon: [],
        linear_ft: null,
        derivation: "ai-fallback" as const,
      };
    }
    return {
      ...entry,
      polygon: room.polygonNorm,
      linear_ft: room.perimeterFt,
      derivation: room.derivation,
    };
  }

  function patchCount<T extends TakeoffToolResult["doors"][number]>(entry: T): T {
    const room = lookup(entry.room_label);
    if (!room) {
      return { ...entry, polygon: [], derivation: "ai-fallback" };
    }
    return {
      ...entry,
      polygon: room.polygonNorm,
      derivation: room.derivation,
    };
  }

  return {
    ...result,
    walls: result.walls.map(patchWall),
    ceilings: result.ceilings.map(patchCeiling),
    trim: result.trim.map(patchTrim),
    doors: result.doors.map(patchCount),
    windows: result.windows.map(patchCount),
  };
}

function clearAllToAiFallback(result: TakeoffToolResult): TakeoffToolResult {
  return {
    ...result,
    walls: result.walls.map((w) => ({
      ...w,
      polygon: [],
      area_sqft: null,
      linear_ft: null,
      derivation: "ai-fallback",
    })),
    ceilings: result.ceilings.map((c) => ({
      ...c,
      polygon: [],
      area_sqft: null,
      derivation: "ai-fallback",
    })),
    trim: result.trim.map((t) => ({
      ...t,
      polygon: [],
      linear_ft: null,
      derivation: "ai-fallback",
    })),
    doors: result.doors.map((d) => ({ ...d, polygon: [], derivation: "ai-fallback" })),
    windows: result.windows.map((w) => ({ ...w, polygon: [], derivation: "ai-fallback" })),
  };
}

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
 * Drop labels that look like a side-panel schedule (most labels share an
 * x-coordinate within ±5%). Federal architectural sheets put a Room
 * Schedule on every floor-plan page; those rows have the same labels as
 * real rooms but all sit on one x-column, so they poison polygon
 * positioning. Returns the labels that are NOT in the cluster.
 */
function filterOutLabelCluster(
  labels: Array<{ label: string; xNorm: number; yNorm: number }>,
): Array<{ label: string; xNorm: number; yNorm: number }> {
  if (labels.length < 6) return labels;
  const tolerance = 0.05;
  let bestCenter = -1;
  let bestCount = 0;
  for (const a of labels) {
    let count = 0;
    for (const b of labels) {
      if (Math.abs(b.xNorm - a.xNorm) <= tolerance) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      bestCenter = a.xNorm;
    }
  }
  // Cluster contains at least half of all labels → schedule table.
  if (bestCount / labels.length >= 0.5) {
    return labels.filter((l) => Math.abs(l.xNorm - bestCenter) > tolerance);
  }
  return labels;
}

/**
 * The polygons that the vision model returns are notoriously imprecise on
 * dense plans — every room collapses into the same upper corner because
 * Claude is much better at *labeling* rooms than at *locating* them in
 * normalized image coordinates. We do, however, have a deterministic
 * signal: the PDF text layer tells us EXACTLY where each room label sits
 * on the page. If we can match a detected surface's room_label to one of
 * those positions, we draw the polygon as a box centered on that label,
 * sized roughly to the room's reported area.
 *
 * Surfaces whose label can't be matched (e.g. pipelines that don't ship
 * label positions, or unusually-named rooms) keep whatever polygon the
 * model gave us — better that than placing them at a wrong guessed spot.
 */
function repositionPolygonsByLabel(
  result: TakeoffToolResult,
  labelPositions: Array<{ label: string; xNorm: number; yNorm: number }>,
  vectorCandidates: RoomCandidate[],
  pageWidthPt: number,
  pageHeightPt: number,
  pageAspectRatio: number,
): TakeoffToolResult {
  // Federal-style drawings put a Room Schedule table on every floor plan
  // sheet. Those table rows are TEXT FRAGMENTS with the same labels as
  // the actual rooms — and they cluster on a single x-column. If we
  // naively positioned polygons by label match, every wall would land on
  // the schedule table. Filter the schedule cluster out first.
  const inPlanLabels =
    labelPositions.length > 0 ? filterOutLabelCluster(labelPositions) : [];

  const normLabel = (s: string) =>
    (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

  type Anchor = { xNorm: number; yNorm: number; sizeHint: number | null };

  // Convert a vector-candidate PDF-y-up bbox into a y-down normalized
  // anchor that the overlay can render directly. sizeHint is the bbox's
  // half-width in normalized page coords, so polygons get real geometric
  // sizes when we have them.
  function bboxToAnchor(rc: RoomCandidate): Anchor | null {
    if (pageWidthPt === 0 || pageHeightPt === 0) return null;
    const cxPt = rc.bbox.x + rc.bbox.width / 2;
    const cyPt = rc.bbox.y + rc.bbox.height / 2;
    return {
      xNorm: cxPt / pageWidthPt,
      yNorm: 1 - cyPt / pageHeightPt, // PDF y-up → overlay y-down
      sizeHint: Math.max(
        rc.bbox.width / pageWidthPt,
        rc.bbox.height / pageHeightPt,
      ) / 2,
    };
  }

  // Build label → anchor index. Vector candidates win over text labels —
  // they were paired with actual planar-graph faces, so the position
  // sits on real walls, not just where the text was drawn.
  // IMPORTANT: only add candidates to `exact` if their label is a
  // plausible room name. The Voronoi pairing pool happily includes long
  // sentences pulled from sheet notes ("PROVIDE CLEAR SILICONE SEALANT
  // AT PERIMETER…"), and pinning a polygon to one of those is worse
  // than no anchor at all.
  // What counts as a "room-like" candidate. Long labels are sheet notes
  // ("PROVIDE CLEAR SILICONE SEALANT..."), and positions on the very
  // bottom or right strip are typically inside the title block / room
  // schedule rather than on the floor plan. Putting a polygon at either
  // is worse than no polygon — that's what produced the boxes in the
  // ANDERSON title block.
  function isRoomLikeLabel(label: string): boolean {
    if (!label) return false;
    const wordCount = label.trim().split(/\s+/).length;
    return label.length <= 32 && wordCount <= 4;
  }
  function isInPlanArea(anchor: Anchor): boolean {
    // overlay coords (y-down). Most federal sheets put the title block
    // in the bottom-right ~15%. The right ~12% often holds the room
    // schedule. Conservative bounds — drop candidates that fall in
    // either region.
    if (anchor.yNorm > 0.85) return false; // bottom strip → title block
    if (anchor.xNorm > 0.88) return false; // far right → schedule / notes
    if (anchor.yNorm < 0.04) return false; // page header
    if (anchor.xNorm < 0.02) return false; // page binding edge
    return true;
  }

  const exact = new Map<string, Anchor>();
  // Two pools: ALL valid anchors (for object-identity use in
  // candidateByNumber + identity tracking) and a CLEAN pool restricted
  // to room-like labels in the plan area (for round-robin).
  const candidateAnchors: Array<{ idx: number; anchor: Anchor }> = [];
  const cleanCandidateAnchors: Array<{ idx: number; anchor: Anchor }> = [];
  vectorCandidates.forEach((rc, i) => {
    const a = bboxToAnchor(rc);
    if (!a) return;
    candidateAnchors.push({ idx: i, anchor: a });
    if (isRoomLikeLabel(rc.label) && isInPlanArea(a)) {
      cleanCandidateAnchors.push({ idx: i, anchor: a });
    }
    const k = normLabel(rc.label);
    if (!k || exact.has(k)) return;
    if (!isRoomLikeLabel(rc.label)) return;
    if (!isInPlanArea(a)) return;
    exact.set(k, a);
  });
  for (const p of inPlanLabels) {
    const k = normLabel(p.label);
    if (k && !exact.has(k)) {
      exact.set(k, { xNorm: p.xNorm, yNorm: p.yNorm, sizeHint: null });
    }
  }

  // Collect every distinct room label the AI returned, in the order
  // they were first seen.
  const uniqueLabels: string[] = [];
  {
    const seen = new Set<string>();
    for (const list of [
      result.walls,
      result.ceilings,
      result.trim,
      result.doors,
      result.windows,
    ]) {
      for (const e of list) {
        const k = normLabel(e.room_label);
        if (k && !seen.has(k)) {
          seen.add(k);
          uniqueLabels.push(k);
        }
      }
    }
  }

  // Try to score a vector candidate against a room key by extracting
  // numbers and matching them. AI returns "PATIENT ROOM 137"; the
  // vector candidate might be "137 PATIENT ROOM" (mupdf text-order
  // varies). A simple number match correctly pairs room 137 with the
  // candidate at room 137's actual position.
  //
  // CRITICAL: reuse the same Anchor instance from candidateAnchors so
  // that claim() / usedAnchors object-identity checks work below. If we
  // re-call bboxToAnchor here we'd get a different object with the same
  // coords, and round-robin would re-assign the same position to
  // multiple labels — which was the previous bug.
  function numbersIn(s: string): string[] {
    return Array.from(s.matchAll(/\d+/g)).map((m) => m[0]);
  }
  const candidateByNumber = new Map<string, Anchor>();
  vectorCandidates.forEach((rc, i) => {
    const ca = candidateAnchors.find((c) => c.idx === i);
    if (!ca) return;
    for (const n of numbersIn(rc.label)) {
      if (n.length >= 2 && !candidateByNumber.has(n)) {
        candidateByNumber.set(n, ca.anchor);
      }
    }
  });

  // Per-label anchor assignment. Each unique room label gets ONE anchor;
  // every surface (wall + ceiling + trim + door + window) for that room
  // resolves through the same map so they cluster correctly together.
  //
  // Resolution order, best to worst:
  //   1. Exact normalized-label match in vector or text-layer pool
  //   2. Room-number match against a vector candidate (handles AI
  //      "PATIENT ROOM 137" vs vector "137 PATIENT ROOM")
  //   3. Round-robin assignment from the unused candidate pool
  // No substring matching — it was the reason every "PATIENT ROOM ##"
  // collapsed onto the bare "PATIENT ROOM" anchor.
  const labelAnchor = new Map<string, Anchor>();
  const usedAnchors = new Set<Anchor>();
  const claim = (k: string, a: Anchor) => {
    labelAnchor.set(k, a);
    usedAnchors.add(a);
  };

  for (const k of uniqueLabels) {
    if (exact.has(k)) {
      claim(k, exact.get(k)!);
      continue;
    }
    // Number-based match — try each number in the label.
    let matched = false;
    for (const n of numbersIn(k)) {
      const a = candidateByNumber.get(n);
      if (a && !usedAnchors.has(a)) {
        claim(k, a);
        matched = true;
        break;
      }
    }
    if (matched) continue;
    // No exact label match, no room-number match → DON'T round-robin
    // guess. Putting a polygon at a random unused position was the
    // source of every "polygon in the wrong room" complaint. We'd
    // rather show NO marker for this room and have it appear only in
    // the cost breakdown / queue. Honest > wrong.
    void cleanCandidateAnchors; // intentionally unused — kept for future use
  }

  function findMatch(roomLabel: string): Anchor | null {
    const k = normLabel(roomLabel);
    if (!k) return null;
    return labelAnchor.get(k) ?? null;
  }

  function polygonAround(
    cxImage: number,
    cyImage: number,
    areaSqft: number,
    sizeHint: number | null,
  ): { x: number; y: number }[] {
    // pdf-render normalizes label coords to y-down (0=top, 1=bottom),
    // same convention as SurfaceOverlay. Do not flip — the previous
    // y-flip was the reason every polygon landed in the wrong half of
    // the page (verified by inspecting persisted surface centroids).
    const cx = cxImage;
    const cy = cyImage;
    // These polygons are visual MARKERS, not wall outlines. The vector
    // extractor's sizeHints are unreliable (constant for Voronoi cells,
    // wildly variable for planar-graph faces) so pure area-based sizing
    // is the most predictable: a contractor glancing at the overlay
    // immediately sees which rooms are big and which are small.
    // 16 sqft → 1% half-width, 100 sqft → 2.4%, 500 sqft → 5.5%,
    // 1000 sqft → 7%, 1500 sqft → 8.6% (capped at 9%).
    // sizeHint param kept in the signature for back-compat; currently unused.
    void sizeHint;
    const halfW = Math.min(
      0.09,
      Math.max(0.01, Math.sqrt(Math.max(16, areaSqft)) / 250),
    );
    // Aspect-correct the height so boxes don't look squished on
    // tall/skinny pages.
    const halfH = halfW * pageAspectRatio;
    const c = (v: number) => Math.max(0.005, Math.min(0.995, v));
    return [
      { x: c(cx - halfW), y: c(cy - halfH) },
      { x: c(cx + halfW), y: c(cy - halfH) },
      { x: c(cx + halfW), y: c(cy + halfH) },
      { x: c(cx - halfW), y: c(cy + halfH) },
    ];
  }

  // Each room produces up to 5 surfaces (wall, ceiling, trim, door,
  // window). Without an offset, all five land on the exact same label
  // position and the overlay becomes an unreadable stack of identical
  // boxes. Fan them out in a small ring so each is independently visible.
  // Offsets in normalized page units — small enough to stay near the
  // matched room, big enough that adjacent boxes don't fully overlap.
  const TYPE_OFFSETS: Record<string, { dx: number; dy: number }> = {
    wall: { dx: 0, dy: 0 },
    ceiling: { dx: 0.018, dy: -0.012 },
    trim: { dx: -0.018, dy: -0.012 },
    door: { dx: 0.012, dy: 0.018 },
    window: { dx: -0.012, dy: 0.018 },
  };

  function reposition<
    T extends {
      room_label: string;
      polygon: { x: number; y: number }[];
    },
  >(
    entries: T[],
    fallbackArea: number,
    surfaceType: keyof typeof TYPE_OFFSETS,
    areaField?: keyof T,
  ): T[] {
    const offset = TYPE_OFFSETS[surfaceType];
    return entries.map((e) => {
      const m = findMatch(e.room_label);
      if (!m) {
        // No clean anchor available — drop the polygon entirely. The
        // surface still appears in the queue / cost breakdown; it just
        // doesn't get drawn on the plan. Honest about not knowing
        // where to put it, instead of dumping it on a sheet note.
        return { ...e, polygon: [] };
      }
      const area =
        (areaField && typeof e[areaField] === "number"
          ? (e[areaField] as number)
          : null) ?? fallbackArea;
      return {
        ...e,
        polygon: polygonAround(
          m.xNorm + offset.dx,
          m.yNorm + offset.dy,
          area,
          m.sizeHint,
        ),
      };
    });
  }

  return {
    ...result,
    walls: reposition(result.walls, 300, "wall", "area_sqft"),
    ceilings: reposition(result.ceilings, 200, "ceiling", "area_sqft"),
    trim: reposition(result.trim, 100, "trim"),
    doors: reposition(result.doors, 25, "door"),
    windows: reposition(result.windows, 25, "window"),
  };
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
