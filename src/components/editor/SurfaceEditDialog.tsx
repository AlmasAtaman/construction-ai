"use client";

import { useEffect, useRef, useState } from "react";
import { useEditorStore } from "@/lib/store/editor-store";
import type { SurfaceDTO } from "@/types/surface";
import { cn } from "@/lib/utils";

const TYPE_OPTIONS = [
  { value: "wall", label: "Wall" },
  { value: "ceiling", label: "Ceiling" },
  { value: "trim", label: "Trim" },
  { value: "door", label: "Door" },
  { value: "window", label: "Window" },
];

const SUBSTRATE_OPTIONS = [
  "drywall",
  "wood",
  "metal",
  "concrete",
  "CMU",
  "acoustic_tile",
  "exposed_structure",
  "unknown",
];

interface Props {
  surface: SurfaceDTO | null;
  /** All known room labels for the project (for quick reassignment). */
  knownRoomLabels: string[];
  onClose: () => void;
}

/**
 * Inline editor for a single surface. The fastest path for an estimator
 * to correct an AI mis-detection without re-running the whole takeoff.
 *
 * Editable fields:
 *  - Room label (free text + autocomplete from known labels)
 *  - Surface type (wall/ceiling/trim/door/window)
 *  - Substrate
 *  - Quantity (sqft for wall/ceiling, lf for trim, count for door/window)
 *  - Paint type + coats
 *
 * Saves via PATCH /api/surfaces/[id]. Optimistic update on the local
 * store; rolls back on error.
 */
export function SurfaceEditDialog({ surface, knownRoomLabels, onClose }: Props) {
  const updateSurface = useEditorStore((s) => s.updateSurface);
  const [draft, setDraft] = useState<Partial<SurfaceDTO>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (surface) {
      setDraft({
        roomLabel: surface.roomLabel,
        type: surface.type,
        substrate: surface.substrate,
        squareFootage: surface.squareFootage,
        linearFootage: surface.linearFootage,
        count: surface.count,
        paintType: surface.paintType,
        coats: surface.coats,
      });
      setError(null);
      // Auto-focus room label for fast keyboard edit.
      setTimeout(() => firstFieldRef.current?.focus(), 50);
    }
  }, [surface]);

  if (!surface) return null;

  const qtyField =
    draft.type === "trim"
      ? "linearFootage"
      : draft.type === "door" || draft.type === "window"
        ? "count"
        : "squareFootage";

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      // Only send fields that actually changed.
      const patch: Record<string, unknown> = {};
      if (draft.roomLabel !== surface!.roomLabel)
        patch.roomLabel = draft.roomLabel;
      if (draft.type !== surface!.type) patch.type = draft.type;
      if (draft.substrate !== surface!.substrate)
        patch.substrate = draft.substrate;
      if (draft.squareFootage !== surface!.squareFootage)
        patch.squareFootage = draft.squareFootage ?? null;
      if (draft.linearFootage !== surface!.linearFootage)
        patch.linearFootage = draft.linearFootage ?? null;
      if (draft.count !== surface!.count) patch.count = draft.count ?? null;
      if (draft.paintType !== surface!.paintType)
        patch.paintType = draft.paintType ?? null;
      if (draft.coats !== surface!.coats) patch.coats = draft.coats;

      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }

      const res = await fetch(`/api/surfaces/${surface!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({ error: "Save failed." }));
        setError(j.error ?? "Save failed.");
        return;
      }
      // Optimistic local update.
      updateSurface(surface!.id, patch as Partial<SurfaceDTO>);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-label="Edit surface"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-[10px] border border-[hsl(var(--line))] bg-white p-5 shadow-xl"
      >
        <h3 className="text-[14px] font-semibold text-[hsl(var(--ink-1))]">
          Edit surface
        </h3>
        <p className="text-[11px] text-[hsl(var(--ink-3))]">
          Adjust the room name, type, or quantity. Changes save immediately.
        </p>

        {error && (
          <div className="mt-3 rounded-[6px] border border-red-200 bg-red-50 p-2 text-[11px] text-red-700">
            {error}
          </div>
        )}

        <div className="mt-4 space-y-3">
          {/* Room label with datalist autocomplete */}
          <label className="block">
            <span className="block text-[11px] font-medium text-[hsl(var(--ink-2))]">
              Room
            </span>
            <input
              ref={firstFieldRef}
              type="text"
              list="known-rooms"
              value={draft.roomLabel ?? ""}
              onChange={(e) => setDraft({ ...draft, roomLabel: e.target.value })}
              className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px]"
              placeholder="e.g. Kitchen, Master Bath, Corridor CE-3"
            />
            <datalist id="known-rooms">
              {knownRoomLabels.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </label>

          {/* Surface type */}
          <label className="block">
            <span className="block text-[11px] font-medium text-[hsl(var(--ink-2))]">
              Type
            </span>
            <select
              value={draft.type ?? "wall"}
              onChange={(e) =>
                setDraft({ ...draft, type: e.target.value as SurfaceDTO["type"] })
              }
              className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px]"
            >
              {TYPE_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>

          {/* Substrate */}
          <label className="block">
            <span className="block text-[11px] font-medium text-[hsl(var(--ink-2))]">
              Substrate
            </span>
            <select
              value={draft.substrate ?? "drywall"}
              onChange={(e) =>
                setDraft({ ...draft, substrate: e.target.value })
              }
              className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px]"
            >
              {SUBSTRATE_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>

          {/* Quantity (varies by type) */}
          <label className="block">
            <span className="block text-[11px] font-medium text-[hsl(var(--ink-2))]">
              {qtyField === "squareFootage"
                ? "Area (sqft)"
                : qtyField === "linearFootage"
                  ? "Linear feet"
                  : "Count"}
            </span>
            <input
              type="number"
              step={qtyField === "count" ? 1 : 0.1}
              min="0"
              value={(draft[qtyField] as number | null) ?? ""}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  [qtyField]:
                    e.target.value === "" ? null : Number(e.target.value),
                })
              }
              className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px] tabular-nums"
            />
          </label>

          {/* Paint type + coats (for paintable surfaces) */}
          {draft.type !== "door" && draft.type !== "window" && (
            <div className="grid grid-cols-3 gap-2">
              <label className="col-span-2 block">
                <span className="block text-[11px] font-medium text-[hsl(var(--ink-2))]">
                  Paint type
                </span>
                <input
                  type="text"
                  value={draft.paintType ?? ""}
                  onChange={(e) =>
                    setDraft({ ...draft, paintType: e.target.value })
                  }
                  placeholder="e.g. Eggshell, Semi-gloss"
                  className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px]"
                />
              </label>
              <label className="block">
                <span className="block text-[11px] font-medium text-[hsl(var(--ink-2))]">
                  Coats
                </span>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={draft.coats ?? 2}
                  onChange={(e) =>
                    setDraft({ ...draft, coats: Number(e.target.value) })
                  }
                  className="mt-1 w-full rounded-[6px] border border-[hsl(var(--line))] px-2 py-1.5 text-[13px] tabular-nums"
                />
              </label>
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[6px] border border-[hsl(var(--line))] px-3 py-1.5 text-[12px] font-medium text-[hsl(var(--ink-1))]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className={cn(
              "rounded-[6px] bg-[hsl(var(--brand))] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50",
            )}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
