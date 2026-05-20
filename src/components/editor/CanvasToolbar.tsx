"use client";

import { useEffect, useMemo, useState } from "react";
import { useEditorStore, MIN_ZOOM, MAX_ZOOM } from "@/lib/store/editor-store";
import { cn } from "@/lib/utils";

interface CanvasToolbarProps {
  /** Current plan page — enables the "Auto-trace walls" action. */
  planPageId?: string | null;
  /** Called after an auto-trace run so the workspace can refresh. */
  onAutoTraced?: () => void;
}

export function CanvasToolbar({ planPageId, onAutoTraced }: CanvasToolbarProps = {}) {
  const zoom = useEditorStore((s) => s.zoom);
  const setViewport = useEditorStore((s) => s.setViewport);
  const resetViewport = useEditorStore((s) => s.resetViewport);
  const showAiOverlay = useEditorStore((s) => s.showAiOverlay);
  const setShowAiOverlay = useEditorStore((s) => s.setShowAiOverlay);
  const visibleTypes = useEditorStore((s) => s.visibleTypes);
  const toggleType = useEditorStore((s) => s.toggleType);
  const surfaces = useEditorStore((s) => s.surfaces);

  // Per-type counts. Skip excluded, skip annotations and symbol counts
  // (those are not "paintable surfaces" the user is verifying).
  const counts = useMemo(() => {
    const c = {
      wall: 0,
      ceiling: 0,
      trim: 0,
      door: 0,
      window: 0,
      total: 0,
    };
    for (const s of surfaces) {
      if (s.status === "excluded") continue;
      if (s.type.startsWith("annotation:") || s.type.startsWith("symbol:"))
        continue;
      // Wall-path traces are a separate primitive with their own
      // rendering; they aren't part of the per-type polygon counts.
      if (s.type === "wall-path") continue;
      if (s.type in c) c[s.type as keyof typeof c] += 1;
      c.total += 1;
    }
    return c;
  }, [surfaces]);

  const [autoTracing, setAutoTracing] = useState(false);
  const [autoTraceMsg, setAutoTraceMsg] = useState<string | null>(null);

  async function runAutoTrace() {
    if (!planPageId || autoTracing) return;
    setAutoTracing(true);
    setAutoTraceMsg(null);
    try {
      const res = await fetch(`/api/plan-pages/${planPageId}/auto-trace`, {
        method: "POST",
      });
      if (!res.ok) {
        setAutoTraceMsg("Auto-trace failed.");
        return;
      }
      const json = (await res.json()) as { count: number; hasScale: boolean };
      setAutoTraceMsg(
        `${json.count} wall path${json.count === 1 ? "" : "s"} proposed${json.hasScale ? "" : " (set scale for ft)"}.`,
      );
      onAutoTraced?.();
    } catch {
      setAutoTraceMsg("Auto-trace failed.");
    } finally {
      setAutoTracing(false);
      window.setTimeout(() => setAutoTraceMsg(null), 6000);
    }
  }

  function zoomIn() {
    setViewport({ zoom: Math.min(MAX_ZOOM, zoom * 1.25) });
  }
  function zoomOut() {
    setViewport({ zoom: Math.max(MIN_ZOOM, zoom / 1.25) });
  }

  // Keyboard shortcuts: +, -, 0. Ignore when typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomIn();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        resetViewport();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  return (
    <div
      data-testid="canvas-toolbar"
      className="pointer-events-none absolute inset-x-0 top-2 z-20 flex items-start justify-between gap-2 px-3"
    >
      {/* Left cluster — zoom controls */}
      <div className="pointer-events-auto flex items-center gap-1 rounded-[8px] border border-[hsl(var(--line))] bg-white/95 px-1 py-1 shadow-sm backdrop-blur">
        <ToolbarButton
          onClick={zoomOut}
          title="Zoom out (−)"
          aria-label="Zoom out"
          disabled={zoom <= MIN_ZOOM}
          testId="zoom-out"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" d="M5 12h14" />
          </svg>
        </ToolbarButton>
        <button
          type="button"
          onClick={resetViewport}
          title="Reset zoom (0)"
          className="min-w-[52px] rounded-[5px] px-2 py-1 text-center text-[11.5px] font-medium tabular-nums text-[hsl(var(--ink))] hover:bg-[hsl(var(--panel-2))]"
          data-testid="zoom-reset"
        >
          {Math.round(zoom * 100)}%
        </button>
        <ToolbarButton
          onClick={zoomIn}
          title="Zoom in (+)"
          aria-label="Zoom in"
          disabled={zoom >= MAX_ZOOM}
          testId="zoom-in"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" d="M5 12h14M12 5v14" />
          </svg>
        </ToolbarButton>
      </div>

      {/* Right cluster — auto-trace + counts + AI overlay toggle */}
      <div className="pointer-events-auto flex items-center gap-2">
        {planPageId && (
          <div className="flex items-center gap-1.5">
            {autoTraceMsg && (
              <span className="rounded-[6px] border border-[hsl(var(--line))] bg-white/95 px-2 py-1 text-[11px] text-[hsl(var(--ink-2))] shadow-sm backdrop-blur">
                {autoTraceMsg}
              </span>
            )}
            <button
              type="button"
              onClick={() => void runAutoTrace()}
              disabled={autoTracing}
              data-testid="auto-trace-walls"
              title="Propose a wall-path trace along the extracted walls. Review and edit the result; it does not replace room detection."
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[8px] border px-2.5 py-1.5 text-[11.5px] font-medium shadow-sm backdrop-blur transition-colors",
                autoTracing
                  ? "border-[hsl(var(--line))] bg-white/95 text-[hsl(var(--ink-3))]"
                  : "border-[hsl(var(--brand))] bg-[hsl(var(--brand-soft))] text-[hsl(var(--brand))] hover:brightness-95",
              )}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 18 L9 18 L9 7 L17 7 L17 14 L21 14" />
              </svg>
              {autoTracing ? "Tracing…" : "Auto-trace walls"}
            </button>
          </div>
        )}
        {counts.total > 0 && (
          <div
            data-testid="surface-count-chip"
            className="flex items-center gap-1.5 rounded-[8px] border border-[hsl(var(--line))] bg-white/95 px-2.5 py-1.5 text-[11.5px] shadow-sm backdrop-blur"
            title="Paintable surfaces detected on this page. Click a type to show/hide its polygons."
          >
            <span className="num font-semibold text-[hsl(var(--ink))]">
              {counts.total}
            </span>
            <span className="text-[hsl(var(--ink-3))]">surfaces</span>
            <span className="h-3 w-px bg-[hsl(var(--line))]" />
            <TypeToggle
              label="walls"
              n={counts.wall}
              swatchKey="wall"
              active={visibleTypes.wall}
              onClick={() => toggleType("wall")}
            />
            <TypeToggle
              label="ceilings"
              n={counts.ceiling}
              swatchKey="ceiling"
              active={visibleTypes.ceiling}
              onClick={() => toggleType("ceiling")}
            />
            <TypeToggle
              label="trim"
              n={counts.trim}
              swatchKey="trim"
              active={visibleTypes.trim}
              onClick={() => toggleType("trim")}
            />
            <TypeToggle
              label="doors"
              n={counts.door}
              swatchKey="door"
              active={visibleTypes.door}
              onClick={() => toggleType("door")}
            />
            <TypeToggle
              label="windows"
              n={counts.window}
              swatchKey="window"
              active={visibleTypes.window}
              onClick={() => toggleType("window")}
            />
          </div>
        )}

        <button
          type="button"
          onClick={() => setShowAiOverlay(!showAiOverlay)}
          data-testid="toggle-ai-overlay"
          aria-pressed={showAiOverlay}
          title={
            showAiOverlay
              ? "Hide the AI overlay to see the bare blueprint"
              : "Show the AI-detected surfaces again"
          }
          className={cn(
            "rounded-[8px] border px-2.5 py-1.5 text-[11.5px] font-medium shadow-sm backdrop-blur transition-colors",
            showAiOverlay
              ? "border-[hsl(var(--line))] bg-white/95 text-[hsl(var(--ink))] hover:bg-[hsl(var(--panel-2))]"
              : "border-[hsl(var(--brand))] bg-[hsl(var(--brand-soft))] text-[hsl(var(--brand))]",
          )}
        >
          {showAiOverlay ? "Hide AI overlay" : "Show AI overlay"}
        </button>
      </div>
    </div>
  );
}

