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
import {
  FINISH_TYPE_LABELS,
  FINISH_TYPE_COLORS,
  PAINTABLE_FINISHES,
  type FinishType,
  type SurfaceDTO,
  type SurfaceType,
} from "@/types/surface";

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

  // Publish the live rollup so the workflow spine and the collapsed
  // estimate bar can show money without recomputing the bid.
  const setEstimateSummary = useEditorStore((s) => s.setEstimateSummary);
  useEffect(() => {
    const paintSqft = bid.lineItems
      .filter((li) => li.type === "wall-path" && li.unit === "sqft")
      .reduce((a, li) => a + li.quantity, 0);
    setEstimateSummary({
      grandTotal: bid.grandTotal,
      lineItems: bid.lineItems.length,
      paintSqft: paintSqft > 0 ? paintSqft : null,
    });
  }, [bid, setEstimateSummary]);

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
      <ScopeSummary surfaces={surfaces} />
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

/**
 * Wall-scope rollup, grouped by finish then room — mirrors how a
 * contractor's takeoff tree reads (e.g. "Paint walls — Overstock 840 sq
 * ft, Sales 1,541 sq ft" + tracked-only FRP/tile/glazing). Reads surfaces
 * directly (not bid line items) so it can show the non-billed finishes the
 * bid math skips. Only shown when wall-path traces exist.
 */
function ScopeSummary({ surfaces }: { surfaces: SurfaceDTO[] }) {
  // Same rule as the bid math: unreviewed proposals are not scope yet.
  const walls = surfaces.filter(
    (s) =>
      s.type === "wall-path" &&
      s.status !== "excluded" &&
      s.status !== "proposed",
  );
  if (walls.length === 0) return null;

  // finish → room → { sqft, lf, count }
  const byFinish = new Map<
    FinishType,
    Map<string, { sqft: number; lf: number; count: number }>
  >();
  for (const s of walls) {
    const finish = (s.finishType ?? "paint") as FinishType;
    const room = s.roomLabel ?? "Unlabeled walls";
    const fg = byFinish.get(finish) ?? new Map();
    const rg = fg.get(room) ?? { sqft: 0, lf: 0, count: 0 };
    rg.sqft += s.squareFootage ?? 0;
    rg.lf += s.linearFootage ?? 0;
    rg.count += 1;
    fg.set(room, rg);
    byFinish.set(finish, fg);
  }

  // Paint first, then the rest in label order, so billable scope leads.
  const finishes = [...byFinish.keys()].sort((a, b) => {
    if (a === "paint") return -1;
    if (b === "paint") return 1;
    return FINISH_TYPE_LABELS[a].localeCompare(FINISH_TYPE_LABELS[b]);
  });

  return (
    <div
      data-testid="scope-summary"
      className="border-b border-[hsl(var(--line))] bg-white px-4 py-3"
    >
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[hsl(var(--ink-2))]">
        Wall scope by finish
      </div>
      <div className="flex flex-col gap-2">
        {finishes.map((finish) => {
          const rooms = byFinish.get(finish)!;
          const billed = PAINTABLE_FINISHES.has(finish);
          const totSqft = [...rooms.values()].reduce((a, r) => a + r.sqft, 0);
          const totLf = [...rooms.values()].reduce((a, r) => a + r.lf, 0);
          const roomRows = [...rooms.entries()].sort(
            (a, b) => b[1].sqft - a[1].sqft,
          );
          return (
            <div
              key={finish}
              data-testid={`scope-finish-${finish}`}
              className="rounded-[8px] border border-[hsl(var(--line))]"
            >
              <div className="flex items-center gap-2 border-b border-[hsl(var(--line))] bg-[hsl(var(--panel-2))] px-2.5 py-1.5">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ backgroundColor: FINISH_TYPE_COLORS[finish] }}
                />
                <span className="text-[12px] font-semibold text-[hsl(var(--ink))]">
                  {FINISH_TYPE_LABELS[finish]}
                </span>
                {!billed && (
                  <span
                    className="rounded bg-[hsl(var(--line))] px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide text-[hsl(var(--ink-2))]"
                    title="Tracked on the plan but not billed as paint — different trade/finish."
                  >
                    tracked, not billed
                  </span>
                )}
                <span className="num ml-auto text-[12px] font-semibold tabular-nums text-[hsl(var(--ink))]">
                  {Math.round(totSqft).toLocaleString()} sq ft
                </span>
                <span className="num text-[11px] tabular-nums text-[hsl(var(--ink-3))]">
                  {Math.round(totLf).toLocaleString()} lf
                </span>
              </div>
              <div className="flex flex-col">
                {roomRows.map(([room, r]) => (
                  <div
                    key={room}
                    className="flex items-center gap-2 px-2.5 py-1 text-[11.5px]"
                  >
                    <span className="text-[hsl(var(--ink-2))]">{room}</span>
                    <span className="text-[hsl(var(--ink-3))]">
                      · {r.count} run{r.count === 1 ? "" : "s"}
                    </span>
                    <span className="num ml-auto tabular-nums text-[hsl(var(--ink))]">
                      {Math.round(r.sqft).toLocaleString()} sq ft
                    </span>
                    <span className="num w-16 text-right tabular-nums text-[hsl(var(--ink-3))]">
                      {Math.round(r.lf).toLocaleString()} lf
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
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
