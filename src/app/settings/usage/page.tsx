"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatCurrency } from "@/lib/utils";

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

  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center text-gray-600">
        Loading...
      </div>
    );
  }

  const pct = Math.round(data.percent * 100);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-16 items-center border-b border-gray-200 bg-white px-6">
        <Link href="/" className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-600 font-bold text-white">
            P
          </div>
          <h1 className="text-lg font-semibold text-gray-900">PainterDesk</h1>
        </Link>
      </header>
      <main className="flex-1 px-6 py-10">
        <div className="mx-auto max-w-3xl">
          <Link
            href="/settings"
            className="text-sm text-blue-600 hover:underline"
          >
            &larr; Back to settings
          </Link>
          <h2 className="mt-4 text-2xl font-bold text-gray-900">
            AI usage today
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            How much of today&apos;s AI budget you&apos;ve used and what for.
            Resets at midnight.
          </p>

          <div className="mt-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
            <div className="flex items-baseline justify-between">
              <div>
                <div className="text-3xl font-bold text-gray-900">
                  {formatCurrency(data.spend)}
                </div>
                <div className="text-sm text-gray-500">
                  of {formatCurrency(data.ceiling)} daily budget
                </div>
              </div>
              <div className="text-right text-sm text-gray-700">{pct}% used</div>
            </div>
            <div className="mt-4 h-3 w-full overflow-hidden rounded-full bg-gray-200">
              <div
                className="h-full bg-blue-600 transition-all"
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
          </div>

          <h3 className="mt-8 text-lg font-semibold text-gray-900">
            By feature
          </h3>
          <div className="mt-3 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-600">
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
                      className="px-4 py-6 text-center text-gray-500"
                    >
                      No AI usage today yet.
                    </td>
                  </tr>
                )}
                {data.breakdown.map((b) => (
                  <tr key={b.endpoint}>
                    <td className="px-4 py-2 capitalize">{b.endpoint}</td>
                    <td className="px-4 py-2 text-right">{b.calls}</td>
                    <td className="px-4 py-2 text-right">
                      {formatCurrency(b.cost)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}
