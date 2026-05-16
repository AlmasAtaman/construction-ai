"use client";

import { useEffect, useState } from "react";

export function UsageWarningBanner() {
  const [percent, setPercent] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/usage", { cache: "no-store" });
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled) setPercent(json.percent ?? 0);
      } catch {
        /* ignore */
      }
    }
    load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (percent < 0.8) return null;

  if (percent >= 1) {
    return (
      <div
        data-testid="usage-banner-exceeded"
        className="border-b border-red-300 bg-red-50 px-6 py-3 text-sm font-medium text-red-900"
      >
        Daily AI usage limit reached. AI features will resume tomorrow. You
        can still edit projects manually.
      </div>
    );
  }

  return (
    <div
      data-testid="usage-banner-warning"
      className="border-b border-orange-300 bg-orange-50 px-6 py-3 text-sm font-medium text-orange-900"
    >
      Heads up &mdash; you&apos;ve used {Math.round(percent * 100)}% of today&apos;s AI
      budget. AI features will pause if you hit 100%.
    </div>
  );
}
