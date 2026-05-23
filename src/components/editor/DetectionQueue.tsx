"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/lib/store/editor-store";
import {
  SURFACE_TYPE_LABELS,
  confidenceLabel,
  type SurfaceDTO,
} from "@/types/surface";
import { SurfaceEditDialog } from "./SurfaceEditDialog";

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

/**
 * Shows how the surface's polygon coordinates were produced. Distinct
 * from the broader source badge: this is specifically about whether
 * the contractor can trust the BOX position on the plan.
 */
function DerivationBadge({ derivation }: { derivation: string | null }) {
  if (!derivation) return null;
  const styles: Record<string, { cls: string; label: string; title: string }> = {
    "scale-measured": {
      cls: "bg-emerald-50 text-emerald-700 border-emerald-200",
      label: "Scale-measured",
      title:
        "Wall length and area measured from the plan's vector geometry × the established scale. Deterministic, not estimated.",
    },
    "table-cross-checked": {
      cls: "bg-emerald-50 text-emerald-800 border-emerald-300",
      label: "Table ✓ scale",
      title:
        "Printed dimension table and scale-measured geometry agree within ±10 %. Highest confidence — both sources back this number.",
    },
    traced: {
      cls: "bg-sky-50 text-sky-700 border-sky-200",
      label: "Traced",
      title:
        "Box outline came from real wall segments in the PDF's vector layer. Dimensions are from the printed table.",
    },
    "sized-from-dimensions": {
      cls: "bg-amber-50 text-amber-800 border-amber-200",
      label: "Sized from dims",
      title:
        "Box is a rectangle sized from the room's printed dimensions, anchored to its label. Position is approximate; size is accurate.",
    },
    "table-only": {
      cls: "bg-slate-100 text-slate-600 border-slate-300",
      label: "Table only",
      title:
        "Room dimensions came from the printed schedule. No reliable on-plan placement — the room shows in the queue but no box is drawn.",
    },
    "virtual-partition": {
      cls: "bg-amber-50 text-amber-800 border-amber-300",
      label: "Estimated boundary",
      title:
        "This room has no fully enclosing walls (open plan). The boundary was computed by partitioning the open zone between nearby labels, snapped to the real walls that do exist. Review before bidding — the dimensions are an honest estimate, not a traced measurement.",
    },
    "scale-needed": {
      cls: "bg-orange-50 text-orange-800 border-orange-300",
      label: "Scale needed",
      title:
        "Room found in the PDF's vector layer, but no scale is established for this page. Set the scale in the banner above to see real measurements.",
    },
    "ai-fallback": {
      cls: "bg-rose-50 text-rose-700 border-rose-200",
      label: "AI guess",
      title:
        "Box position is an AI estimate — the deterministic extractor couldn't pair this room with real geometry. Double-check before accepting.",
    },
    manual: {
      cls: "bg-slate-100 text-slate-700 border-slate-300",
      label: "Drawn",
      title: "You drew this box by hand.",
    },
  };
  const s = styles[derivation];
  if (!s) return null;
  return (
    <span
      className={cn(
        "rounded border px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wide",
        s.cls,
      )}
      title={s.title}
    >
      {s.label}
    </span>
  );
}

export function DetectionQueue({ onAcceptAllHighConfidence }: Props) {
  const surfaces = useEditorStore((s) => s.surfaces);
  const selected = useEditorStore((s) => s.selectedSurfaceId);
  const setSelected = useEditorStore((s) => s.setSelected);
  const setHovered = useEditorStore((s) => s.setHovered);
  const updateSurface = useEditorStore((s) => s.updateSurface);
  const removeSurface = useEditorStore((s) => s.removeSurface);
  const setPendingUndo = useEditorStore((s) => s.setPendingUndo);

  const proposed = useMemo(
    () => surfaces.filter((s) => s.status === "proposed"),
    [surfaces],
  );

  const highCount = proposed.filter((s) => s.confidence >= 0.8).length;
  const lowCount = proposed.filter(
    (s) => confidenceLabel(s.confidence) === "low",
  ).length;

  // All known room labels in this project — for the edit dialog datalist
  // and the "reassign" affordance.
  const knownRoomLabels = useMemo(() => {
    const set = new Set<string>();
    for (const s of surfaces) {
      if (s.roomLabel) set.add(s.roomLabel);
    }
    return [...set].sort();
  }, [surfaces]);

  const [editing, setEditing] = useState<SurfaceDTO | null>(null);

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
        <p>Nothing to review yet.</p>
        <p className="mt-1">Click <strong>Measure my plan</strong> to find walls, ceilings, trim, doors, and windows.</p>
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
    setPendingUndo({
      label: `Accepted ${s.roomLabel || SURFACE_TYPE_LABELS[s.type]}.`,
      expiresAt: Date.now() + 5000,
      undo: async () => {
        useEditorStore.getState().updateSurface(s.id, { status: "proposed" });
        await fetch(`/api/surfaces/${s.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "proposed" }),
        });
      },
    });
  }

  /** Re-create a rejected surface as a fresh proposal (used by undo). */
  async function recreateAsProposed(snap: SurfaceDTO) {
    const res = await fetch("/api/surfaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: snap.projectId,
        planPageId: snap.planPageId,
        type: snap.type,
        polygon: snap.polygon,
        pathPoints: snap.pathPoints,
        paintType: snap.paintType,
        coats: snap.coats,
        substrate: snap.substrate,
        roomLabel: snap.roomLabel,
        squareFootage: snap.squareFootage,
        linearFootage: snap.linearFootage,
        count: snap.count,
        confidence: snap.confidence,
        derivation: snap.derivation,
        status: "proposed",
        source: "ai",
      }),
    });
    if (res.ok) {
      const json = await res.json();
      useEditorStore.getState().addSurface(json.surface);
    }
  }

  async function rejectAllLow() {
    const low = proposed.filter((s) => confidenceLabel(s.confidence) === "low");
    if (low.length === 0) return;
    for (const s of low) removeSurface(s.id);
    await Promise.all(
      low.map((s) => fetch(`/api/surfaces/${s.id}`, { method: "DELETE" })),
    );
    setPendingUndo({
      label: `Removed ${low.length} low-confidence item${low.length === 1 ? "" : "s"}.`,
      expiresAt: Date.now() + 6000,
      undo: async () => {
        await Promise.all(low.map((s) => recreateAsProposed(s)));
      },
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
          to review
        </span>
        <div className="flex items-center gap-1.5">
          {lowCount > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void rejectAllLow()}
              data-testid="reject-all-low"
              title="Remove all low-confidence proposals (you can undo)."
            >
              Reject {lowCount} low
            </Button>
          )}
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
              onMouseEnter={() => setHovered(s.id)}
              onMouseLeave={() => setHovered(null)}
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
                    <span
                      title={`${conf === "high" ? "Looks good" : conf === "medium" ? "Worth a glance" : "Please double-check"} (confidence: ${Math.round(s.confidence * 100)}%)`}
                      className={cn(
                        "inline-block h-2 w-2 flex-shrink-0 rounded-full",
                        conf === "high"
                          ? "bg-emerald-500"
                          : conf === "medium"
                            ? "bg-amber-400"
                            : "bg-red-500",
                      )}
                    />
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
                    <DerivationBadge derivation={s.derivation} />
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
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditing(s);
                  }}
                  data-testid="edit-surface"
                  className="h-7 px-2"
                  title="Edit room label, type, or quantity"
                >
                  Edit
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
      <SurfaceEditDialog
        surface={editing}
        knownRoomLabels={knownRoomLabels}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}
