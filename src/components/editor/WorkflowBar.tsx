"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useEditorStore } from "@/lib/store/editor-store";
import { TakeoffLayersPanel } from "./TakeoffLayersPanel";
import { PlanTakeoffButton } from "./PlanTakeoffButton";
import { cn } from "@/lib/utils";

/**
 * The takeoff spine — a full-width workflow strip under the top bar, styled
 * like a drawing sheet's title block. Five numbered segments mirror the
 * estimator's real sequence (plans → scale → takeoff → review → estimate),
 * each showing live data and each clickable to act. It is a status
 * instrument, not a wizard: nothing is gated, the numbering just encodes
 * the dependency order of a takeoff. It is also the single home of every
 * takeoff trigger (paint takeoff, trace all walls, whole plan, layers,
 * reset) so orange means exactly one thing: the next action.
 */

type StepState = "todo" | "current" | "done";

interface Props {
  hasPlan: boolean;
  pageCount: number;
  currentPage: number;
  planPageId: string | null;
  planId: string | null;
  onAutoTraced: () => void;
  onOpenReview: () => void;
  onOpenEstimate: () => void;
}

export function WorkflowBar({
  hasPlan,
  pageCount,
  currentPage,
  planPageId,
  planId,
  onAutoTraced,
  onOpenReview,
  onOpenEstimate,
}: Props) {
  const surfaces = useEditorStore((s) => s.surfaces);
  const pageScale = useEditorStore((s) => s.pageScale);
  const requestScaleEdit = useEditorStore((s) => s.requestScaleEdit);
  const requestPaintScope = useEditorStore((s) => s.requestPaintScope);
  const paintScopeActive = useEditorStore((s) => s.paintScopeActive);
  const estimateSummary = useEditorStore((s) => s.estimateSummary);

  const [takeoffOpen, setTakeoffOpen] = useState(false);
  const [autoTracing, setAutoTracing] = useState(false);
  const [autoTraceMsg, setAutoTraceMsg] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const proposedCount = useMemo(
    () => surfaces.filter((s) => s.status === "proposed").length,
    [surfaces],
  );
  const keptCount = useMemo(
    () =>
      surfaces.filter((s) => s.status === "accepted" || s.status === "manual")
        .length,
    [surfaces],
  );

  // Close the takeoff panel on outside click / Escape.
  useEffect(() => {
    if (!takeoffOpen) return;
    function onDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setTakeoffOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setTakeoffOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [takeoffOpen]);

  async function runAutoTrace(
    opts: { reset?: boolean; wallLayers?: string[] } = {},
  ) {
    const { reset = false, wallLayers } = opts;
    if (!planPageId || autoTracing) return;
    if (
      reset &&
      !window.confirm(
        "Reset all traced walls on this page back to the AI's version? Your manual edits to walls on this page will be discarded.",
      )
    ) {
      return;
    }
    setAutoTracing(true);
    setAutoTraceMsg(null);
    try {
      const res = await fetch(`/api/plan-pages/${planPageId}/auto-trace`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reset, autoClean: true, wallLayers }),
      });
      if (!res.ok) {
        setAutoTraceMsg("Wall tracing failed. Try again.");
        return;
      }
      const json = (await res.json()) as {
        count: number;
        cleanedOut?: number;
        skippedExisting?: number;
        hasScale: boolean;
        method?: "layers" | "geometry";
      };
      const fromLayers = json.method === "layers" ? " from CAD layers" : "";
      setAutoTraceMsg(
        json.count === 0
          ? json.skippedExisting
            ? `All ${json.skippedExisting} walls already kept — nothing new.`
            : "No walls found on this sheet."
          : `${json.count} wall${json.count === 1 ? "" : "s"} found${fromLayers}${json.hasScale ? " — review them on the right." : " — set the scale to price them."}`,
      );
      onAutoTraced();
    } catch {
      setAutoTraceMsg("Wall tracing failed. Try again.");
    } finally {
      setAutoTracing(false);
      window.setTimeout(() => setAutoTraceMsg(null), 8000);
    }
  }

  // Derive each segment's state. "current" = the estimator's next move.
  const scaleState: StepState = !hasPlan
    ? "todo"
    : pageScale
      ? "done"
      : pageScale === null
        ? "current"
        : "todo"; // undefined = still loading
  const planState: StepState = hasPlan ? "done" : "current";
  const takeoffState: StepState =
    hasPlan && pageScale && keptCount + proposedCount === 0
      ? "current"
      : keptCount + proposedCount > 0
        ? "done"
        : "todo";
  const reviewState: StepState =
    proposedCount > 0 ? "current" : keptCount > 0 ? "done" : "todo";
  const estimateState: StepState =
    proposedCount === 0 && keptCount > 0 ? "current" : "todo";

  const money = (n: number) =>
    n.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    });

  return (
    <div className="relative" data-testid="workflow-bar">
      <div className="spine">
        <Segment
          num="1"
          label="Plans"
          state={planState}
          title={
            hasPlan
              ? `${pageCount} sheets in this set — pick a sheet in the Pages list`
              : "Upload the plan set to begin"
          }
        >
          {hasPlan ? (
            <span className="spine-val">
              <strong className="num">{pageCount}</strong> sheets · p
              <span className="num">{currentPage}</span>
            </span>
          ) : (
            <span className="spine-val">Upload the plan set</span>
          )}
        </Segment>

        <Segment
          num="2"
          label="Scale"
          state={scaleState}
          onClick={hasPlan ? () => requestScaleEdit() : undefined}
          testId="spine-scale"
          title={
            pageScale
              ? `${pageScale.label} — ${pageScale.method === "user" ? "set by you" : "read from the sheet"}. Click to verify or recalibrate.`
              : "Set this sheet's scale — click two points on a known dimension"
          }
        >
          {pageScale ? (
            <span className="spine-val">
              <strong className="num">{pageScale.label}</strong>
              <CheckMark />
            </span>
          ) : pageScale === null ? (
            <span className="spine-val text-amber-700">Set the scale</span>
          ) : (
            <span className="spine-val">—</span>
          )}
        </Segment>

        <Segment
          num="3"
          label="Takeoff"
          state={takeoffState}
          onClick={hasPlan ? () => setTakeoffOpen((v) => !v) : undefined}
          testId="spine-takeoff"
          expanded={takeoffOpen}
          title="Run the takeoff — paint scope from the finish schedule, or trace every wall"
        >
          <span className="spine-val">
            {keptCount > 0 ? (
              <>
                <strong className="num">{keptCount}</strong> kept
              </>
            ) : autoTracing ? (
              "Working…"
            ) : (
              "Run takeoff"
            )}
          </span>
          <Chevron open={takeoffOpen} />
        </Segment>

        <Segment
          num="4"
          label="Review"
          state={reviewState}
          onClick={onOpenReview}
          testId="spine-review"
          title={
            proposedCount > 0
              ? `${proposedCount} proposed walls waiting — accept or reject each`
              : "Nothing waiting for review"
          }
        >
          {proposedCount > 0 ? (
            <span className="spine-val">
              <strong className="num">{proposedCount}</strong> to review
            </span>
          ) : (
            <span className="spine-val">
              {keptCount > 0 ? (
                <>
                  Clear
                  <CheckMark />
                </>
              ) : (
                "—"
              )}
            </span>
          )}
        </Segment>

        <Segment
          num="5"
          label="Estimate"
          state={estimateState}
          onClick={onOpenEstimate}
          testId="spine-estimate"
          title="The live estimate built from every kept measurement"
          last
        >
          {estimateSummary && estimateSummary.grandTotal > 0 ? (
            <span className="spine-val">
              <strong className="num">
                {money(estimateSummary.grandTotal)}
              </strong>
            </span>
          ) : (
            <span className="spine-val">—</span>
          )}
        </Segment>
      </div>

      {/* Takeoff console — every way to measure, in one place. */}
      {takeoffOpen && (
        <div
          ref={panelRef}
          data-testid="takeoff-console"
          className="absolute left-1/2 top-full z-40 mt-1 w-[400px] -translate-x-1/2 rounded-md border border-[hsl(var(--line))] bg-white shadow-lg"
        >
          <div className="border-b border-[hsl(var(--line-2))] px-3 py-2">
            <div className="font-display text-[11.5px] font-semibold uppercase tracking-[0.08em] text-[hsl(var(--ink-2))]">
              Run the takeoff
            </div>
          </div>
          <div className="space-y-2 p-3">
            <button
              type="button"
              onClick={() => {
                requestPaintScope();
                setTakeoffOpen(false);
              }}
              data-testid="paint-takeoff"
              className={cn(
                "flex w-full items-start gap-2.5 rounded-[8px] px-3 py-2.5 text-left text-white shadow-sm transition-colors",
                paintScopeActive
                  ? "bg-[hsl(var(--accent-hover))]"
                  : "bg-[hsl(var(--accent))] hover:brightness-95",
              )}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" className="mt-0.5 flex-shrink-0">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 3v4M3 5h4M6 17v4M4 19h4M13 3l2.5 6.5L22 12l-6.5 2.5L13 21l-2.5-6.5L4 12l6.5-2.5z" />
              </svg>
              <span>
                <span className="block text-[12.5px] font-semibold">
                  {paintScopeActive ? "Hide paint scope" : "Paint takeoff"}
                </span>
                <span className="block text-[11px] leading-snug text-white/85">
                  Reads the finish schedule and plan notes, measures each
                  painted room at its real height, shows one total to apply.
                </span>
              </span>
            </button>

            <button
              type="button"
              onClick={() => void runAutoTrace()}
              disabled={autoTracing}
              data-testid="ai-takeoff"
              className="flex w-full items-start gap-2.5 rounded-[8px] border border-[hsl(var(--line))] bg-white px-3 py-2.5 text-left shadow-sm transition-colors hover:bg-[hsl(var(--panel-2))] disabled:opacity-60"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" className="mt-0.5 flex-shrink-0 text-[hsl(var(--ink-2))]">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 20 20 4M4 20v-5m0 5h5M20 4v5m0-5h-5" />
              </svg>
              <span>
                <span className="block text-[12.5px] font-semibold text-[hsl(var(--ink))]">
                  {autoTracing ? "Tracing walls…" : "Trace all walls on this sheet"}
                </span>
                <span className="block text-[11px] leading-snug text-[hsl(var(--ink-3))]">
                  Every wall from the CAD layers, unscoped — each lands in
                  Review for you to accept or reject.
                </span>
              </span>
            </button>

            <div className="flex items-center gap-1.5">
              <div className="flex-1">
                <PlanTakeoffButton
                  planId={planId}
                  variant="secondary"
                  onComplete={onAutoTraced}
                />
              </div>
              <TakeoffLayersPanel
                planPageId={planPageId ?? ""}
                busy={autoTracing}
                onRunTakeoff={(layers) =>
                  void runAutoTrace({ wallLayers: layers })
                }
              />
              <button
                type="button"
                onClick={() => void runAutoTrace({ reset: true })}
                disabled={autoTracing}
                data-testid="reset-to-ai-walls"
                title="Discard manual wall edits on this sheet and re-run the takeoff."
                className="inline-flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-[8px] border border-[hsl(var(--line))] bg-white text-[hsl(var(--ink-3))] hover:bg-[hsl(var(--panel-2))] hover:text-[hsl(var(--ink))]"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-7 3.4M3 4v4h4" />
                </svg>
              </button>
            </div>

            {autoTraceMsg && (
              <p
                data-testid="takeoff-message"
                className="rounded-[6px] bg-[hsl(var(--panel-2))] px-2.5 py-1.5 text-[11.5px] text-[hsl(var(--ink-2))]"
              >
                {autoTraceMsg}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Segment({
  num,
  label,
  state,
  onClick,
  children,
  title,
  testId,
  expanded,
  last,
}: {
  num: string;
  label: string;
  state: StepState;
  onClick?: () => void;
  children: React.ReactNode;
  title?: string;
  testId?: string;
  expanded?: boolean;
  last?: boolean;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      data-state={state}
      data-testid={testId}
      aria-expanded={expanded}
      title={title}
      className={cn(
        "spine-seg",
        onClick && "cursor-pointer",
        last && "border-r-0",
        "flex-1",
      )}
    >
      <span className="spine-num num">{state === "done" ? "✓" : num}</span>
      <span className="spine-label">{label}</span>
      {children}
    </Tag>
  );
}

function CheckMark() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" className="ml-1 inline text-emerald-600">
      <path strokeLinecap="round" strokeLinejoin="round" d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={cn(
        "flex-shrink-0 text-[hsl(var(--ink-3))] transition-transform",
        open && "rotate-180",
      )}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
    </svg>
  );
}
