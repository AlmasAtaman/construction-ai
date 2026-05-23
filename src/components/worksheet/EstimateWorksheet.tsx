"use client";

import { useEffect, useMemo, useState } from "react";
import { useEditorStore } from "@/lib/store/editor-store";
import {
  buildProjectConfig,
  calculateBid,
  DEFAULT_CONFIG,
  type BidConfig,
} from "@/lib/math/bid-calculator";
import { formatCurrency } from "@/lib/utils";
import type { SurfaceDTO, SurfaceType } from "@/types/surface";

interface Props {
  projectId: string;
}

const TYPE_LABELS: Record<SurfaceType, string> = {
  wall: "Wall",
  ceiling: "Ceiling",
  trim: "Trim",
  door: "Door",
  window: "Window",
  "wall-path": "Wall path",
};

export function EstimateWorksheet({ projectId }: Props) {
  const surfaces = useEditorStore((s) => s.surfaces);
  const setSurfaces = useEditorStore((s) => s.setSurfaces);
  const [config, setConfig] = useState<BidConfig>(DEFAULT_CONFIG);
  const [ceilingHeightFt, setCeilingHeightFt] = useState<number>(9);
  const [loading, setLoading] = useState(true);
  const [detailed, setDetailed] = useState(false);
  const [savingCeiling, setSavingCeiling] = useState(false);
  const [pendingAccepted, setPendingAccepted] = useState<{
    count: number;
    nextHeight: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [ratesRes, projectRes] = await Promise.all([
          fetch("/api/settings/rates", { cache: "no-store" }),
          fetch(`/api/projects/${projectId}`, { cache: "no-store" }),
        ]);
        const ratesJson = ratesRes.ok ? await ratesRes.json() : { rates: [] };
        const projectJson = projectRes.ok
          ? await projectRes.json()
          : { project: null };
        if (cancelled) return;

        if (!projectJson.project) {
          setConfig(DEFAULT_CONFIG);
          return;
        }

        setConfig(
          buildProjectConfig({
            project: {
              measurementMode: projectJson.project.measurementMode ?? "net",
              wasteFactor:
                projectJson.project.wasteFactor ?? DEFAULT_CONFIG.wasteFactor,
              markup: projectJson.project.markup ?? DEFAULT_CONFIG.markup,
              overheadPct:
                projectJson.project.overheadPct ?? DEFAULT_CONFIG.overheadPct,
            },
            rates: ratesJson.rates ?? [],
          }),
        );
        setCeilingHeightFt(projectJson.project.ceilingHeightFt ?? 9);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    function onChange() {
      void load();
    }
    window.addEventListener("settings-changed", onChange);
    return () => {
      cancelled = true;
      window.removeEventListener("settings-changed", onChange);
    };
  }, [projectId]);

  const bid = useMemo(() => calculateBid(surfaces, config), [surfaces, config]);

  async function refreshSurfaces() {
    try {
      const res = await fetch(`/api/surfaces?projectId=${projectId}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const j = (await res.json()) as { surfaces: SurfaceDTO[] };
      setSurfaces(j.surfaces);
    } catch {
      /* ignore */
    }
  }

  async function patchCeiling(
    nextHeight: number,
    opts: { recomputeAccepted: boolean },
  ): Promise<{
    affectedAcceptedCount: number;
    recomputedProposedCount: number;
    recomputedAcceptedCount: number;
  } | null> {
    setSavingCeiling(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ceilingHeightFt: nextHeight,
          recomputeProposedWalls: true,
          recomputeAcceptedWalls: opts.recomputeAccepted,
        }),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as {
        affectedAcceptedCount: number;
        recomputedProposedCount: number;
        recomputedAcceptedCount: number;
      };
      await refreshSurfaces();
      window.dispatchEvent(new Event("settings-changed"));
      return j;
    } finally {
      setSavingCeiling(false);
    }
  }

  async function saveCeiling(nextHeight: number) {
    const result = await patchCeiling(nextHeight, { recomputeAccepted: false });
    if (!result) return;
    setCeilingHeightFt(nextHeight);
    if (result.affectedAcceptedCount > 0) {
      setPendingAccepted({
        count: result.affectedAcceptedCount,
        nextHeight,
      });
    }
  }

  async function updateAcceptedWalls() {
    if (!pendingAccepted) return;
    await patchCeiling(pendingAccepted.nextHeight, {
      recomputeAccepted: true,
    });
    setPendingAccepted(null);
  }

  if (loading) {
    return (
      <div className="px-4 py-3 text-[12px] text-[hsl(var(--ink-3))]">
        Loading worksheet…
      </div>
    );
  }

  if (bid.lineItems.length === 0) {
    return (
      <div className="px-4 py-4 text-[13px] text-[hsl(var(--ink-3))]">
        Rooms will appear here after you measure or draw them.
      </div>
    );
  }

  // Columns: compact by default (Room · Type · Qty · Cost), full breakdown
  // behind the "Details" toggle. nCols drives footer colSpans.
  const nCols = detailed ? 9 : 4;
  return (
    <div className="overflow-x-auto" data-testid="worksheet">
      <div className="flex items-center gap-3 border-b border-[hsl(var(--line))] bg-[hsl(var(--panel-2))] px-4 py-2">
        <CeilingHeightControl
          valueFt={ceilingHeightFt}
          saving={savingCeiling}
          onSave={saveCeiling}
        />
        <button
          type="button"
          onClick={() => setDetailed((v) => !v)}
          data-testid="worksheet-details-toggle"
          className="ml-auto rounded border border-[hsl(var(--line))] bg-white px-2 py-0.5 text-[11px] font-medium text-[hsl(var(--ink-2))] hover:bg-white"
        >
          {detailed ? "Hide details" : "Show details"}
        </button>
      </div>
      {pendingAccepted && (
        <AcceptedSurfacesPrompt
          count={pendingAccepted.count}
          nextHeight={pendingAccepted.nextHeight}
          onConfirm={() => void updateAcceptedWalls()}
          onDismiss={() => setPendingAccepted(null)}
        />
      )}
      <table className="sheet">
        <thead>
          <tr>
            <th className="w-[24%]">Room</th>
            <th className="w-[12%]">Type</th>
            {detailed && <th className="w-[16%]">Paint</th>}
            {detailed && <th className="w-[6%] text-right">Coats</th>}
            <th className="text-right">Size</th>
            {detailed && (
              <th className="text-right" title="Painting speed — square feet per hour">
                Speed
              </th>
            )}
            {detailed && <th className="text-right">Hours</th>}
            {detailed && <th className="text-right">Paint $</th>}
            <th className="text-right">{detailed ? "Labor $" : "Cost"}</th>
          </tr>
        </thead>
        <tbody>
          {bid.lineItems.map((li) => {
            // quantity 0 with a null measurement = a row that genuinely
            // needs a size set, not a real $0 line. Flag it distinctly.
            const s = surfaces.find((s) => s.id === li.surfaceId);
            const needsMeasurement =
              s != null &&
              li.quantity === 0 &&
              ((li.unit === "sqft" && s.squareFootage == null) ||
                (li.unit === "lf" && s.linearFootage == null) ||
                (li.unit === "ea" && s.count == null));
            const rowCost = li.materialCost + li.laborCost;
            return (
              <tr key={li.surfaceId} data-testid="worksheet-row">
                <td className="font-medium text-[hsl(var(--ink))]">
                  {li.roomLabel ?? "—"}
                </td>
                <td className="text-[hsl(var(--ink-2))]">
                  {TYPE_LABELS[li.type]}
                </td>
                {detailed && (
                  <td className="text-[hsl(var(--ink-2))]">
                    {li.paintType ?? (
                      <span className="text-[hsl(var(--ink-3))]">—</span>
                    )}
                  </td>
                )}
                {detailed && <td className="num text-right">{li.coats}</td>}
                <td className="num text-right">
                  {needsMeasurement ? (
                    <span
                      className="text-[10px] font-semibold uppercase tracking-wide text-orange-700"
                      title="The engine couldn't measure this — set its size in the queue. Not in the bid until then."
                    >
                      Needs size
                    </span>
                  ) : (
                    <>
                      {Math.round(li.quantity)} {li.unit}
                    </>
                  )}
                </td>
                {detailed && (
                  <td className="num text-right text-[hsl(var(--ink-3))]">
                    {li.productionRate.toFixed(0)} {li.unit}/h
                  </td>
                )}
                {detailed && (
                  <td className="num text-right text-[hsl(var(--ink-2))]">
                    {needsMeasurement ? "—" : li.laborHours.toFixed(1)}
                  </td>
                )}
                {detailed && (
                  <td className="num text-right">
                    {needsMeasurement ? (
                      <span className="text-[hsl(var(--ink-3))]">—</span>
                    ) : (
                      formatCurrency(li.materialCost)
                    )}
                  </td>
                )}
                <td className="num text-right font-medium">
                  {needsMeasurement ? (
                    <span className="text-[hsl(var(--ink-3))]">—</span>
                  ) : (
                    formatCurrency(detailed ? li.laborCost : rowCost)
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot
          className="bg-[hsl(var(--panel-2))] text-[hsl(var(--ink))]"
          data-testid="worksheet-totals"
        >
          {detailed && (
            <tr>
              <td colSpan={7} className="text-right text-[12px] font-medium text-[hsl(var(--ink-2))]">
                Subtotal
              </td>
              <td className="num text-right">{formatCurrency(bid.totalMaterial)}</td>
              <td className="num text-right">{formatCurrency(bid.totalLabor)}</td>
            </tr>
          )}
          {!detailed && (
            <tr>
              <td colSpan={nCols - 1} className="text-right text-[12px] font-medium text-[hsl(var(--ink-2))]">
                Subtotal
              </td>
              <td className="num text-right">{formatCurrency(bid.subtotal)}</td>
            </tr>
          )}
          <tr>
            <td colSpan={nCols - 1} className="text-right text-[12px] font-medium text-[hsl(var(--ink-2))]">
              Overhead
            </td>
            <td className="num text-right" data-testid="worksheet-overhead">
              {formatCurrency(bid.totalOverhead)}
            </td>
          </tr>
          <tr>
            <td colSpan={nCols - 1} className="text-right text-[12px] font-medium text-[hsl(var(--ink-2))]">
              Markup
            </td>
            <td className="num text-right">{formatCurrency(bid.totalMarkup)}</td>
          </tr>
          <tr className="border-t-2 border-[hsl(var(--ink))]">
            <td colSpan={nCols - 1} className="py-2.5 text-right text-[13px] font-bold uppercase tracking-wide text-[hsl(var(--ink))]">
              Grand Total
            </td>
            <td
              className="num py-2.5 text-right text-[16px] font-bold text-[hsl(var(--ink))]"
              data-testid="worksheet-grand-total"
            >
              {formatCurrency(bid.grandTotal)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function CeilingHeightControl({
  valueFt,
  saving,
  onSave,
}: {
  valueFt: number;
  saving: boolean;
  onSave: (next: number) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<string>(valueFt.toString());
  useEffect(() => {
    setDraft(valueFt.toString());
  }, [valueFt]);
  const dirty = parseFloat(draft) !== valueFt && draft !== "";

  return (
    <div className="flex items-center gap-3 text-[12px]">
      <label className="flex items-center gap-2">
        <span className="text-[hsl(var(--ink-2))]">Ceiling height:</span>
        <input
          type="number"
          step="0.5"
          min="6"
          max="30"
          value={draft}
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const n = parseFloat(draft);
              if (Number.isFinite(n) && n >= 6 && n <= 30) {
                void onSave(n);
              }
            }
          }}
          className="num w-16 rounded border border-[hsl(var(--line))] bg-white px-2 py-0.5 text-right tabular-nums"
        />
        <span className="text-[hsl(var(--ink-3))]">ft</span>
      </label>
      <span className="text-[11px] text-[hsl(var(--ink-3))]">
        Default wall height — override per wall in its edit panel.
      </span>
      {dirty && (
        <button
          onClick={() => {
            const n = parseFloat(draft);
            if (Number.isFinite(n) && n >= 6 && n <= 30) void onSave(n);
          }}
          disabled={saving}
          className="ml-auto rounded border border-[hsl(var(--brand))] bg-[hsl(var(--brand))] px-2 py-0.5 text-[11px] font-medium text-white disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      )}
    </div>
  );
}

function AcceptedSurfacesPrompt({
  count,
  nextHeight,
  onConfirm,
  onDismiss,
}: {
  count: number;
  nextHeight: number;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      data-testid="ceiling-accepted-prompt"
      className="flex items-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-[12px] text-amber-900"
    >
      <strong>{count}</strong>
      <span>
        accepted / hand-drawn wall{count === 1 ? "" : "s"}{" "}
        {count === 1 ? "uses" : "use"} the old ceiling height. Recompute
        with the new {nextHeight.toFixed(1)} ft ceiling?
      </span>
      <button
        onClick={onConfirm}
        className="ml-auto rounded border border-amber-700 bg-amber-700 px-2 py-0.5 text-[11px] font-medium text-white"
      >
        Update them
      </button>
      <button
        onClick={onDismiss}
        className="rounded border border-amber-300 px-2 py-0.5 text-[11px] font-medium text-amber-900"
      >
        Leave them
      </button>
    </div>
  );
}
