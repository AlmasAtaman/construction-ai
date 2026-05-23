"use client";

import { useEffect, useRef, useState } from "react";
import { useEditorStore } from "@/lib/store/editor-store";
import {
  FINISH_TYPE_LABELS,
  HEIGHT_BASIS_LABELS,
  type FinishType,
  type HeightBasis,
  type SurfaceDTO,
  type SurfaceDerivation,
} from "@/types/surface";
import { cn } from "@/lib/utils";

/** Quick-fill height (ft) for a basis preset; user can still override. */
function presetHeightFt(
  basis: HeightBasis,
  ceiling: number,
  current: number | null,
): number {
  if (basis === "ceiling") return ceiling;
  if (basis === "13ft") return 13;
  if (basis === "deck") return 16; // typical; editable
  return current && current > 0 ? current : ceiling; // custom
}

const TYPE_OPTIONS = [
  { value: "wall", label: "Wall" },
  { value: "wall-path", label: "Wall path" },
  { value: "ceiling", label: "Ceiling" },
  { value: "trim", label: "Trim" },
  { value: "door", label: "Door" },
  { value: "window", label: "Window" },
];

const SUBSTRATE_OPTIONS = [
  "drywall",
  "wood",
  "metal",
  "concrete",
  "CMU",
  "acoustic_tile",
  "exposed_structure",
  "unknown",
];

interface Props {
  surface: SurfaceDTO | null;
  /** All known room labels for the project (for quick reassignment). */
  knownRoomLabels: string[];
  onClose: () => void;
}

/**
 * Inline editor for a single surface. The fastest path for an estimator
 * to correct an AI mis-detection without re-running the whole takeoff.
 *
 * Editable fields:
 *  - Room label (free text + autocomplete from known labels)
 *  - Surface type (wall/ceiling/trim/door/window)
 *  - Substrate
 *  - Quantity (sqft for wall/ceiling, lf for trim, count for door/window)
 *  - Paint type + coats
 *
 * Saves via PATCH /api/surfaces/[id]. Optimistic update on the local
 * store; rolls back on error.
 */
interface PageContext {
  scale: { ptPerFoot: number; method: string; label: string } | null;
  ceilingHeightFt: number;
  // Page geometry — lets the wall-path breakdown convert normalized
  // path coordinates to exact per-segment feet.
  pageWidthPt: number | null;
  pageHeightPt: number | null;
}

const DERIVATION_LABELS: Record<SurfaceDerivation, { label: string; cls: string; tip: string }> = {
  "scale-measured": {
    label: "Scale-measured",
    cls: "bg-emerald-50 text-emerald-700 border-emerald-200",
    tip: "Derived from the PDF's vector geometry × the plan's scale.",
  },
  "table-cross-checked": {
    label: "Table ✓ scale",
    cls: "bg-emerald-50 text-emerald-800 border-emerald-300",
    tip: "Printed dimensions and scale-measured geometry agree within ±10 %.",
  },
  traced: {
    label: "Traced",
    cls: "bg-sky-50 text-sky-700 border-sky-200",
    tip: "Boundary traced from real walls. Dimensions from the printed table.",
  },
  "sized-from-dimensions": {
    label: "Sized from dims",
    cls: "bg-amber-50 text-amber-800 border-amber-200",
    tip: "Rectangle sized from the printed dimensions, anchored to the label.",
  },
  "table-only": {
    label: "Table only",
    cls: "bg-slate-100 text-slate-600 border-slate-300",
    tip: "From the printed schedule. No on-plan placement available.",
  },
  "virtual-partition": {
    label: "Estimated boundary",
    cls: "bg-amber-50 text-amber-800 border-amber-300",
    tip: "Open-plan room — the boundary was computed by partitioning the open zone between nearby labels. Snapped to real walls where they exist. Review before bidding.",
  },
  "scale-needed": {
    label: "Scale needed",
    cls: "bg-orange-50 text-orange-800 border-orange-300",
    tip: "Set the plan scale to measure this room.",
  },
  "geometry-uncertain": {
    label: "Geometry uncertain",
    cls: "bg-orange-50 text-orange-800 border-orange-300",
    tip: "Found the label, but the extracted boundary isn't trustworthy. Enter the dimension manually.",
  },
  "ai-fallback": {
    label: "AI guess",
    cls: "bg-rose-50 text-rose-700 border-rose-200",
    tip: "AI named this room but the engine couldn't measure it.",
  },
  manual: {
    label: "Drawn",
    cls: "bg-slate-100 text-slate-700 border-slate-300",
    tip: "You drew this surface by hand.",
  },
};

