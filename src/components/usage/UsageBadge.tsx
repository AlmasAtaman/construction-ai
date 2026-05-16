"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface UsageData {
  spend: number;
  ceiling: number;
  percent: number;
}

export function UsageBadge() {
  const [data, setData] = useState<UsageData | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/usage", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as UsageData;
        if (!cancelled) setData(json);
      } catch {
        /* ignore */
      }
    }

    load();
    const id = setInterval(load, 15_000);
    function onChange() {
      void load();
    }
    window.addEventListener("ai-usage-changed", onChange);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener("ai-usage-changed", onChange);
    };
  }, []);

  const spend = data?.spend ?? 0;
  const ceiling = data?.ceiling ?? 20;
  const pct = data?.percent ?? 0;

  const tone =
    pct >= 0.95
      ? "border-red-300 bg-red-50 text-red-800"
      : pct >= 0.8
        ? "border-orange-300 bg-orange-50 text-orange-800"
        : pct >= 0.5
          ? "border-yellow-300 bg-yellow-50 text-yellow-800"
          : "border-emerald-200 bg-emerald-50 text-emerald-800";

  return (
    <div
      data-testid="usage-badge"
      className={cn(
        "inline-flex items-center gap-2 rounded-[6px] border px-2.5 py-1 text-[12px] font-medium",
        tone,
      )}
      title="Today's AI spend across all projects. Resets at midnight."
    >
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v6l4 2" />
      </svg>
      <span className="hidden sm:inline">AI today</span>
      <span className="num font-semibold">
        ${spend.toFixed(2)} / ${ceiling.toFixed(0)}
      </span>
    </div>
  );
}
