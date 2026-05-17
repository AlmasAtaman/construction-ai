"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatCurrency } from "@/lib/utils";
import { AppShell, TopBar } from "@/components/nav/AppShell";

interface Breakdown {
  endpoint: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

interface UsageData {
  spend: number;
  ceiling: number;
  percent: number;
  breakdown: Breakdown[];
}

export default function UsagePage() {
  const [data, setData] = useState<UsageData | null>(null);

  useEffect(() => {
    fetch("/api/usage", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setData(j));
  }, []);

  return (
    <AppShell>
      <TopBar
        title="AI usage today"
        subtitle="How much of today's AI budget you've used. Resets at midnight."
      >
        <Link
          href="/settings"
          className="text-[12px] text-[hsl(var(--ink-2))] hover:text-[hsl(var(--ink-1))]"
        >
          ← Settings
        </Link>
      </TopBar>
      <main className="flex-1 px-6 py-10">
        <div className="mx-auto max-w-3xl">
          {!data ? (
            <div className="text-[13px] text-[hsl(var(--ink-2))]">
              Loading...
            </div>
          ) : (
            <UsageBody data={data} />
          )}
        </div>
      </main>
    </AppShell>
  );
}

function UsageBody({ data }: { data: UsageData }) {
  const pct = Math.round(data.percent * 100);

  return (
    <>
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="num text-3xl font-bold text-[hsl(var(--ink))]">
              {formatCurrency(data.spend)}
            </div>
            <div className="text-sm text-[hsl(var(--ink-2))]">
              of {formatCurrency(data.ceiling)} daily budget
            </div>
          </div>
          <div className="num text-right text-sm text-[hsl(var(--ink-1))]">
            {pct}% used
          </div>
        </div>
        <div className="mt-4 h-3 w-full overflow-hidden rounded-full bg-gray-200">
          <div
            className="h-full bg-blue-600 transition-all"
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
      </div>

      <h3 className="mt-8 text-lg font-semibold text-[hsl(var(--ink))]">
        By feature
      </h3>
      <div className="mt-3 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-[hsl(var(--ink-2))]">
            <tr>
              <th className="px-4 py-2 text-left">Feature</th>
              <th className="px-4 py-2 text-right">Calls today</th>
              <th className="px-4 py-2 text-right">Spent</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.breakdown.length === 0 && (
              <tr>
                <td
                  colSpan={3}
                  className="px-4 py-6 text-center text-[hsl(var(--ink-3))]"
                >
                  No AI usage today yet.
                </td>
              </tr>
            )}
            {data.breakdown.map((b) => (
              <tr key={b.endpoint}>
                <td className="px-4 py-2 capitalize">{b.endpoint}</td>
                <td className="num px-4 py-2 text-right">{b.calls}</td>
                <td className="num px-4 py-2 text-right">
                  {formatCurrency(b.cost)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
