"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface SanityFlag {
  id: string;
  severity: "info" | "warning" | "error";
  message: string;
  surfaceIds?: string[];
}

interface SanityReport {
  flags: SanityFlag[];
  wallToCeilingRatio: number;
  totalFloorSqft: number;
  totalWallSqft: number;
}

interface Props {
  projectId: string;
  refreshKey?: number;
}

/**
 * Pre-bid sanity checks shown on the bid review page. This is the
 * "before you submit" audit panel — wall:ceiling ratio, per-room
 * plausibility, low-confidence surfaces, missing ceilings, orphan doors.
 *
 * Modeled on professional estimators' spot-check workflow per PCA P10 +
 * 1Build/ConstructConnect.
 */
export function SanityPanel({ projectId, refreshKey = 0 }: Props) {
  const [report, setReport] = useState<SanityReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/projects/${projectId}/sanity`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setReport(j.report);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey]);

  if (loading) {
    return (
      <div className="rounded-[8px] border border-[hsl(var(--line))] bg-white p-5 text-[12px] text-[hsl(var(--ink-3))] shadow-sm">
        Running pre-bid sanity checks…
      </div>
    );
  }

  if (!report) return null;

  const errorCount = report.flags.filter((f) => f.severity === "error").length;
  const warnCount = report.flags.filter((f) => f.severity === "warning").length;
  const infoCount = report.flags.filter((f) => f.severity === "info").length;
  const headlineColor =
    errorCount > 0
      ? "border-red-300 bg-red-50"
      : warnCount > 0
        ? "border-amber-300 bg-amber-50"
        : "border-emerald-300 bg-emerald-50";

  return (
    <div
      data-testid="sanity-panel"
      className={cn(
        "rounded-[8px] border bg-white shadow-sm overflow-hidden",
        headlineColor,
      )}
    >
      <div className="border-b border-current/10 bg-white/50 px-5 py-3">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[hsl(var(--ink-3))]">
            Pre-bid sanity check
          </h3>
          <span
            className="text-[12px] font-medium text-[hsl(var(--ink))]"
            data-testid="sanity-status"
          >
            {report.flags.length === 0 ? (
              <span className="text-emerald-700">All checks passed</span>
            ) : (
              <>
                {warnCount > 0 && (
                  <span className="text-amber-800">
                    {warnCount} warning{warnCount === 1 ? "" : "s"}
                  </span>
                )}
                {warnCount > 0 && infoCount > 0 && (
                  <span className="text-[hsl(var(--ink-3))]"> · </span>
                )}
                {infoCount > 0 && (
                  <span className="text-[hsl(var(--ink-2))]">
                    {infoCount} note{infoCount === 1 ? "" : "s"}
                  </span>
                )}
              </>
            )}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-3 text-[11px] text-[hsl(var(--ink-2))]">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-[hsl(var(--ink-3))]">
              Floor area
            </div>
            <div className="num text-[14px] font-semibold text-[hsl(var(--ink))]">
              {Math.round(report.totalFloorSqft).toLocaleString()} sqft
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-[hsl(var(--ink-3))]">
              Wall area
            </div>
            <div className="num text-[14px] font-semibold text-[hsl(var(--ink))]">
              {Math.round(report.totalWallSqft).toLocaleString()} sqft
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-[hsl(var(--ink-3))]">
              Wall : floor
            </div>
            <div
              className={cn(
                "num text-[14px] font-semibold",
                report.wallToCeilingRatio >= 2 &&
                  report.wallToCeilingRatio <= 3.5
                  ? "text-emerald-700"
                  : "text-amber-800",
              )}
            >
              {report.wallToCeilingRatio.toFixed(2)}×
            </div>
          </div>
        </div>
      </div>

      {report.flags.length === 0 ? (
        <div className="px-5 py-3 text-[12px] text-[hsl(var(--ink-2))]">
          No flags. Wall-to-floor ratio looks healthy. You can submit this
          bid with confidence.
        </div>
      ) : (
        <ul
          className="divide-y divide-[hsl(var(--line-2))]"
          data-testid="sanity-flags"
        >
          {report.flags.map((f) => (
            <li
              key={f.id}
              className="flex items-start gap-3 px-5 py-3 text-[12px]"
              data-testid="sanity-flag"
              data-severity={f.severity}
            >
              <SeverityIcon severity={f.severity} />
              <div className="flex-1 leading-snug text-[hsl(var(--ink))]">
                {f.message}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SeverityIcon({
  severity,
}: {
  severity: "info" | "warning" | "error";
}) {
  if (severity === "error") {
    return (
      <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold text-white">
        !
      </span>
    );
  }
  if (severity === "warning") {
    return (
      <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-white">
        !
      </span>
    );
  }
  return (
    <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border border-[hsl(var(--line))] bg-white text-[10px] font-bold text-[hsl(var(--ink-2))]">
      i
    </span>
  );
}
