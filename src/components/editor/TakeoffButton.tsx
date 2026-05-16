"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { TakeoffProgress, type ProgressStage } from "./TakeoffProgress";

interface Props {
  planPageId: string | null;
  onComplete: () => void | Promise<void>;
}

interface ProgressState {
  stage: ProgressStage;
  message?: string;
  pageType?: string;
  classifierConfidence?: number;
}

interface CompletePayload {
  cached?: boolean;
  skipped?: boolean;
  surfaceCount?: number;
  pageType?: string;
  reason?: string;
}

export function TakeoffButton({ planPageId, onComplete }: Props) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resultNote, setResultNote] = useState<string | null>(null);

  async function run() {
    if (!planPageId) return;
    setError(null);
    setResultNote(null);
    setProgress({ stage: "rendering" });
    setRunning(true);

    try {
      const res = await fetch("/api/ai/takeoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planPageId }),
      });
      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => ({}));
        setError(json.error ?? "Something went wrong. Try again.");
        setRunning(false);
        setProgress(null);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completePayload: CompletePayload | null = null;
      let errorPayload: { error: string } | null = null;
      let currentEvent: string = "message";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl: number;
        while ((nl = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
          for (const line of chunk.split("\n")) {
            if (line.startsWith("event: ")) {
              currentEvent = line
                .slice("event: ".length)
                .trim() as typeof currentEvent;
            } else if (line.startsWith("data: ")) {
              const payload = JSON.parse(line.slice("data: ".length));
              if (currentEvent === "complete") {
                completePayload = payload as CompletePayload;
              } else if (currentEvent === "error") {
                errorPayload = payload as { error: string };
              } else {
                setProgress({
                  stage: payload.stage,
                  message: payload.message,
                  pageType: payload.pageType,
                  classifierConfidence: payload.classifierConfidence,
                });
              }
              currentEvent = "message";
            }
          }
        }
      }

      if (errorPayload) {
        setError(errorPayload.error);
        setProgress(null);
        setRunning(false);
        return;
      }

      if (completePayload?.skipped) {
        setProgress({
          stage: "skipped",
          pageType: completePayload.pageType,
          message: completePayload.reason,
        });
        setResultNote(
          completePayload.reason ??
            "This page is not a floor plan — no surfaces were detected.",
        );
        setRunning(false);
        // Auto-dismiss after a few seconds.
        setTimeout(() => setProgress(null), 4500);
        await onComplete();
        return;
      }

      // Success.
      setProgress({ stage: "done" });
      if (completePayload?.cached) {
        setResultNote(
          `Used cached AI results — no charge. Detected ${completePayload.surfaceCount ?? 0} surfaces.`,
        );
      } else {
        setResultNote(
          `Detected ${completePayload?.surfaceCount ?? 0} surfaces.`,
        );
        window.dispatchEvent(new Event("ai-usage-changed"));
      }
      await onComplete();
      setTimeout(() => setProgress(null), 1200);
    } catch {
      setError("We couldn't reach the AI. Check your internet and try again.");
      setProgress(null);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button
        variant="accent"
        size="default"
        onClick={() => void run()}
        disabled={running || !planPageId}
        data-testid="run-takeoff"
        className="w-full"
        title="Detect walls, ceilings, trim, doors, and windows."
      >
        {running ? (
          <>
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            Analyzing…
          </>
        ) : (
          <>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
            Run AI Takeoff
          </>
        )}
      </Button>

      {resultNote && !progress && (
        <div
          className="rounded-[4px] border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-[11px] leading-tight text-emerald-900"
          data-testid="takeoff-cached"
        >
          {resultNote}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-[4px] border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] leading-tight text-red-800"
          data-testid="takeoff-error"
        >
          {error}
        </div>
      )}

      <TakeoffProgress
        visible={progress !== null}
        stage={progress?.stage ?? null}
        message={progress?.message}
        pageType={progress?.pageType}
        classifierConfidence={progress?.classifierConfidence}
      />
    </div>
  );
}
