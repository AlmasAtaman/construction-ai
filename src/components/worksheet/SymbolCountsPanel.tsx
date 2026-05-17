"use client";

import { useEffect, useState, useCallback } from "react";

interface CountedSymbol {
  id: string;
  type: string;
  roomLabel: string | null;
  count: number;
  confidence: number;
  notes: string | null;
  source: string;
}

interface Props {
  projectId: string;
  /** Increment to force a refetch. */
  refreshKey?: number;
}

// Group label for each symbol type, for display ordering.
const CATEGORY_OF: Record<string, string> = {
  duplex_outlet: "Electrical",
  switch: "Electrical",
  gfci_outlet: "Electrical",
  light_fixture_ceiling: "Electrical",
  light_fixture_recessed: "Electrical",
  exit_sign: "Electrical",
  smoke_detector: "Electrical",
  toilet: "Plumbing",
  urinal: "Plumbing",
  lavatory_sink: "Plumbing",
  kitchen_sink: "Plumbing",
  shower: "Plumbing",
  bathtub: "Plumbing",
  drinking_fountain: "Plumbing",
  floor_drain: "Plumbing",
  supply_diffuser: "HVAC",
  return_grille: "HVAC",
  thermostat: "HVAC",
  sprinkler_head: "Fire/Safety",
  fire_extinguisher: "Fire/Safety",
  fire_alarm_pull: "Fire/Safety",
  single_door: "Openings",
  double_door: "Openings",
  ada_door: "Openings",
  cased_opening: "Openings",
  window: "Openings",
};

const CATEGORY_ORDER = [
  "Openings",
  "Plumbing",
  "Electrical",
  "HVAC",
  "Fire/Safety",
  "Other",
];

function prettyType(t: string): string {
  return t
    .split("_")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

export function SymbolCountsPanel({ projectId, refreshKey = 0 }: Props) {
  const [symbols, setSymbols] = useState<CountedSymbol[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCost, setLastCost] = useState<number | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/projects/${projectId}/symbols`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setSymbols(j.symbols ?? []);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function runScan(): Promise<void> {
    setRunning(true);
    setError(null);
    try {
      const r = await fetch(`/api/projects/${projectId}/symbols`, {
        method: "POST",
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error ?? "Symbol detection failed.");
        return;
      }
      setLastCost(j.estimatedCostUsd ?? null);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  // Aggregate per type (sum counts across rooms).
  const totalsByType = new Map<string, { total: number; byRoom: CountedSymbol[] }>();
  for (const s of symbols) {
    const cur = totalsByType.get(s.type) ?? { total: 0, byRoom: [] };
    cur.total += s.count;
    cur.byRoom.push(s);
    totalsByType.set(s.type, cur);
  }

  const byCategory = new Map<string, { type: string; total: number; byRoom: CountedSymbol[] }[]>();
  for (const [type, info] of totalsByType) {
    const cat = CATEGORY_OF[type] ?? "Other";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push({ type, total: info.total, byRoom: info.byRoom });
  }
  for (const list of byCategory.values()) {
    list.sort((a, b) => b.total - a.total);
  }

  const grand = symbols.reduce((sum, s) => sum + s.count, 0);

  return (
    <div className="rounded-[8px] border border-[hsl(var(--line))] bg-white p-5 shadow-sm">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <div>
          <h2 className="text-[14px] font-semibold text-[hsl(var(--ink-1))]">
            Symbol counts
          </h2>
          <p className="text-[11px] text-[hsl(var(--ink-3))]">
            Doors, fixtures, outlets, sprinklers — auto-counted from the plan.
          </p>
        </div>
        <button
          type="button"
          onClick={runScan}
          disabled={running}
          className="rounded-[6px] border border-[hsl(var(--line))] bg-[hsl(var(--surface-2))] px-3 py-1.5 text-[12px] font-medium text-[hsl(var(--ink-1))] hover:bg-[hsl(var(--surface-3))] disabled:opacity-50"
        >
          {running ? "Scanning…" : symbols.length === 0 ? "Scan plan" : "Re-scan"}
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-[6px] border border-red-200 bg-red-50 p-2 text-[11px] text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-[12px] text-[hsl(var(--ink-3))]">Loading…</div>
      ) : symbols.length === 0 ? (
        <div className="text-[12px] text-[hsl(var(--ink-3))]">
          No symbols counted yet. Click <strong>Scan plan</strong> to detect doors,
          fixtures, outlets, and other symbols on every page.
        </div>
      ) : (
        <>
          <div className="mb-3 flex items-baseline gap-4 text-[12px]">
            <div>
              <span className="font-semibold text-[hsl(var(--ink-1))]">{grand}</span>{" "}
              <span className="text-[hsl(var(--ink-3))]">symbols total</span>
            </div>
            {lastCost !== null && (
              <div className="text-[11px] text-[hsl(var(--ink-3))]">
                Last scan: ${lastCost.toFixed(3)}
              </div>
            )}
          </div>

          <div className="space-y-3">
            {CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((cat) => (
              <div key={cat}>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[hsl(var(--ink-2))]">
                  {cat}
                </div>
                <div className="space-y-1">
                  {byCategory.get(cat)!.map((row) => (
                    <details key={row.type} className="group">
                      <summary className="flex cursor-pointer items-baseline justify-between gap-2 rounded-[4px] px-2 py-1 text-[12px] hover:bg-[hsl(var(--surface-2))]">
                        <span className="text-[hsl(var(--ink-1))]">{prettyType(row.type)}</span>
                        <span className="tabular-nums font-medium text-[hsl(var(--ink-1))]">
                          {row.total}
                        </span>
                      </summary>
                      {row.byRoom.some((r) => r.roomLabel) && (
                        <div className="ml-3 mt-1 space-y-0.5 border-l border-[hsl(var(--line))] pl-3 text-[11px] text-[hsl(var(--ink-2))]">
                          {row.byRoom
                            .filter((r) => r.roomLabel)
                            .sort((a, b) => b.count - a.count)
                            .map((r) => (
                              <div key={r.id} className="flex justify-between">
                                <span>{r.roomLabel}</span>
                                <span className="tabular-nums">{r.count}</span>
                              </div>
                            ))}
                        </div>
                      )}
                    </details>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
