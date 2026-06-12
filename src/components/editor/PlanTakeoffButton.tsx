"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

interface PageSummary {
  pageNumber: number;
  status: "traced" | "needs-scale" | "no-walls" | "up-to-date" | "error";
  method: "layers" | "geometry" | null;
  count: number;
  skippedExisting: number;
  linearFt: number | null;
}

interface PlanTakeoffResponse {
  pages: PageSummary[];
  tracedPages: number;
  totalWalls: number;
}

/**
 * One-click whole-plan takeoff: classifies every sheet, auto-reads each
 * floor plan's scale, and traces walls on all of them (CAD-layer path
 * with geometry fallback). Results land in the review queue per page.
 */
export function PlanTakeoffButton({
  planId,
  onComplete,
}: {
  planId: string | null;
  onComplete: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<PlanTakeoffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!planId || running) return;
    setRunning(true);
    setError(null);
    setSummary(null);
    try {
      const res = await fetch(`/api/plans/${planId}/takeoff`, {
        method: "POST",
      });
      if (!res.ok) {
        setError("Plan takeoff failed.");
        return;
      }
      const json = (await res.json()) as PlanTakeoffResponse;
      setSummary(json);
      onComplete();
      // Page types / scales may have just been established — let the page
      // rail and scale banner refetch.
      window.dispatchEvent(new Event("scale-updated"));
    } catch {
      setError("Plan takeoff failed.");
    } finally {
      setRunning(false);
    }
  }

  const statusLine = (p: PageSummary): string => {
    if (p.status === "traced")
      return `${p.count} walls${p.linearFt != null ? ` · ${Math.round(p.linearFt)} lf` : ""}${p.method === "layers" ? " · CAD layers" : ""}`;
    if (p.status === "needs-scale")
      return `${p.count} walls — set scale to price`;
    if (p.status === "up-to-date")
      return `all ${p.skippedExisting} walls already kept ✓`;
    if (p.status === "no-walls") return "no walls found";
    return "failed";
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => void run()}
        disabled={!planId || running}
        data-testid="plan-takeoff"
        title="Classify every sheet, read each floor plan's scale, and trace the walls on all of them in one go."
        className={cn(
          "inline-flex w-full items-center justify-center gap-1.5 rounded-[8px] px-3 py-2 text-[12.5px] font-semibold text-white shadow-sm transition-colors",
          !planId || running
            ? "bg-[hsl(var(--ink-3))]"
            : "bg-[hsl(var(--accent))] hover:brightness-95",
        )}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 3l2.5 6.5L22 12l-6.5 2.5L13 21l-2.5-6.5L4 12l6.5-2.5zM5 3v4M3 5h4" />
        </svg>
        {running ? "Measuring every floor plan…" : "Takeoff whole plan"}
      </button>
      {error && (
        <p className="mt-1.5 text-[11px] text-red-600">{error}</p>
      )}
      {summary && (
        <div
          data-testid="plan-takeoff-summary"
          className="mt-2 rounded-[8px] border border-[hsl(var(--line))] bg-[hsl(var(--panel-2))] p-2 text-[11px] leading-snug text-[hsl(var(--ink-2))]"
        >
          <div className="font-semibold text-[hsl(var(--ink))]">
            {summary.totalWalls} walls across {summary.tracedPages} sheet
            {summary.tracedPages === 1 ? "" : "s"}
          </div>
          <ul className="mt-1 space-y-0.5">
            {summary.pages.map((p) => (
              <li key={p.pageNumber}>
                <span className="font-medium">p{p.pageNumber}</span>{" "}
                {statusLine(p)}
              </li>
            ))}
          </ul>
          {summary.tracedPages > 1 && (
            <p className="mt-1.5 text-[10.5px] text-[hsl(var(--ink-3))]">
              The same walls can appear on several sheets (construction,
              finish…). Accept the sheet you&apos;re bidding from — accepting
              two sheets of the same floor double-counts.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
