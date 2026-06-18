/**
 * Step D — AI fallback for low-confidence paint-scope rooms.
 *
 * The deterministic pipeline (Steps A–C) decides scope and flags rooms where the
 * signals conflict (`needsReview`). For ONLY those rooms, we crop the room from
 * the finish-plan view and ask Claude vision a single, narrow question — "are
 * this room's WALLS painted, tiled, FRP, or other?" — and use the verdict to
 * confirm or correct the deterministic decision.
 *
 * This is the Round-2/3 hybrid: region-cropped VLM on a SMALL high-res image
 * (never the full sheet), used as a backstop, not the primary decider. Cheap —
 * it fires on a handful of rooms per plan, often zero.
 */

import { getAnthropic } from "@/lib/anthropic";
import type { RoomSeed } from "@/lib/extract/room-seeds";
import type { SeededRoom } from "@/lib/extract/seeded-rooms";
import type { RoomScope, ScopeDecision } from "@/lib/extract/paint-scope";

export const VERIFY_FINISH_MODEL = "claude-sonnet-4-6";

/** Half-size (pt) of the fixed window cropped around a room's label seed. We
 *  crop around the SEED, not the room polygon, because open-plan room polygons
 *  can be over-large and swallow a neighbour's finish (a tile washroom), which
 *  would feed the model a misleading crop. A seed-centred window samples the
 *  wall finish right at the room's own label. ~150pt ≈ 8ft at 18pt/ft. */
const CROP_HALF_PT = 150;
/** Render scale (px per pt) for the crop sent to the model. */
const CROP_SCALE = 3;

export interface AiFinishVerdict {
  label: string;
  /** Dominant WALL finish the model saw. */
  finish: "paint" | "tile" | "frp" | "other";
  isPaint: boolean;
  confidence: number;
  reasoning: string;
}

interface PtBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Polygon bbox in PDF pt. */
function polyBox(poly: { x: number; y: number }[]): PtBox | null {
  if (poly.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}

/** Median vertical offset between the two plan views (finish − construction). */
function viewOffsetY(seeds: RoomSeed[]): number {
  const byLabel = new Map<string, number[]>();
  for (const s of seeds) {
    const k = s.label.trim().toUpperCase();
    (byLabel.get(k) ?? byLabel.set(k, []).get(k)!).push(s.y);
  }
  const dys: number[] = [];
  for (const ys of byLabel.values()) {
    if (ys.length < 2) continue;
    ys.sort((a, b) => a - b);
    dys.push(ys[ys.length - 1] - ys[0]);
  }
  if (dys.length === 0) return 0;
  dys.sort((a, b) => a - b);
  return dys[Math.floor(dys.length / 2)];
}

/**
 * Render a PDF-pt bounding box to a base64 PNG crop via a clipped MuPDF draw
 * device (no full-page raster, no external image lib).
 */
async function renderCrop(
  pdfBuffer: Buffer,
  pageNumber: number,
  box: PtBox,
): Promise<string> {
  const mupdf = (await import("mupdf")) as unknown as {
    Document: { openDocument: (d: Uint8Array, m: string) => any };
    Matrix: { scale: (x: number, y: number) => number[]; identity: number[] };
    ColorSpace: { DeviceRGB: unknown };
    Pixmap: new (cs: unknown, bbox: number[], alpha: boolean) => any;
    DrawDevice: new (m: number[], pix: any) => any;
  };
  const doc = mupdf.Document.openDocument(
    new Uint8Array(pdfBuffer),
    "application/pdf",
  );
  const page = doc.loadPage(pageNumber - 1);
  const s = CROP_SCALE;
  const dev = [box.x0 * s, box.y0 * s, box.x1 * s, box.y1 * s];
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, dev, false);
  pix.clear(255);
  const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  page.run(device, mupdf.Matrix.scale(s, s));
  device.close();
  return Buffer.from(pix.asPNG()).toString("base64");
}

const VERIFY_TOOL = {
  name: "report_wall_finish",
  description:
    "Report the dominant finish on the WALLS of the room in the image.",
  input_schema: {
    type: "object" as const,
    properties: {
      finish: {
        type: "string" as const,
        enum: ["paint", "tile", "frp", "other"],
        description:
          "The dominant finish covering the room's vertical WALL surfaces (ignore the floor and ceiling). Painted gypsum board = paint. Ceramic wall tile = tile. Fibreglass-reinforced panel = frp.",
      },
      confidence: {
        type: "number" as const,
        description: "0..1 confidence in the finish call.",
      },
      reasoning: {
        type: "string" as const,
        description: "One sentence citing what in the image drove the call.",
      },
    },
    required: ["finish", "confidence", "reasoning"],
  },
};

const SYSTEM_PROMPT = `You are reading a single room cropped from an architectural FINISH PLAN.
Decide what finish the room's WALLS receive — paint, ceramic tile, FRP panel, or other.
Use finish-code tags in the crop (P-# = paint, CT-# = ceramic wall tile, FRP-# = FRP panel,
TB-# = tile BASE only — a tile base does NOT make the room tiled), fixtures (a room with a
toilet/sink is usually a tiled washroom), and hatching. Judge the WALLS, not the floor or ceiling.
Report only what you can see.`;

