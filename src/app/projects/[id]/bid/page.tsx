"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { UsageBadge } from "@/components/usage/UsageBadge";
import { formatCurrency } from "@/lib/utils";
import { AppShell, TopBar } from "@/components/nav/AppShell";
import { SanityPanel } from "@/components/worksheet/SanityPanel";
import { SymbolCountsPanel } from "@/components/worksheet/SymbolCountsPanel";

interface LineItem {
  surfaceId: string;
  type: string;
  roomLabel: string | null;
  paintType: string | null;
  coats: number;
  quantity: number;
  unit: string;
  productionRate: number;
  laborHours: number;
  laborCost: number;
  materialCost: number;
  gallons: number;
}

interface BidData {
  id: string;
  versionNumber: number;
  lineItems: LineItem[];
  totalMaterial: number;
  totalLabor: number;
  totalOverhead: number;
  totalMarkup: number;
  grandTotal: number;
}

interface ProjectShape {
  id: string;
  name: string;
  clientName: string | null;
}

const PCA_P23_EXCLUSIONS = [
  { id: "removal-finishes", label: "Removal of existing finishes" },
  { id: "lead-asbestos", label: "Lead or asbestos abatement" },
  { id: "wall-covering", label: "Wall covering / wallpaper" },
  { id: "epoxy-floors", label: "Epoxy or specialty floor coatings" },
  { id: "exterior-staining", label: "Exterior staining of structural wood" },
  { id: "fire-protection", label: "Fire-protective intumescent coatings" },
];