function ToolbarButton({
  onClick,
  title,
  testId,
  disabled,
  children,
  ...rest
}: {
  onClick: () => void;
  title: string;
  testId?: string;
  disabled?: boolean;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      data-testid={testId}
      className="flex h-7 w-7 items-center justify-center rounded-[5px] text-[hsl(var(--ink-2))] hover:bg-[hsl(var(--panel-2))] hover:text-[hsl(var(--ink))] disabled:opacity-40 disabled:hover:bg-transparent"
      {...rest}
    >
      {children}
    </button>
  );
}

function TypeToggle({
  label,
  n,
  swatchKey,
  active,
  onClick,
}: {
  label: string;
  n: number;
  swatchKey: string;
  active: boolean;
  onClick: () => void;
}) {
  if (n === 0) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`type-toggle-${swatchKey}`}
      aria-pressed={active}
      title={active ? `Hide ${label}` : `Show ${label}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-[4px] px-1 py-0.5 transition-colors",
        active
          ? "text-[hsl(var(--ink-2))] hover:bg-[hsl(var(--panel-2))]"
          : "text-[hsl(var(--ink-3))] line-through opacity-60 hover:opacity-90",
      )}
    >
      <span
        className={cn(
          "inline-block h-2 w-2 rounded-sm",
          active ? `swatch-${swatchKey}` : "bg-[hsl(var(--line))]",
        )}
      />
      <span
        className={cn(
          "num font-medium",
          active ? "text-[hsl(var(--ink))]" : "text-[hsl(var(--ink-3))]",
        )}
      >
        {n}
      </span>
      <span>{label}</span>
    </button>
  );
}