/**
 * Ask Claude vision for one room's wall finish from a finish-view crop.
 */
export async function verifyRoomFinish(opts: {
  pdfBuffer: Buffer;
  pageNumber: number;
  label: string;
  bboxPt: PtBox;
}): Promise<AiFinishVerdict> {
  const imageBase64 = await renderCrop(
    opts.pdfBuffer,
    opts.pageNumber,
    opts.bboxPt,
  );
  const anthropic = getAnthropic();
  const msg = await anthropic.messages.create({
    model: VERIFY_FINISH_MODEL,
    max_tokens: 512,
    system: [{ type: "text", text: SYSTEM_PROMPT }],
    tools: [VERIFY_TOOL],
    tool_choice: { type: "tool", name: "report_wall_finish" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: imageBase64 },
          },
          {
            type: "text",
            text: `This crop is the room labeled "${opts.label}". What finish do its walls receive?`,
          },
        ],
      },
    ],
  });

  let finish: AiFinishVerdict["finish"] = "other";
  let confidence = 0;
  let reasoning = "no verdict";
  for (const block of msg.content) {
    if (block.type === "tool_use" && block.name === "report_wall_finish") {
      const i = block.input as {
        finish?: string;
        confidence?: number;
        reasoning?: string;
      };
      if (i.finish === "paint" || i.finish === "tile" || i.finish === "frp")
        finish = i.finish;
      else finish = "other";
      confidence = typeof i.confidence === "number" ? i.confidence : 0;
      reasoning = i.reasoning ?? reasoning;
    }
  }
  return {
    label: opts.label,
    finish,
    isPaint: finish === "paint",
    confidence,
    reasoning,
  };
}

/**
 * Run the AI fallback on every `needsReview` room and fold the verdict back into
 * the scope decisions. Rooms that don't need review pass through untouched, so
 * this costs nothing when the deterministic pipeline is already confident.
 */
export async function resolveLowConfidence(
  scopes: RoomScope[],
  rooms: SeededRoom[],
  seeds: RoomSeed[],
  pdfBuffer: Buffer,
  pageNumber: number,
): Promise<{ scopes: RoomScope[]; verdicts: AiFinishVerdict[] }> {
  const verdicts: AiFinishVerdict[] = [];
  // Each room's finish-plan-view seed (the larger-y label position) is the
  // crop centre — robust to open-plan polygons that span several rooms.
  const finishSeed = new Map<string, RoomSeed>();
  for (const s of seeds) {
    const k = s.label.trim().toUpperCase();
    const cur = finishSeed.get(k);
    if (!cur || s.y > cur.y) finishSeed.set(k, s);
  }

  const updated = await Promise.all(
    scopes.map(async (sc) => {
      if (!sc.needsReview) return sc;
      const seed = finishSeed.get(sc.label);
      if (!seed) return sc;
      // Fixed window centred on the room's own label seed.
      const bboxPt: PtBox = {
        x0: seed.x - CROP_HALF_PT,
        y0: seed.y - CROP_HALF_PT,
        x1: seed.x + CROP_HALF_PT,
        y1: seed.y + CROP_HALF_PT,
      };
      try {
        const v = await verifyRoomFinish({
          pdfBuffer,
          pageNumber,
          label: sc.label,
          bboxPt,
        });
        verdicts.push(v);
        const aiPaint = v.isPaint;
        const detPaint = sc.decision === "paint";

        // Agreement always confirms and clears the flag.
        if (aiPaint === detPaint) {
          return {
            ...sc,
            confidence: Math.min(0.95, sc.confidence + 0.3),
            needsReview: false,
            reason: `${sc.reason} — AI confirmed ${v.finish} (${v.confidence.toFixed(2)})`,
          };
        }

        // Disagreement. The AI may OVERRIDE only weak deterministic bases
        // (`tag`/`default`). For `note`/`category` rooms the deterministic call
        // is more reliable than the model's read of a finish/elevation crop
        // (which often shows a feature wall, not the room's scoped finish), so
        // the AI is advisory: record the dissent, keep the decision.
        const canOverride = sc.basis === "tag" || sc.basis === "default";
        if (canOverride && v.confidence >= 0.6) {
          return {
            ...sc,
            decision: (aiPaint ? "paint" : "excluded") as ScopeDecision,
            confidence: v.confidence,
            needsReview: false,
            reason: `AI override (weak ${sc.basis}): walls read as ${v.finish} (${v.confidence.toFixed(2)}) — ${v.reasoning}`,
          };
        }
        return {
          ...sc,
          reason: `${sc.reason} — AI saw ${v.finish} (${v.confidence.toFixed(2)}, advisory; ${sc.basis} basis kept)`,
        };
      } catch (err) {
        return {
          ...sc,
          reason: `${sc.reason} — AI fallback failed: ${(err as Error).message}`,
        };
      }
    }),
  );

  return { scopes: updated, verdicts };
}
