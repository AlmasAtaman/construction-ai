"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { baseLayerName, type LayerRole } from "@/lib/extract/layer-classify";

interface LayerEntry {
  name: string;
  role: LayerRole;
  segments: number;
}

interface LayersResponse {
  layers: LayerEntry[];
  hasWallLayers: boolean;
}

const ROLE_LABELS: Partial<Record<LayerRole, string>> = {
  "wall-new": "new wall",
  "wall-existing": "existing wall",
  "wall-demo": "demolished wall",
};

/**
 * "Takeoff layers" popover. Shown only when the PDF preserves CAD layers:
 * lists the wall layers the deterministic takeoff will measure, lets the
 * contractor include/exclude them (e.g. add demo walls, drop the base
 * building shell), and re-runs the takeoff with that selection. This is
 * the auditability story: you can see exactly which drawing layers the
 * numbers came from.
 */
export function TakeoffLayersPanel({
  planPageId,
  busy,
  onRunTakeoff,
}: {
  planPageId: string;
  busy: boolean;
  onRunTakeoff: (wallLayers: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [layers, setLayers] = useState<LayerEntry[] | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let stale = false;
    setLayers(null);
    setOpen(false);
    fetch(`/api/plan-pages/${planPageId}/layers`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json: LayersResponse | null) => {
        if (stale || !json) return;
        setLayers(json.layers);
        const init: Record<string, boolean> = {};
        for (const l of json.layers) {
          if (l.role === "wall-new" || l.role === "wall-existing")
            init[l.name] = true;
          else if (l.role === "wall-demo") init[l.name] = false;
        }
        setChecked(init);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [planPageId]);

  const wallish = (layers ?? []).filter((l) => l.role in ROLE_LABELS);
  if (wallish.length === 0) return null;

  const ignored = (layers ?? []).filter((l) => !(l.role in ROLE_LABELS));
  const selection = wallish
    .filter((l) => checked[l.name])
    .map((l) => l.name);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid="takeoff-layers-toggle"
        aria-expanded={open}
        title="This PDF has CAD layers — choose which wall layers the takeoff measures."
        className={cn(
          "inline-flex items-center gap-1 rounded-[8px] border px-2.5 py-1.5 text-[11.5px] font-medium shadow-sm transition-colors",
          open
            ? "border-[hsl(var(--brand))] bg-[hsl(var(--brand-soft))] text-[hsl(var(--brand))]"
            : "border-[hsl(var(--line))] bg-white text-[hsl(var(--ink-2))] hover:bg-[hsl(var(--panel-2))]",
        )}
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5" />
        </svg>
        Layers
      </button>
      {open && (
        <div
          data-testid="takeoff-layers-panel"
          className="absolute right-0 top-full z-30 mt-1.5 w-80 rounded-[10px] border border-[hsl(var(--line))] bg-white p-3 shadow-lg"
        >
          <div className="text-[11.5px] font-semibold text-[hsl(var(--ink))]">
            Wall layers in this PDF
          </div>
          <p className="mt-0.5 text-[10.5px] leading-snug text-[hsl(var(--ink-3))]">
            The takeoff measures walls straight from the architect&apos;s CAD
            layers. Check the layers that count as paintable walls.
          </p>
          <div className="mt-2 flex flex-col gap-1">
            {wallish.map((l) => (
              <label
                key={l.name}
                className="flex cursor-pointer items-center gap-2 rounded-[6px] px-1.5 py-1 text-[11.5px] hover:bg-[hsl(var(--panel-2))]"
              >
                <input
                  type="checkbox"
                  checked={checked[l.name] ?? false}
                  onChange={(e) =>
                    setChecked((c) => ({ ...c, [l.name]: e.target.checked }))
                  }
                  className="h-3.5 w-3.5 accent-[hsl(var(--accent))]"
                />
                <span className="font-medium text-[hsl(var(--ink))]">
                  {baseLayerName(l.name)}
                </span>
                <span className="ml-auto text-[10.5px] text-[hsl(var(--ink-3))]">
                  {ROLE_LABELS[l.role]} · {l.segments} lines
                </span>
              </label>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onRunTakeoff(selection);
            }}
            disabled={busy || selection.length === 0}
            data-testid="takeoff-layers-rerun"
            className={cn(
              "mt-2 w-full rounded-[8px] px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm transition-colors",
              busy || selection.length === 0
                ? "bg-[hsl(var(--ink-3))]"
                : "bg-[hsl(var(--accent))] hover:brightness-95",
            )}
          >
            Re-run takeoff with these layers
          </button>
          {ignored.length > 0 && (
            <p className="mt-2 text-[10.5px] leading-snug text-[hsl(var(--ink-3))]">
              Ignored automatically:{" "}
              {ignored.filter((l) => l.role === "dimension").length} dimension,{" "}
              {ignored.filter((l) => l.role === "hatch").length} hatch and{" "}
              {
                ignored.filter(
                  (l) => l.role !== "dimension" && l.role !== "hatch",
                ).length
              }{" "}
              other layers.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
