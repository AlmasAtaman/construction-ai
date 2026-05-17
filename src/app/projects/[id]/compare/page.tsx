"use client";

import { use, useEffect, useState } from "react";
import { AppShell, TopBar } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import Link from "next/link";

interface ProjectRef {
  id: string;
  name: string;
}

interface RoomDelta {
  roomLabel: string | null;
  change: "added" | "removed" | "resized" | "retyped" | "unchanged";
  oldAreaSqft: number;
  newAreaSqft: number;
  areaDeltaSqft: number;
  areaDeltaPct: number;
}

interface SymbolDelta {
  type: string;
  oldCount: number;
  newCount: number;
  delta: number;
}

interface Diff {
  rooms: RoomDelta[];
  symbols: SymbolDelta[];
  summary: {
    addedRooms: number;
    removedRooms: number;
    resizedRooms: number;
    totalOldSqft: number;
    totalNewSqft: number;
    totalDeltaSqft: number;
    totalDeltaPct: number;
  };
}

interface DiffResponse {
  diff: Diff;
  thisProject: ProjectRef;
  otherProject: ProjectRef;
}

const CHANGE_COLOR: Record<RoomDelta["change"], string> = {
  added: "text-emerald-700 bg-emerald-50 border-emerald-200",
  removed: "text-red-700 bg-red-50 border-red-200",
  resized: "text-amber-800 bg-amber-50 border-amber-200",
  retyped: "text-sky-700 bg-sky-50 border-sky-200",
  unchanged: "text-slate-600 bg-slate-50 border-slate-200",
};

