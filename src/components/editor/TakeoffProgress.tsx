"use client";

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
}

export function TakeoffProgress({
  stage,
  message,
  pageType,
  classifierConfidence,
  visible,
}: Props) {
  if (!visible) return null;

  const currentIdx = stage
    ? Math.max(
        0,
        STEPS.findIndex((s) => s.id === stage),
      )
    : 0;

  return (
    <div
      data-testid="takeoff-progress"
      data-stage={stage ?? ""}
      className="fixed inset-0 z-40 flex items-center justify-center bg-[hsl(var(--ink))]/30 px-4 backdrop-blur-[2px]"
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
                : stage === "error"
                  ? "Something went wrong"
                  : "Analyzing your blueprint"}
          </h3>
        </header>

        <ol className="space-y-1 px-3 py-3">
          {STEPS.map((step, idx) => {
            const status: "done" | "current" | "todo" =
              stage === "skipped" && idx > 1
                ? "todo"
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
