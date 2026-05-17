"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ProgressStage =
  | "rendering"
  | "classifying"
  | "skipped"
  | "reading_plan"
  | "validating"
  | "persisting"
  | "done"
  | "error";

interface Step {
  id: ProgressStage;
  label: string;
  detail: string;
  estimatedSeconds: number;
}

const STEPS: Step[] = [
  {
    id: "rendering",
    label: "Rendering the page",
    detail: "Converting your PDF to a clean image and reading printed text.",
    estimatedSeconds: 2,
  },
  {
    id: "classifying",
    label: "Checking the sheet type",
    detail: "Skipping cover pages, elevations, and schedules to save money.",
    estimatedSeconds: 4,
  },
  {
    id: "reading_plan",
    label: "Reading the floor plan",
    detail:
      "Identifying every wall, ceiling, door, and window. Counts and areas only.",
    estimatedSeconds: 30,
  },
  {
    id: "validating",
    label: "Double-checking the math",
    detail:
      "A second pass catches impossible numbers, missed rooms, and confusion between floor area and wall area.",
    estimatedSeconds: 6,
  },
  {
    id: "persisting",
    label: "Saving the results",
    detail: "Adding surfaces to your detection queue.",
    estimatedSeconds: 1,
  },
];

interface Props {
  stage: ProgressStage | null;
  message?: string;
  pageType?: string;
  classifierConfidence?: number;
  visible: boolean;
  errorTitle?: string;
  errorBody?: string;
  errorDetails?: string;
  onDismiss?: () => void;
  onRetry?: () => void;
}