function prettyType(t: string): string {
  return t
    .split("_")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

export default function CompareTakeoffsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [against, setAgainst] = useState<string>("");
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  const [result, setResult] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load list of comparable projects (everything except this one).
  useEffect(() => {
    fetch("/api/projects", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        const list: ProjectRef[] = (j.projects ?? [])
          .filter((p: { id: string }) => p.id !== id)
          .map((p: { id: string; name: string }) => ({ id: p.id, name: p.name }));
        setProjects(list);
      });
  }, [id]);

  async function runDiff(): Promise<void> {
    if (!against) {
      setError("Pick a project to compare against.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/projects/${id}/compare?against=${against}`,
        { cache: "no-store" },
      );
      const j = await r.json();
      if (!r.ok) {
        setError(j.error ?? "Diff failed.");
        return;
      }
      setResult(j);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell>
      <TopBar title="Compare takeoffs">
        <Link href={`/projects/${id}`}>
          <Button variant="ghost" size="sm">
            Back to project
          </Button>
        </Link>
      </TopBar>
      <div className="p-5 max-w-5xl mx-auto">
        <div className="rounded-[8px] border border-[hsl(var(--line))] bg-white p-5 shadow-sm">
          <h2 className="text-[14px] font-semibold text-[hsl(var(--ink-1))]">
            Pick a previous takeoff to diff against
          </h2>
          <p className="mt-1 text-[11px] text-[hsl(var(--ink-3))]">
            For change-order workflows: upload the revised plan as a new project,
            then come back here and compare.
          </p>
          <div className="mt-3 flex gap-2">
            <select
              value={against}
              onChange={(e) => setAgainst(e.target.value)}
              className="flex-1 rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px]"
              data-testid="compare-against-select"
            >
              <option value="">— Select a project —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={runDiff}
              disabled={!against || loading}
              data-testid="run-compare-button"
              className="rounded-[6px] bg-[hsl(var(--brand))] px-4 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
            >
              {loading ? "Comparing…" : "Compare"}
            </button>
          </div>
          {error && (
            <div className="mt-3 rounded-[6px] border border-red-200 bg-red-50 p-2 text-[11px] text-red-700">
              {error}
            </div>
          )}
        </div>

        {result && (
          <div className="mt-5 space-y-5">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-[8px] border border-[hsl(var(--line))] bg-white p-4 shadow-sm">
                <div className="text-[10px] uppercase tracking-wide text-[hsl(var(--ink-3))]">
                  Old: {result.otherProject.name}
                </div>
                <div className="num text-[18px] font-semibold">
                  {Math.round(result.diff.summary.totalOldSqft).toLocaleString()} sqft
                </div>
              </div>
              <div className="rounded-[8px] border border-[hsl(var(--line))] bg-white p-4 shadow-sm">
                <div className="text-[10px] uppercase tracking-wide text-[hsl(var(--ink-3))]">
                  New: {result.thisProject.name}
                </div>
                <div className="num text-[18px] font-semibold">
                  {Math.round(result.diff.summary.totalNewSqft).toLocaleString()} sqft
                  <span
                    className={`ml-2 text-[12px] font-medium ${result.diff.summary.totalDeltaSqft >= 0 ? "text-emerald-700" : "text-red-700"}`}
                  >
                    {result.diff.summary.totalDeltaSqft >= 0 ? "+" : ""}
                    {Math.round(result.diff.summary.totalDeltaSqft).toLocaleString()}{" "}
                    ({(result.diff.summary.totalDeltaPct * 100).toFixed(1)}%)
                  </span>
                </div>
              </div>
            </div>

            <div className="rounded-[8px] border border-[hsl(var(--line))] bg-white p-5 shadow-sm">
              <h3 className="text-[13px] font-semibold text-[hsl(var(--ink-1))]">
                Room changes
              </h3>
              <div className="mt-1 flex gap-3 text-[11px] text-[hsl(var(--ink-3))]">
                <span>{result.diff.summary.addedRooms} added</span>
                <span>{result.diff.summary.removedRooms} removed</span>
                <span>{result.diff.summary.resizedRooms} resized</span>
              </div>
              {result.diff.rooms.length === 0 ? (
                <div className="mt-3 text-[12px] text-[hsl(var(--ink-3))]">
                  No room changes detected.
                </div>
              ) : (
                <table className="mt-3 w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-[hsl(var(--line))]">
                      <th className="py-1 text-left font-medium text-[hsl(var(--ink-3))]">
                        Room
                      </th>
                      <th className="py-1 text-left font-medium text-[hsl(var(--ink-3))]">
                        Change
                      </th>
                      <th className="py-1 text-right font-medium text-[hsl(var(--ink-3))]">
                        Old SF
                      </th>
                      <th className="py-1 text-right font-medium text-[hsl(var(--ink-3))]">
                        New SF
                      </th>
                      <th className="py-1 text-right font-medium text-[hsl(var(--ink-3))]">
                        Δ
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.diff.rooms.map((r, i) => (
                      <tr
                        key={i}
                        className="border-b border-[hsl(var(--line))]/40"
                      >
                        <td className="py-1.5">{r.roomLabel ?? "(unlabeled)"}</td>
                        <td className="py-1.5">
                          <span
                            className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${CHANGE_COLOR[r.change]}`}
                          >
                            {r.change}
                          </span>
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {r.oldAreaSqft > 0 ? Math.round(r.oldAreaSqft) : "—"}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {r.newAreaSqft > 0 ? Math.round(r.newAreaSqft) : "—"}
                        </td>
                        <td
                          className={`py-1.5 text-right tabular-nums font-medium ${r.areaDeltaSqft > 0 ? "text-emerald-700" : r.areaDeltaSqft < 0 ? "text-red-700" : ""}`}
                        >
                          {r.areaDeltaSqft > 0 ? "+" : ""}
                          {Math.round(r.areaDeltaSqft)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {result.diff.symbols.length > 0 && (
              <div className="rounded-[8px] border border-[hsl(var(--line))] bg-white p-5 shadow-sm">
                <h3 className="text-[13px] font-semibold text-[hsl(var(--ink-1))]">
                  Symbol count changes
                </h3>
                <table className="mt-3 w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-[hsl(var(--line))]">
                      <th className="py-1 text-left font-medium text-[hsl(var(--ink-3))]">
                        Type
                      </th>
                      <th className="py-1 text-right font-medium text-[hsl(var(--ink-3))]">
                        Old
                      </th>
                      <th className="py-1 text-right font-medium text-[hsl(var(--ink-3))]">
                        New
                      </th>
                      <th className="py-1 text-right font-medium text-[hsl(var(--ink-3))]">
                        Δ
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.diff.symbols.map((s) => (
                      <tr key={s.type}>
                        <td className="py-1">{prettyType(s.type)}</td>
                        <td className="py-1 text-right tabular-nums">{s.oldCount}</td>
                        <td className="py-1 text-right tabular-nums">{s.newCount}</td>
                        <td
                          className={`py-1 text-right tabular-nums font-medium ${s.delta > 0 ? "text-emerald-700" : s.delta < 0 ? "text-red-700" : ""}`}
                        >
                          {s.delta > 0 ? "+" : ""}
                          {s.delta}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
