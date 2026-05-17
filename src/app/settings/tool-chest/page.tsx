"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppShell, TopBar } from "@/components/nav/AppShell";

interface Assembly {
  id: string;
  name: string;
  category: string;
  paintType: string;
  coats: number;
  productionRate: number;
  wasteFactor: number;
  laborRate: number;
  paintCost: number;
  notes: string | null;
}

const CATEGORY_ORDER = ["interior", "ceiling", "trim", "exterior", "specialty"];

export default function ToolChestPage() {
  const [list, setList] = useState<Assembly[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Assembly | null>(null);
  const [saving, setSaving] = useState(false);

  function load(): void {
    setLoading(true);
    fetch("/api/assemblies", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setList(j.assemblies ?? []))
      .finally(() => setLoading(false));
  }
  useEffect(() => {
    load();
  }, []);

  async function save(): Promise<void> {
    if (!editing) return;
    setSaving(true);
    try {
      const method = editing.id ? "PATCH" : "POST";
      const url = editing.id
        ? `/api/assemblies/${editing.id}`
        : "/api/assemblies";
      const payload: Partial<Assembly> = {
        name: editing.name,
        category: editing.category,
        paintType: editing.paintType,
        coats: editing.coats,
        productionRate: editing.productionRate,
        wasteFactor: editing.wasteFactor,
        laborRate: editing.laborRate,
        paintCost: editing.paintCost,
        notes: editing.notes ?? null,
      };
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (r.ok) {
        setEditing(null);
        load();
      }
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string): Promise<void> {
    if (!window.confirm("Delete this assembly?")) return;
    await fetch(`/api/assemblies/${id}`, { method: "DELETE" });
    load();
  }

  const grouped = new Map<string, Assembly[]>();
  for (const a of list) {
    if (!grouped.has(a.category)) grouped.set(a.category, []);
    grouped.get(a.category)!.push(a);
  }

  return (
    <AppShell>
      <TopBar
        title="Tool chest — paint assemblies"
        right={
          <Link
            href="/settings"
            className="text-[12px] text-[hsl(var(--ink-2))] hover:text-[hsl(var(--ink-1))]"
          >
            ← Settings
          </Link>
        }
      />
      <div className="p-5 max-w-4xl mx-auto">
        <div className="rounded-[8px] border border-[hsl(var(--line))] bg-white p-5 shadow-sm">
          <div className="flex items-baseline justify-between mb-3">
            <div>
              <h2 className="text-[14px] font-semibold text-[hsl(var(--ink-1))]">
                Paint assemblies
              </h2>
              <p className="text-[11px] text-[hsl(var(--ink-3))]">
                Reusable bundles of paint type, coats, production rate, and cost.
                Apply with one click to selected surfaces.
              </p>
            </div>
            <button
              type="button"
              data-testid="new-assembly-button"
              onClick={() =>
                setEditing({
                  id: "",
                  name: "",
                  category: "interior",
                  paintType: "",
                  coats: 2,
                  productionRate: 200,
                  wasteFactor: 0.1,
                  laborRate: 55,
                  paintCost: 40,
                  notes: null,
                })
              }
              className="rounded-[6px] bg-[hsl(var(--brand))] px-3 py-1.5 text-[12px] font-medium text-white"
            >
              New assembly
            </button>
          </div>

          {loading ? (
            <div className="text-[12px] text-[hsl(var(--ink-3))]">Loading…</div>
          ) : (
            <div className="space-y-4">
              {CATEGORY_ORDER.filter((c) => grouped.has(c)).map((cat) => (
                <div key={cat}>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[hsl(var(--ink-2))]">
                    {cat}
                  </div>
                  <div className="overflow-hidden rounded-[6px] border border-[hsl(var(--line))]">
                    <table className="w-full text-[12px]">
                      <thead>
                        <tr className="bg-[hsl(var(--surface-2))] text-[hsl(var(--ink-3))]">
                          <th className="px-2 py-1.5 text-left">Name</th>
                          <th className="px-2 py-1.5 text-left">Paint type</th>
                          <th className="px-2 py-1.5 text-right">Coats</th>
                          <th className="px-2 py-1.5 text-right">Prod (sqft/hr)</th>
                          <th className="px-2 py-1.5 text-right">Waste</th>
                          <th className="px-2 py-1.5 text-right">Labor $/hr</th>
                          <th className="px-2 py-1.5 text-right">Paint $/gal</th>
                          <th className="px-2 py-1.5"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {grouped.get(cat)!.map((a) => (
                          <tr
                            key={a.id}
                            data-testid="assembly-row"
                            className="border-t border-[hsl(var(--line))]/40 hover:bg-[hsl(var(--surface-2))]"
                          >
                            <td className="px-2 py-1.5 font-medium">{a.name}</td>
                            <td className="px-2 py-1.5">{a.paintType}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">
                              {a.coats}
                            </td>
                            <td className="px-2 py-1.5 text-right tabular-nums">
                              {a.productionRate}
                            </td>
                            <td className="px-2 py-1.5 text-right tabular-nums">
                              {(a.wasteFactor * 100).toFixed(0)}%
                            </td>
                            <td className="px-2 py-1.5 text-right tabular-nums">
                              ${a.laborRate}
                            </td>
                            <td className="px-2 py-1.5 text-right tabular-nums">
                              ${a.paintCost}
                            </td>
                            <td className="px-2 py-1.5 text-right whitespace-nowrap">
                              <button
                                type="button"
                                onClick={() => setEditing(a)}
                                className="mr-1 text-[hsl(var(--brand))] hover:underline"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => void remove(a.id)}
                                className="text-red-700 hover:underline"
                              >
                                Delete
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {editing && (
        <div
          role="dialog"
          aria-label="Edit assembly"
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
          onClick={() => setEditing(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-[10px] border border-[hsl(var(--line))] bg-white p-5 shadow-xl"
          >
            <h3 className="text-[14px] font-semibold text-[hsl(var(--ink-1))]">
              {editing.id ? "Edit assembly" : "New assembly"}
            </h3>
            <div className="mt-4 space-y-2">
              <label className="block">
                <span className="text-[11px] text-[hsl(var(--ink-2))]">Name</span>
                <input
                  type="text"
                  value={editing.name}
                  onChange={(e) =>
                    setEditing({ ...editing, name: e.target.value })
                  }
                  className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px]"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-[11px] text-[hsl(var(--ink-2))]">Category</span>
                  <select
                    value={editing.category}
                    onChange={(e) =>
                      setEditing({ ...editing, category: e.target.value })
                    }
                    className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px]"
                  >
                    {CATEGORY_ORDER.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[11px] text-[hsl(var(--ink-2))]">Coats</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={editing.coats}
                    onChange={(e) =>
                      setEditing({ ...editing, coats: Number(e.target.value) })
                    }
                    className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px] tabular-nums"
                  />
                </label>
              </div>
              <label className="block">
                <span className="text-[11px] text-[hsl(var(--ink-2))]">Paint type</span>
                <input
                  type="text"
                  value={editing.paintType}
                  onChange={(e) =>
                    setEditing({ ...editing, paintType: e.target.value })
                  }
                  className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px]"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-[11px] text-[hsl(var(--ink-2))]">Prod rate (sqft/hr)</span>
                  <input
                    type="number"
                    step={1}
                    value={editing.productionRate}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        productionRate: Number(e.target.value),
                      })
                    }
                    className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px] tabular-nums"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] text-[hsl(var(--ink-2))]">Waste (%)</span>
                  <input
                    type="number"
                    step={1}
                    min={0}
                    max={50}
                    value={Math.round(editing.wasteFactor * 100)}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        wasteFactor: Number(e.target.value) / 100,
                      })
                    }
                    className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px] tabular-nums"
                  />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-[11px] text-[hsl(var(--ink-2))]">Labor $/hr</span>
                  <input
                    type="number"
                    step={1}
                    value={editing.laborRate}
                    onChange={(e) =>
                      setEditing({ ...editing, laborRate: Number(e.target.value) })
                    }
                    className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px] tabular-nums"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] text-[hsl(var(--ink-2))]">Paint $/gal</span>
                  <input
                    type="number"
                    step={1}
                    value={editing.paintCost}
                    onChange={(e) =>
                      setEditing({ ...editing, paintCost: Number(e.target.value) })
                    }
                    className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px] tabular-nums"
                  />
                </label>
              </div>
              <label className="block">
                <span className="text-[11px] text-[hsl(var(--ink-2))]">Notes</span>
                <textarea
                  rows={2}
                  value={editing.notes ?? ""}
                  onChange={(e) =>
                    setEditing({ ...editing, notes: e.target.value })
                  }
                  className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px]"
                />
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="rounded-[6px] border border-[hsl(var(--line))] px-3 py-1.5 text-[12px]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="rounded-[6px] bg-[hsl(var(--brand))] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
