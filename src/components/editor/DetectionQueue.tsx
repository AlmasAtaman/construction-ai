"use client";

import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/lib/store/editor-store";
import {
  SURFACE_TYPE_LABELS,
  confidenceLabel,
  type SurfaceDTO,
} from "@/types/surface";

interface Props {
  onAcceptAllHighConfidence: () => void | Promise<void>;
}

const SWATCH: Record<string, string> = {
  wall: "swatch-wall",
  ceiling: "swatch-ceiling",
  trim: "swatch-trim",
  door: "swatch-door",
  window: "swatch-window",
};

function SourceBadge({ source }: { source: string }) {
  const cls =
    source === "vector"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : source === "manual"
        ? "bg-slate-100 text-slate-700 border-slate-300"
        : "bg-sky-50 text-sky-700 border-sky-200";
  const label =
    source === "vector"
      ? "From plan"
      : source === "manual"
        ? "Hand-drawn"
        : "AI";
  return (
    <span
      className={cn(
        "ml-auto rounded border px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wide",
        cls,
      )}
      title={
        source === "vector"
          ? "Measured directly from the PDF's vector layer — deterministic, no AI guessing."
          : source === "manual"
            ? "You drew this by hand."
            : "Identified by the AI from the rendered plan image."
      }
    >
      {label}
    </span>
  );
}

export function DetectionQueue({ onAcceptAllHighConfidence }: Props) {
  const surfaces = useEditorStore((s) => s.surfaces);
  const selected = useEditorStore((s) => s.selectedSurfaceId);
  const setSelected = useEditorStore((s) => s.setSelected);
  const updateSurface = useEditorStore((s) => s.updateSurface);
  const removeSurface = useEditorStore((s) => s.removeSurface);
  const setPendingUndo = useEditorStore((s) => s.setPendingUndo);

  const proposed = useMemo(
    () => surfaces.filter((s) => s.status === "proposed"),
    [surfaces],
  );

  const highCount = proposed.filter((s) => s.confidence >= 0.8).length;

  if (proposed.length === 0) {
    return (
      <div
        data-testid="queue-placeholder"
        className="px-3 py-6 text-center text-[12px] text-[hsl(var(--ink-3))]"
      >
        <div className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-[hsl(var(--panel-2))] text-[hsl(var(--ink-3))]">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>
        <p>No pending surfaces.</p>
        <p className="mt-1">Run AI Takeoff to find walls, ceilings, trim, and openings.</p>
      </div>
    );
  }

  async function accept(s: SurfaceDTO) {
    updateSurface(s.id, { status: "accepted" });
    await fetch(`/api/surfaces/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "accepted" }),
    });
  }

  async function reject(s: SurfaceDTO) {
    const snapshot = s;
    removeSurface(s.id);
    await fetch(`/api/surfaces/${s.id}`, { method: "DELETE" });
    setPendingUndo({
      label: `Removed a ${s.type}${s.roomLabel ? ` in ${s.roomLabel}` : ""}.`,
      expiresAt: Date.now() + 5000,
      undo: async () => {
        const res = await fetch("/api/surfaces", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: snapshot.projectId,
            planPageId: snapshot.planPageId,
            type: snapshot.type,
            polygon: snapshot.polygon,
            paintType: snapshot.paintType,
            coats: snapshot.coats,
            substrate: snapshot.substrate,
            roomLabel: snapshot.roomLabel,
            squareFootage: snapshot.squareFootage,
            linearFootage: snapshot.linearFootage,
            count: snapshot.count,
            status: "proposed",
            source: "ai",
          }),
        });
        if (res.ok) {
          const json = await res.json();
          useEditorStore.getState().addSurface(json.surface);
        }
      },
    });
  }

  return (
    <div data-testid="detection-queue" className="flex flex-col">
      <div className="flex items-center justify-between border-b border-[hsl(var(--line-2))] px-3 py-2">
        <span className="text-[12px] text-[hsl(var(--ink-2))]">
          <span className="num font-semibold text-[hsl(var(--ink))]">
            {proposed.length}
          </span>{" "}
          pending
        </span>
        {highCount > 0 && (
          <Button
            size="sm"
            variant="accent"
            onClick={() => void onAcceptAllHighConfidence()}
            data-testid="accept-all-high"
          >
            Accept {highCount} high
          </Button>
        )}
      </div>

      <ul className="flex-1 divide-y divide-[hsl(var(--line-2))]">
        {proposed.map((s) => {
          const conf = confidenceLabel(s.confidence);
          const isSelected = selected === s.id;
          const qty = s.squareFootage
            ? `${Math.round(s.squareFootage)} sqft`
            : s.linearFootage
              ? `${Math.round(s.linearFootage)} lf`
              : s.count
                ? `${s.count} ea`
                : "—";
          return (
            <li
              key={s.id}
              data-testid="queue-item"
              data-surface-id={s.id}
              data-confidence={conf}
              className={`cursor-pointer px-3 py-2.5 transition-colors ${
                isSelected
                  ? "bg-[hsl(var(--brand-soft))]"
                  : "hover:bg-[hsl(var(--panel-2))]"
              }`}
              onClick={() => setSelected(s.id)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block h-2.5 w-2.5 flex-shrink-0 rounded-sm ${SWATCH[s.type]}`}
                    />
                    <span className="truncate text-[13px] font-medium text-[hsl(var(--ink))]">
                      {s.roomLabel || SURFACE_TYPE_LABELS[s.type]}
                    </span>
                    <span className={`pill pill-${conf}`}>{conf}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[hsl(var(--ink-3))]">
                    <span className="capitalize">
                      {SURFACE_TYPE_LABELS[s.type]}
                    </span>
                    <span>·</span>
                    <span className="num">{qty}</span>
                    {s.substrate && (
                      <>
                        <span>·</span>
                        <span>{s.substrate}</span>
                      </>
                    )}
                    <SourceBadge source={s.source} />
                  </div>
                </div>
              </div>
              <div className="mt-2 flex gap-1.5">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={(e) => {
                    e.stopPropagation();
                    void accept(s);
                  }}
                  data-testid="accept-surface"
                  className="h-7 flex-1"
                >
                  Accept
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={(e) => {
                    e.stopPropagation();
                    void reject(s);
                  }}
                  data-testid="reject-surface"
                  className="h-7 flex-1"
                >
                  Reject
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