function MeasurementBreakdown({
  surface,
  ctx,
}: {
  surface: SurfaceDTO;
  ctx: PageContext | null;
}) {
  const derivation = (surface.derivation ?? "ai-fallback") as SurfaceDerivation;
  const meta = DERIVATION_LABELS[derivation];
  const isWallPath = surface.type === "wall-path";
  const isWall = surface.type === "wall";
  const isCeiling = surface.type === "ceiling";
  const ceiling = ctx?.ceilingHeightFt ?? 9;
  const lf = surface.linearFootage;
  const sqft = surface.squareFootage;
  const hasMeasurement =
    (isWallPath && (lf != null || sqft != null)) ||
    (isWall && (lf != null || sqft != null)) ||
    (isCeiling && sqft != null) ||
    (!isWallPath && !isWall && !isCeiling && surface.count != null);

  // Wall-path: per-segment derivation table. A segment is exact when
  // BOTH endpoints snapped to extracted wall geometry; it's approximate
  // when either endpoint was a free-click. Lengths are computed in PDF
  // pt then divided by ptPerFoot — exact arithmetic, rounded only here.
  const wallPathSegments = (():
    | {
        idx: number;
        lengthFt: number | null;
        basis: "exact" | "approx";
        fromSnap: string;
        toSnap: string;
      }[]
    | null => {
    if (!isWallPath || !surface.pathPoints || surface.pathPoints.length < 2)
      return null;
    const pts = surface.pathPoints;
    const ptPerFoot = ctx?.scale?.ptPerFoot ?? null;
    const wPt = ctx?.pageWidthPt ?? null;
    const hPt = ctx?.pageHeightPt ?? null;
    const out: {
      idx: number;
      lengthFt: number | null;
      basis: "exact" | "approx";
      fromSnap: string;
      toSnap: string;
    }[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      let lengthFt: number | null = null;
      if (ptPerFoot && ptPerFoot > 0 && wPt && hPt) {
        const dxPt = (b.x - a.x) * wPt;
        const dyPt = (b.y - a.y) * hPt;
        lengthFt = Math.hypot(dxPt, dyPt) / ptPerFoot;
      }
      const basis: "exact" | "approx" =
        a.snap !== "free" && b.snap !== "free" ? "exact" : "approx";
      out.push({ idx: i + 1, lengthFt, basis, fromSnap: a.snap, toSnap: b.snap });
    }
    return out;
  })();

  return (
    <div className="mt-3 rounded-[6px] border border-[hsl(var(--line))] bg-[hsl(var(--panel-2))] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-[hsl(var(--ink-3))]">
          How this number was produced
        </span>
        {meta && (
          <span
            title={meta.tip}
            className={cn(
              "rounded border px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wide",
              meta.cls,
            )}
          >
            {meta.label}
          </span>
        )}
      </div>

      {!hasMeasurement ? (
        <p className="text-[12px] text-orange-700">
          <strong>Needs measurement.</strong> The engine couldn&rsquo;t produce a
          reliable size for this surface. Set the dimension in the quantity
          field below to add it to the bid.
        </p>
      ) : (
        <div className="space-y-1 text-[12px] text-[hsl(var(--ink-2))]">
          {isWallPath && (
            <>
              {lf != null && (
                <div className="num">
                  Traced length:{" "}
                  <span className="font-semibold text-[hsl(var(--ink))]">
                    {lf.toFixed(1)} lf
                  </span>
                </div>
              )}
              <div className="num">
                Ceiling height:{" "}
                <span className="font-semibold text-[hsl(var(--ink))]">
                  {ceiling.toFixed(1)} ft
                </span>
              </div>
              {sqft != null && lf != null && (
                <div className="num pt-0.5">
                  Wall area:{" "}
                  <span className="font-semibold text-[hsl(var(--ink))]">
                    {sqft.toFixed(1)} sqft
                  </span>{" "}
                  <span className="text-[hsl(var(--ink-3))]">
                    = {lf.toFixed(1)} lf × {ceiling.toFixed(1)} ft
                  </span>
                </div>
              )}
              {wallPathSegments && (
                <div className="mt-2 border-t border-[hsl(var(--line))] pt-2">
                  <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[hsl(var(--ink-3))]">
                    Per-segment ({wallPathSegments.length})
                  </div>
                  <div className="max-h-40 space-y-0.5 overflow-y-auto">
                    {wallPathSegments.map((s) => (
                      <div
                        key={s.idx}
                        className="num flex items-center justify-between gap-2 text-[11px]"
                      >
                        <span className="text-[hsl(var(--ink-3))]">#{s.idx}</span>
                        <span className="flex-1 text-right text-[hsl(var(--ink))]">
                          {s.lengthFt != null ? `${s.lengthFt.toFixed(2)} ft` : "—"}
                        </span>
                        <span
                          title={
                            s.basis === "exact"
                              ? "Both endpoints snapped to extracted wall geometry — exact."
                              : `Contains a free-click endpoint (${s.fromSnap}→${s.toSnap}) — not snapped to extracted geometry, approximate.`
                          }
                          className={cn(
                            "rounded border px-1 py-0 text-[9px] font-semibold uppercase",
                            s.basis === "exact"
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                              : "border-amber-200 bg-amber-50 text-amber-800",
                          )}
                        >
                          {s.basis === "exact" ? "snapped" : "free-click"}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-1 text-[10px] text-[hsl(var(--ink-3))]">
                    &ldquo;Snapped&rdquo; segments sit exactly on extracted wall
                    faces. &ldquo;Free-click&rdquo; segments were placed by hand
                    where no wall was detected — verify those against the plan.
                  </p>
                </div>
              )}
            </>
          )}
          {isWall && (
            <>
              {lf != null && (
                <div className="num">
                  Wall length:{" "}
                  <span className="font-semibold text-[hsl(var(--ink))]">
                    {lf.toFixed(1)} lf
                  </span>
                </div>
              )}
              <div className="num">
                Ceiling height:{" "}
                <span className="font-semibold text-[hsl(var(--ink))]">
                  {ceiling.toFixed(1)} ft
                </span>{" "}
                <span className="text-[hsl(var(--ink-3))]">
                  (set per-project in the worksheet)
                </span>
              </div>
              {sqft != null && lf != null && (
                <div className="num pt-0.5">
                  Wall area:{" "}
                  <span className="font-semibold text-[hsl(var(--ink))]">
                    {sqft.toFixed(1)} sqft
                  </span>{" "}
                  <span className="text-[hsl(var(--ink-3))]">
                    = {lf.toFixed(1)} lf × {ceiling.toFixed(1)} ft
                  </span>
                </div>
              )}
            </>
          )}
          {isCeiling && sqft != null && (
            <div className="num">
              Floor / ceiling area:{" "}
              <span className="font-semibold text-[hsl(var(--ink))]">
                {sqft.toFixed(1)} sqft
              </span>
            </div>
          )}
          {!isWall && !isCeiling && surface.linearFootage != null && (
            <div className="num">
              Linear feet:{" "}
              <span className="font-semibold text-[hsl(var(--ink))]">
                {surface.linearFootage.toFixed(1)} lf
              </span>
            </div>
          )}
          {!isWall && !isCeiling && surface.count != null && (
            <div className="num">
              Count:{" "}
              <span className="font-semibold text-[hsl(var(--ink))]">
                {surface.count}
              </span>
            </div>
          )}
        </div>
      )}

      <div className="mt-2 border-t border-[hsl(var(--line))] pt-2 text-[11px] text-[hsl(var(--ink-3))]">
        {ctx?.scale ? (
          <>
            Plan scale:{" "}
            <span className="text-[hsl(var(--ink-2))]">
              {ctx.scale.label}
            </span>{" "}
            ({ctx.scale.method === "user" ? "set by you" : ctx.scale.method}, {ctx.scale.ptPerFoot.toFixed(2)} pt/ft)
          </>
        ) : (
          <span className="text-orange-700">
            No scale established on this page — set the scale in the banner
            above the plan to enable measurements.
          </span>
        )}
      </div>
    </div>
  );
}

export function SurfaceEditDialog({ surface, knownRoomLabels, onClose }: Props) {
  const updateSurface = useEditorStore((s) => s.updateSurface);
  const [draft, setDraft] = useState<Partial<SurfaceDTO>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageCtx, setPageCtx] = useState<PageContext | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  // Fetch the page's scale + project's ceiling height so the breakdown
  // panel can show "X lf × Y ft ceiling = Z sqft" with real values.
  useEffect(() => {
    if (!surface) return;
    let cancelled = false;
    async function load() {
      try {
        const [scaleRes, projRes] = await Promise.all([
          fetch(`/api/plan-pages/${surface!.planPageId}/scale`, {
            cache: "no-store",
          }),
          fetch(`/api/projects/${surface!.projectId}`, { cache: "no-store" }),
        ]);
        const scaleJson = scaleRes.ok
          ? ((await scaleRes.json()) as {
              scale: { ptPerFoot: number; method: string; label: string } | null;
              pageWidthPt?: number | null;
              pageHeightPt?: number | null;
            })
          : { scale: null, pageWidthPt: null, pageHeightPt: null };
        const projJson = projRes.ok
          ? ((await projRes.json()) as {
              project: { ceilingHeightFt?: number } | null;
            })
          : { project: null };
        if (cancelled) return;
        setPageCtx({
          scale: scaleJson.scale,
          ceilingHeightFt: projJson.project?.ceilingHeightFt ?? 9,
          pageWidthPt: scaleJson.pageWidthPt ?? null,
          pageHeightPt: scaleJson.pageHeightPt ?? null,
        });
      } catch {
        if (!cancelled)
          setPageCtx({
            scale: null,
            ceilingHeightFt: 9,
            pageWidthPt: null,
            pageHeightPt: null,
          });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [surface]);

  useEffect(() => {
    if (surface) {
      setDraft({
        roomLabel: surface.roomLabel,
        type: surface.type,
        substrate: surface.substrate,
        squareFootage: surface.squareFootage,
        linearFootage: surface.linearFootage,
        count: surface.count,
        paintType: surface.paintType,
        coats: surface.coats,
        finishType: surface.finishType,
        wallHeightFt: surface.wallHeightFt,
        heightBasis: surface.heightBasis,
      });
      setError(null);
      // Auto-focus room label for fast keyboard edit.
      setTimeout(() => firstFieldRef.current?.focus(), 50);
    }
  }, [surface]);

  if (!surface) return null;

  const qtyField =
    draft.type === "trim"
      ? "linearFootage"
      : draft.type === "door" || draft.type === "window"
        ? "count"
        : "squareFootage";

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      // Only send fields that actually changed.
      const patch: Record<string, unknown> = {};
      if (draft.roomLabel !== surface!.roomLabel)
        patch.roomLabel = draft.roomLabel;
      if (draft.type !== surface!.type) patch.type = draft.type;
      if (draft.substrate !== surface!.substrate)
        patch.substrate = draft.substrate;
      if (draft.squareFootage !== surface!.squareFootage)
        patch.squareFootage = draft.squareFootage ?? null;
      if (draft.linearFootage !== surface!.linearFootage)
        patch.linearFootage = draft.linearFootage ?? null;
      if (draft.count !== surface!.count) patch.count = draft.count ?? null;
      if (draft.paintType !== surface!.paintType)
        patch.paintType = draft.paintType ?? null;
      if (draft.coats !== surface!.coats) patch.coats = draft.coats;

      // Wall-path finish + height. Area is DERIVED from length × height,
      // so changing either re-computes squareFootage.
      if (surface!.type === "wall-path") {
        if (draft.finishType !== surface!.finishType)
          patch.finishType = draft.finishType ?? null;
        if (draft.heightBasis !== surface!.heightBasis)
          patch.heightBasis = draft.heightBasis ?? null;
        if (draft.wallHeightFt !== surface!.wallHeightFt)
          patch.wallHeightFt = draft.wallHeightFt ?? null;
        const lf = draft.linearFootage ?? surface!.linearFootage;
        const h = draft.wallHeightFt ?? surface!.wallHeightFt;
        if (lf != null && h != null) {
          const recomputed = lf * h;
          if (recomputed !== surface!.squareFootage)
            patch.squareFootage = recomputed;
        }
      }

      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }

      const res = await fetch(`/api/surfaces/${surface!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({ error: "Save failed." }));
        setError(j.error ?? "Save failed.");
        return;
      }
      // Optimistic local update.
      updateSurface(surface!.id, patch as Partial<SurfaceDTO>);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-label="Edit surface"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-[10px] border border-[hsl(var(--line))] bg-white p-5 shadow-xl"
      >
        <h3 className="text-[14px] font-semibold text-[hsl(var(--ink-1))]">
          Edit surface
        </h3>
        <p className="text-[11px] text-[hsl(var(--ink-3))]">
          Adjust the room name, type, or quantity. Changes save immediately.
        </p>

        {error && (
          <div className="mt-3 rounded-[6px] border border-red-200 bg-red-50 p-2 text-[11px] text-red-700">
            {error}
          </div>
        )}

        <MeasurementBreakdown surface={surface} ctx={pageCtx} />

        <div className="mt-4 space-y-3">
          {/* Room label with datalist autocomplete */}
          <label className="block">
            <span className="block text-[11px] font-medium text-[hsl(var(--ink-2))]">
              Room
            </span>
            <input
              ref={firstFieldRef}
              type="text"
              list="known-rooms"
              value={draft.roomLabel ?? ""}
              onChange={(e) => setDraft({ ...draft, roomLabel: e.target.value })}
              className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px]"
              placeholder="e.g. Kitchen, Master Bath, Corridor CE-3"
            />
            <datalist id="known-rooms">
              {knownRoomLabels.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </label>

          {/* Surface type */}
          <label className="block">
            <span className="block text-[11px] font-medium text-[hsl(var(--ink-2))]">
              Type
            </span>
            <select
              value={draft.type ?? "wall"}
              onChange={(e) =>
                setDraft({ ...draft, type: e.target.value as SurfaceDTO["type"] })
              }
              className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px]"
            >
              {TYPE_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>

          {/* Wall-path: finish scope + per-wall height (drives area) */}
          {draft.type === "wall-path" && (
            <>
              <label className="block">
                <span className="block text-[11px] font-medium text-[hsl(var(--ink-2))]">
                  Finish (paint scope)
                </span>
                <select
                  value={draft.finishType ?? "paint"}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      finishType: e.target.value as FinishType,
                    })
                  }
                  className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px]"
                >
                  {(Object.keys(FINISH_TYPE_LABELS) as FinishType[]).map((v) => (
                    <option key={v} value={v}>
                      {FINISH_TYPE_LABELS[v]}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="block text-[11px] font-medium text-[hsl(var(--ink-2))]">
                    Wall height
                  </span>
                  <select
                    value={draft.heightBasis ?? "ceiling"}
                    onChange={(e) => {
                      const basis = e.target.value as HeightBasis;
                      setDraft({
                        ...draft,
                        heightBasis: basis,
                        wallHeightFt: presetHeightFt(
                          basis,
                          pageCtx?.ceilingHeightFt ?? 9,
                          draft.wallHeightFt ?? null,
                        ),
                      });
                    }}
                    className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px]"
                  >
                    {(Object.keys(HEIGHT_BASIS_LABELS) as HeightBasis[]).map(
                      (v) => (
                        <option key={v} value={v}>
                          {HEIGHT_BASIS_LABELS[v]}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label className="block">
                  <span className="block text-[11px] font-medium text-[hsl(var(--ink-2))]">
                    Height (ft)
                  </span>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    value={draft.wallHeightFt ?? ""}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        wallHeightFt:
                          e.target.value === "" ? null : Number(e.target.value),
                        heightBasis: "custom",
                      })
                    }
                    className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px] tabular-nums"
                  />
                </label>
              </div>
              {draft.linearFootage != null && draft.wallHeightFt != null && (
                <div className="rounded-[6px] bg-[hsl(var(--panel-2))] px-2 py-1.5 text-[11px] text-[hsl(var(--ink-3))]">
                  Area = {draft.linearFootage.toFixed(1)} lf ×{" "}
                  {draft.wallHeightFt.toFixed(1)} ft ={" "}
                  <span className="font-semibold text-[hsl(var(--ink))]">
                    {Math.round(draft.linearFootage * draft.wallHeightFt)} sqft
                  </span>
                  {draft.finishType && draft.finishType !== "paint" && (
                    <span className="ml-1 text-amber-700">
                      · not billed as paint
                    </span>
                  )}
                </div>
              )}
            </>
          )}

          {/* Substrate */}
          <label className="block">
            <span className="block text-[11px] font-medium text-[hsl(var(--ink-2))]">
              Substrate
            </span>
            <select
              value={draft.substrate ?? "drywall"}
              onChange={(e) =>
                setDraft({ ...draft, substrate: e.target.value })
              }
              className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px]"
            >
              {SUBSTRATE_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>

          {/* Quantity (varies by type). Wall-paths derive area from
              height above, so the manual quantity field is hidden for them. */}
          {draft.type !== "wall-path" && (
            <label className="block">
              <span className="block text-[11px] font-medium text-[hsl(var(--ink-2))]">
                {qtyField === "squareFootage"
                  ? "Area (sqft)"
                  : qtyField === "linearFootage"
                    ? "Linear feet"
                    : "Count"}
              </span>
              <input
                type="number"
                step={qtyField === "count" ? 1 : 0.1}
                min="0"
                value={(draft[qtyField] as number | null) ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    [qtyField]:
                      e.target.value === "" ? null : Number(e.target.value),
                  })
                }
                className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px] tabular-nums"
              />
            </label>
          )}

          {/* Paint type + coats (for paintable surfaces) */}
          {draft.type !== "door" && draft.type !== "window" && (
            <div className="grid grid-cols-3 gap-2">
              <label className="col-span-2 block">
                <span className="block text-[11px] font-medium text-[hsl(var(--ink-2))]">
                  Paint type
                </span>
                <input
                  type="text"
                  value={draft.paintType ?? ""}
                  onChange={(e) =>
                    setDraft({ ...draft, paintType: e.target.value })
                  }
                  placeholder="e.g. Eggshell, Semi-gloss"
                  className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px]"
                />
              </label>
              <label className="block">
                <span className="block text-[11px] font-medium text-[hsl(var(--ink-2))]">
                  Coats
                </span>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={draft.coats ?? 2}
                  onChange={(e) =>
                    setDraft({ ...draft, coats: Number(e.target.value) })
                  }
                  className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px] tabular-nums"
                />
              </label>
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[6px] border border-[hsl(var(--line))] px-3 py-1.5 text-[12px] font-medium text-[hsl(var(--ink-1))]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className={cn(
              "rounded-[6px] bg-[hsl(var(--brand))] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50",
            )}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
