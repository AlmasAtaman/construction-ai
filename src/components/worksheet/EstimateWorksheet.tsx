"use client";

import { useEffect, useMemo, useState } from "react";
import { useEditorStore } from "@/lib/store/editor-store";
import {
  calculateBid,
  DEFAULT_CONFIG,
  type BidConfig,
} from "@/lib/math/bid-calculator";
import { formatCurrency } from "@/lib/utils";
import type { SurfaceType } from "@/types/surface";

interface Props {
  projectId: string;
}

const TYPE_LABELS: Record<SurfaceType, string> = {
  wall: "Wall",
  ceiling: "Ceiling",
  trim: "Trim",
  door: "Door",
  window: "Window",
};

export function EstimateWorksheet({ projectId }: Props) {
  const surfaces = useEditorStore((s) => s.surfaces);
  const [config, setConfig] = useState<BidConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [ratesRes, projectRes, rulesRes] = await Promise.all([
          fetch("/api/settings/rates", { cache: "no-store" }),
          fetch(`/api/projects/${projectId}`, { cache: "no-store" }),
          fetch("/api/settings/rules", { cache: "no-store" }),
        ]);
        const ratesJson = ratesRes.ok ? await ratesRes.json() : { rates: [] };
        const projectJson = projectRes.ok
          ? await projectRes.json()
          : { project: null };
        const rulesJson = rulesRes.ok
          ? await rulesRes.json()
          : { rules: [] };
        if (cancelled) return;

        const hourlyCostBySurface: Partial<Record<SurfaceType, number>> = {};
        for (const r of ratesJson.rates ?? []) {
          if (r.surfaceType && typeof r.rate === "number") {
            hourlyCostBySurface[r.surfaceType as SurfaceType] = r.rate;
          }
        }

        let wasteFactor =
          projectJson.project?.wasteFactor ?? DEFAULT_CONFIG.wasteFactor;
        for (const rule of rulesJson.rules ?? []) {
          const m =
            String(rule.rule).match(/(\d+(?:\.\d+)?)\s*%\s*waste/i) ??
            String(rule.rule).match(/waste.*?(\d+(?:\.\d+)?)\s*%/i);
          if (m) wasteFactor = parseFloat(m[1]) / 100;
        }

        setConfig({
          ...DEFAULT_CONFIG,
          measurementMode:
            projectJson.project?.measurementMode ?? "net",
          wasteFactor,
          markup: projectJson.project?.markup ?? DEFAULT_CONFIG.markup,
          hourlyCostBySurface,
          defaultHourlyCost:
            ratesJson.rates?.find?.(
              (r: { surfaceType: string; rate: number }) =>
                r.surfaceType === "default",
            )?.rate ?? DEFAULT_CONFIG.defaultHourlyCost,
        });
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

  return (
    <div className="overflow-x-auto" data-testid="worksheet">
      <table className="sheet">
        <thead>
          <tr>
            <th className="w-[18%]">Room</th>
            <th className="w-[10%]">Type</th>
            <th className="w-[16%]">Paint</th>
            <th className="w-[6%] text-right">Coats</th>
            <th className="w-[10%] text-right">Size</th>
            <th className="w-[10%] text-right" title="Painting speed — square feet per hour">Speed</th>
            <th className="w-[8%] text-right">Hours</th>
            <th className="w-[10%] text-right">Paint $</th>
            <th className="w-[12%] text-right">Labor $</th>
          </tr>
        </thead>
        <tbody>
          {bid.lineItems.map((li) => (
            <tr key={li.surfaceId} data-testid="worksheet-row">
              <td className="font-medium text-[hsl(var(--ink))]">
                {li.roomLabel ?? "—"}
              </td>
              <td className="text-[hsl(var(--ink-2))]">
                {TYPE_LABELS[li.type]}
              </td>
              <td className="text-[hsl(var(--ink-2))]">
                {li.paintType ?? <span className="text-[hsl(var(--ink-3))]">—</span>}
              </td>
              <td className="num text-right">{li.coats}</td>
              <td className="num text-right">
                {Math.round(li.quantity)} {li.unit}
              </td>
              <td className="num text-right text-[hsl(var(--ink-3))]">
                {li.productionRate.toFixed(0)} {li.unit}/h
              </td>
              <td className="num text-right text-[hsl(var(--ink-2))]">
                {li.laborHours.toFixed(1)}
              </td>
              <td className="num text-right">
                {formatCurrency(li.materialCost)}
              </td>
              <td className="num text-right">{formatCurrency(li.laborCost)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot
          className="bg-[hsl(var(--panel-2))] text-[hsl(var(--ink))]"
          data-testid="worksheet-totals"
        >
          <tr>
            <td
              colSpan={7}
              className="text-right text-[12px] font-medium text-[hsl(var(--ink-2))]"
            >
              Subtotal
            </td>
            <td className="num text-right">
              {formatCurrency(bid.totalMaterial)}
            </td>
            <td className="num text-right">{formatCurrency(bid.totalLabor)}</td>
          </tr>
          <tr>
            <td
              colSpan={8}
              className="text-right text-[12px] font-medium text-[hsl(var(--ink-2))]"
            >
              Overhead
            </td>
            <td className="num text-right" data-testid="worksheet-overhead">
              {formatCurrency(bid.totalOverhead)}
            </td>
          </tr>
          <tr>
            <td
              colSpan={8}
              className="text-right text-[12px] font-medium text-[hsl(var(--ink-2))]"
            >
              Markup
            </td>
            <td className="num text-right">{formatCurrency(bid.totalMarkup)}</td>
          </tr>
          <tr className="border-t-2 border-[hsl(var(--ink))]">
            <td
              colSpan={8}
              className="py-2.5 text-right text-[13px] font-bold uppercase tracking-wide text-[hsl(var(--ink))]"
            >
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