export default function BidPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = use(params);
  const [bid, setBid] = useState<BidData | null>(null);
  const [project, setProject] = useState<ProjectShape | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(
    new Set(PCA_P23_EXCLUSIONS.map((e) => e.id)),
  );

  useEffect(() => {
    fetch(`/api/projects/${projectId}`)
      .then((r) => r.json())
      .then((j) => setProject(j.project));
    fetch(`/api/bids/${projectId}/generate`)
      .then((r) => r.json())
      .then((j) => {
        if (j.bid) setBid(j.bid);
      });
  }, [projectId]);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/bids/${projectId}/generate`, {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Something went wrong.");
        return;
      }
      setBid(json.bid);
    } finally {
      setLoading(false);
    }
  }

  function toggleExclusion(id: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const today = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <AppShell>
      <TopBar
        title="Your estimate"
        subtitle={project?.name ?? "Loading…"}
      >
        <UsageBadge />
        <Link href={`/projects/${projectId}`}>
          <Button variant="ghost" size="sm">
            Back to plan
          </Button>
        </Link>
        <Button
          variant="accent"
          onClick={() => void generate()}
          disabled={loading}
          data-testid="generate-bid-button"
        >
          {loading ? "Working…" : bid ? "Update price" : "Calculate price"}
        </Button>
        {bid && (
          <>
            <a
              href={`/api/bids/${projectId}/pdf`}
              download
              data-testid="export-pdf-link"
            >
              <Button variant="secondary" size="sm">
                Export PDF
              </Button>
            </a>
            <a
              href={`/api/bids/${projectId}/csv`}
              download
              data-testid="export-csv-link"
            >
              <Button variant="secondary" size="sm">
                Export CSV
              </Button>
            </a>
          </>
        )}
      </TopBar>

      <main className="flex-1 overflow-y-auto bg-[hsl(var(--canvas))] px-6 py-6">
        <div className="mx-auto max-w-5xl">
          {error && (
            <div className="mb-4 rounded-[var(--radius-sm)] border-l-2 border-[hsl(var(--danger))] bg-white px-3 py-2 text-[12.5px] text-[hsl(var(--ink))]">
              {error}
            </div>
          )}

          {!bid && (
            <div
              className="rounded-[var(--radius)] border border-dashed border-[hsl(var(--line))] bg-white p-12 text-center"
              data-testid="bid-empty-state"
            >
              <h2 className="text-[18px] font-semibold text-[hsl(var(--ink))]">
                Ready to price the job?
              </h2>
              <p className="mx-auto mt-2 max-w-md text-[13px] text-[hsl(var(--ink-2))]">
                Click <strong>Calculate price</strong> and we&apos;ll add up
                every room, paint cost, and labor hour into a clean estimate
                you can send to your customer.
              </p>
              <div className="mt-5">
                <Button
                  variant="accent"
                  size="lg"
                  onClick={() => void generate()}
                  disabled={loading}
                >
                  {loading ? "Working…" : "Calculate price"}
                </Button>
              </div>
            </div>
          )}

          {bid && (
            <>
              {/* Industrial proposal header — total + meta + cost breakdown in one band */}
              <div
                data-testid="bid-grand-total-hero"
                className="overflow-hidden rounded-[var(--radius-lg)] border border-[hsl(var(--line))] bg-white"
              >
                <div className="grid grid-cols-[1fr_auto] items-stretch border-b border-[hsl(var(--line))] bg-[hsl(var(--rail))] text-white">
                  <div className="flex flex-col justify-between gap-4 px-6 py-5">
                    <div>
                      <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-white/55">
                        Painting estimate
                      </div>
                      <div className="mt-0.5 text-[16px] font-semibold leading-tight text-white">
                        {project?.name ?? "—"}
                      </div>
                      {project?.clientName && (
                        <div className="text-[12px] text-white/65">
                          Prepared for {project.clientName}
                        </div>
                      )}
                    </div>
                    <div className="num flex items-baseline gap-2">
                      <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-white/55">
                        Total
                      </span>
                      <span className="text-[28px] font-semibold leading-none text-white">
                        {formatCurrency(bid.grandTotal)}
                      </span>
                    </div>
                  </div>
                  <div className="num grid grid-cols-2 gap-x-6 gap-y-1 border-l border-white/10 bg-black/15 px-6 py-5 text-[11.5px]">
                    <span className="text-white/55">Paint</span>
                    <span className="text-right text-white">
                      {formatCurrency(bid.totalMaterial)}
                    </span>
                    <span className="text-white/55">Labor</span>
                    <span className="text-right text-white">
                      {formatCurrency(bid.totalLabor)}
                    </span>
                    <span className="text-white/55">Overhead</span>
                    <span className="text-right text-white">
                      {formatCurrency(bid.totalOverhead)}
                    </span>
                    <span className="text-white/55">Markup</span>
                    <span className="text-right text-white">
                      {formatCurrency(bid.totalMarkup)}
                    </span>
                    <span className="col-span-2 mt-1.5 flex justify-between border-t border-white/10 pt-1.5 text-white/85">
                      <span>Estimate {bid.versionNumber}</span>
                      <span>{today}</span>
                    </span>
                  </div>
                </div>

                {/* Line items — sits flush under the dark header */}
                <div data-testid="bid-line-items">
                  <table className="sheet w-full">
                    <thead>
                      <tr>
                        <th className="w-[20%]">Room</th>
                        <th className="w-[10%]">Type</th>
                        <th className="w-[22%]">Paint</th>
                        <th className="w-[8%] text-right">Coats</th>
                        <th className="w-[14%] text-right">Quantity</th>
                        <th className="w-[12%] text-right">Material</th>
                        <th className="w-[14%] text-right">Labor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bid.lineItems.map((li, i) => (
                        <BidRow
                          key={i}
                          li={li}
                          onChange={(updated) => {
                            setBid((b) => {
                              if (!b) return b;
                              const next = { ...b, lineItems: [...b.lineItems] };
                              next.lineItems[i] = updated;
                              const totals = recalcTotals(next.lineItems);
                              return { ...next, ...totals };
                            });
                          }}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <SanityPanel
                  projectId={projectId}
                  refreshKey={bid?.versionNumber ?? 0}
                />
                <SymbolCountsPanel
                  projectId={projectId}
                  refreshKey={bid?.versionNumber ?? 0}
                />
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-1">
                {/* P23 exclusions */}
                <div
                  className="rounded-[var(--radius)] border border-[hsl(var(--line))] bg-white p-5"
                  data-testid="bid-exclusions"
                >
                  {/* hidden grand-total anchor used by tests / exports */}
                  <span
                    className="sr-only num"
                    data-testid="bid-grand-total"
                  >
                    {formatCurrency(bid.grandTotal)}
                  </span>
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[hsl(var(--ink-3))]">
                    PCA P23 exclusions
                  </h3>
                  <p className="mt-1 text-[12px] text-[hsl(var(--ink-3))]">
                    Items checked below are <strong>not</strong> part of your
                    scope. Uncheck if a line item covers it.
                  </p>
                  <ul className="mt-3 space-y-1.5">
                    {PCA_P23_EXCLUSIONS.map((e) => (
                      <li key={e.id} className="flex items-center gap-2">
                        <input
                          id={`p23-${e.id}`}
                          type="checkbox"
                          checked={excluded.has(e.id)}
                          onChange={() => toggleExclusion(e.id)}
                          data-testid={`p23-${e.id}`}
                          className="h-4 w-4 rounded border-[hsl(var(--line))] text-[hsl(var(--brand))]"
                        />
                        <label
                          htmlFor={`p23-${e.id}`}
                          className="text-[13px] text-[hsl(var(--ink))]"
                        >
                          {e.label}
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Scope */}
              <div
                className="mt-4 rounded-[var(--radius)] border border-[hsl(var(--line))] bg-white p-5"
                data-testid="bid-scope"
              >
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[hsl(var(--ink-3))]">
                  Scope of work
                </h3>
                <p className="mt-2 text-[13px] leading-relaxed text-[hsl(var(--ink))]">
                  Painting and surface preparation. All work performed by
                  licensed painting crews to PCA P10 industry standards.
                  {excluded.size > 0 && (
                    <>
                      {" "}
                      <strong>Excluded:</strong>{" "}
                      {PCA_P23_EXCLUSIONS.filter((e) => excluded.has(e.id))
                        .map((e) => e.label.toLowerCase())
                        .join(", ")}
                      .
                    </>
                  )}
                </p>
              </div>
            </>
          )}
        </div>
      </main>
    </AppShell>
  );
}

function BidRow({
  li,
  onChange,
}: {
  li: LineItem;
  onChange: (next: LineItem) => void;
}) {
  return (
    <tr data-testid="bid-row">
      <td className="font-medium text-[hsl(var(--ink))]">
        {li.roomLabel ?? "—"}
      </td>
      <td className="capitalize text-[hsl(var(--ink-2))]">{li.type}</td>
      <td className="text-[hsl(var(--ink-2))]">{li.paintType ?? "—"}</td>
      <td className="num text-right">{li.coats}</td>
      <td className="num text-right">
        <input
          type="number"
          value={Math.round(li.quantity)}
          onChange={(e) => {
            const q = parseFloat(e.target.value) || 0;
            const ratio = q / Math.max(1, li.quantity);
            onChange({
              ...li,
              quantity: q,
              laborCost: li.laborCost * ratio,
              materialCost: li.materialCost * ratio,
            });
          }}
          className="num w-16 rounded-[4px] border border-[hsl(var(--line))] px-1.5 py-0.5 text-right text-[12px] focus:border-[hsl(var(--brand))] focus:outline-none"
        />{" "}
        <span className="text-[11px] text-[hsl(var(--ink-3))]">{li.unit}</span>
      </td>
      <td className="num text-right">{formatCurrency(li.materialCost)}</td>
      <td className="num text-right">{formatCurrency(li.laborCost)}</td>
    </tr>
  );
}

function recalcTotals(lineItems: LineItem[]) {
  const totalMaterial = lineItems.reduce((a, l) => a + l.materialCost, 0);
  const totalLabor = lineItems.reduce((a, l) => a + l.laborCost, 0);
  const subtotal = totalMaterial + totalLabor;
  const totalOverhead = subtotal * 0.1;
  const sub2 = subtotal + totalOverhead;
  const totalMarkup = sub2 * 0.2;
  const grandTotal = sub2 + totalMarkup;
  return { totalMaterial, totalLabor, totalOverhead, totalMarkup, grandTotal };
}