export function TakeoffProgress({
  stage,
  message,
  pageType,
  classifierConfidence,
  visible,
  errorTitle,
  errorBody,
  errorDetails,
  onDismiss,
  onRetry,
}: Props) {
  // Esc-to-close on terminal states (error / done / skipped). In-progress
  // stages stay modal — the user shouldn't be able to dismiss mid-flight
  // and end up thinking the takeoff stopped when it hasn't.
  useEffect(() => {
    if (!visible) return;
    const isTerminal =
      stage === "error" || stage === "done" || stage === "skipped";
    if (!isTerminal || !onDismiss) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onDismiss?.();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, stage, onDismiss]);

  if (!visible) return null;

  // Error state gets a different layout — no step list, just a clear
  // message + retry / close. Keeps the "AI Takeoff" framing so it doesn't
  // feel like an unrelated alert.
  if (stage === "error") {
    return (
      <div
        data-testid="takeoff-progress"
        data-stage="error"
        role="alertdialog"
        aria-labelledby="takeoff-error-title"
        className="fixed inset-0 z-40 flex items-center justify-center bg-[hsl(var(--ink))]/40 px-4 backdrop-blur-[2px]"
        onClick={(e) => {
          if (e.target === e.currentTarget) onDismiss?.();
        }}
      >
        <div
          data-testid="takeoff-error"
          className="w-full max-w-md rounded-[10px] border border-[hsl(var(--line))] bg-white shadow-2xl"
        >
          <header className="flex items-start gap-3 border-b border-[hsl(var(--line))] px-5 py-4">
            <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[hsl(var(--danger))]/10 text-[hsl(var(--danger))]">
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
                />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[hsl(var(--danger))]">
                AI Takeoff failed
              </div>
              <h3
                id="takeoff-error-title"
                className="mt-0.5 text-[15px] font-semibold leading-tight text-[hsl(var(--ink))]"
              >
                {errorTitle ?? "Couldn't analyze your blueprint"}
              </h3>
            </div>
          </header>

          {errorBody && (
            <div className="px-5 py-4 text-[13px] leading-[1.5] text-[hsl(var(--ink-2))]">
              {errorBody}
            </div>
          )}

          {errorDetails && (
            <details className="group border-t border-[hsl(var(--line))] px-5 py-3 text-[12px]">
              <summary className="cursor-pointer select-none text-[hsl(var(--ink-3))] hover:text-[hsl(var(--ink-2))]">
                Show technical details
              </summary>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-[4px] bg-[hsl(var(--panel-2))] px-2.5 py-2 text-[11px] leading-snug text-[hsl(var(--ink-2))]">
                {errorDetails}
              </pre>
            </details>
          )}

          <footer className="flex justify-end gap-2 border-t border-[hsl(var(--line))] bg-[hsl(var(--panel-2))] px-5 py-3">
            <Button
              variant="secondary"
              onClick={() => onDismiss?.()}
              data-testid="takeoff-error-close"
            >
              Close
            </Button>
            {onRetry && (
              <Button
                onClick={() => {
                  onDismiss?.();
                  onRetry();
                }}
                data-testid="takeoff-error-retry"
              >
                Try again
              </Button>
            )}
          </footer>
        </div>
      </div>
    );
  }

  const currentIdx = stage
    ? Math.max(
        0,
        STEPS.findIndex((s) => s.id === stage),
      )
    : 0;
  const isTerminal = stage === "done" || stage === "skipped";

  return (
    <div
      data-testid="takeoff-progress"
      data-stage={stage ?? ""}
      className="fixed inset-0 z-40 flex items-center justify-center bg-[hsl(var(--ink))]/30 px-4 backdrop-blur-[2px]"
      onClick={(e) => {
        if (isTerminal && onDismiss && e.target === e.currentTarget) {
          onDismiss();
        }
      }}
    >
      {/* keep legacy testid so old checkpoint tests still locate the loading state */}
      <span data-testid="takeoff-loading" className="sr-only">
        Analyzing
      </span>
      <div className="w-full max-w-md rounded-[10px] border border-[hsl(var(--line))] bg-white shadow-2xl">
        <header className="border-b border-[hsl(var(--line))] px-5 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[hsl(var(--brand))]">
            AI Takeoff
          </div>
          <h3 className="mt-0.5 text-[15px] font-semibold text-[hsl(var(--ink))]">
            {stage === "skipped"
              ? "Skipped this page"
              : stage === "done"
                ? "Done"
                : "Analyzing your blueprint"}
          </h3>
        </header>

        <ol className="space-y-1 px-3 py-3">
          {STEPS.map((step, idx) => {
            const status: "done" | "current" | "todo" =
              stage === "skipped" && idx > 1
                ? "todo"
                : stage === "done"
                  ? "done"
                  : idx < currentIdx
                    ? "done"
                    : idx === currentIdx
                      ? "current"
                      : "todo";
            return (
              <li
                key={step.id}
                data-step={step.id}
                data-status={status}
                className={cn(
                  "flex items-start gap-3 rounded-[6px] px-2.5 py-2 transition-colors",
                  status === "current" && "bg-[hsl(var(--brand-soft))]",
                )}
              >
                <StatusDot status={status} />
                <div className="flex-1 min-w-0">
                  <div
                    className={cn(
                      "text-[13px] font-medium",
                      status === "done"
                        ? "text-[hsl(var(--ink-2))]"
                        : status === "current"
                          ? "text-[hsl(var(--ink))]"
                          : "text-[hsl(var(--ink-3))]",
                    )}
                  >
                    {step.label}
                  </div>
                  <div
                    className={cn(
                      "text-[11px]",
                      status === "todo"
                        ? "text-[hsl(var(--ink-3))]"
                        : "text-[hsl(var(--ink-2))]",
                    )}
                  >
                    {step.detail}
                  </div>
                  {status === "current" && step.id === "classifying" && (
                    <ProgressBar seconds={step.estimatedSeconds} />
                  )}
                  {status === "current" && step.id === "reading_plan" && (
                    <ProgressBar seconds={step.estimatedSeconds} />
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        <footer className="border-t border-[hsl(var(--line))] bg-[hsl(var(--panel-2))] px-5 py-3 text-[12px] text-[hsl(var(--ink-2))]">
          {pageType && stage !== "rendering" && (
            <div className="flex items-center justify-between">
              <span>Sheet type</span>
              <span className="font-medium text-[hsl(var(--ink))]">
                {humanizePageType(pageType)}
                {typeof classifierConfidence === "number" && (
                  <span className="ml-1 text-[hsl(var(--ink-3))]">
                    ({Math.round(classifierConfidence * 100)}% sure)
                  </span>
                )}
              </span>
            </div>
          )}
          {message && (
            <p className="mt-1 leading-snug text-[hsl(var(--ink-2))]">
              {message}
            </p>
          )}
          {isTerminal && (
            <p className="mt-1 text-[11px] text-[hsl(var(--ink-3))]">
              Press Esc or click outside to close.
            </p>
          )}
        </footer>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: "done" | "current" | "todo" }) {
  if (status === "done") {
    return (
      <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[hsl(var(--success))] text-white">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 12l5 5L20 7" />
        </svg>
      </span>
    );
  }
  if (status === "current") {
    return (
      <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 border-[hsl(var(--brand))]">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[hsl(var(--brand))]" />
      </span>
    );
  }
  return (
    <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-[hsl(var(--line))] bg-white" />
  );
}

function ProgressBar({ seconds }: { seconds: number }) {
  return (
    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-[hsl(var(--line))]">
      <div
        className="h-full rounded-full bg-[hsl(var(--brand))]"
        style={{
          animation: `takeoffFill ${seconds}s linear forwards`,
        }}
      />
      <style>{`
        @keyframes takeoffFill {
          from { width: 0%; }
          to { width: 95%; }
        }
      `}</style>
    </div>
  );
}

function humanizePageType(t: string): string {
  switch (t) {
    case "floor_plan":
      return "Floor plan";
    case "rcp":
      return "Reflected ceiling plan";
    case "elevation":
      return "Elevation";
    case "section":
      return "Section";
    case "schedule":
      return "Schedule";
    case "detail":
      return "Detail";
    case "site_plan":
      return "Site plan";
    case "cover":
      return "Cover";
    default:
      return "Other";
  }
}
