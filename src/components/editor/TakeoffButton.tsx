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
  errorTitle?: string;
  errorBody?: string;
  errorDetails?: string;
}

interface CompletePayload {
  cached?: boolean;
  skipped?: boolean;
  surfaceCount?: number;
  pageType?: string;
  reason?: string;
}

/**
 * Turn whatever the takeoff pipeline coughed up into a human message and a
 * one-line "what to do" hint. The raw error stays available behind a
 * collapsible so power users / dev mode can still see it.
 */
function humanizeTakeoffError(raw: string): {
  title: string;
  body: string;
  details: string;
} {
  const r = raw.trim();
  const lower = r.toLowerCase();

  // 401 from Anthropic — wrong/missing/typo'd API key.
  if (
    lower.includes("authentication_error") ||
    lower.startsWith("401 ") ||
    lower.includes("x-api-key") ||
    lower.includes("invalid api key")
  ) {
    return {
      title: "Your Anthropic API key isn't working",
      body: "The key in .env.local was rejected. Double-check there's no typo (it should start with sk-ant-), no quotes around it, and that you've restarted the dev server since adding it.",
      details: r,
    };
  }

  // 429 — rate-limited.
  if (lower.includes("rate_limit") || lower.startsWith("429")) {
    return {
      title: "Anthropic is rate-limiting us",
      body: "Too many requests in a short window. Wait about a minute, then try again.",
      details: r,
    };
  }

  // Budget cap inside the app.
  if (lower.includes("daily ai usage limit") || lower.includes("budget")) {
    return {
      title: "Today's AI budget is used up",
      body: "PainterDesk caps AI spend at $20/day. Resets at midnight local time. You can keep editing the plan by hand.",
      details: r,
    };
  }

  // Missing API key configured on the server.
  if (lower.includes("anthropic api key") || lower.includes("anthropic_api_key")) {
    return {
      title: "No Anthropic API key configured",
      body: "Add your key to .env.local as ANTHROPIC_API_KEY=sk-ant-… and restart the dev server.",
      details: r,
    };
  }

  // Network / fetch failure.
  if (
    lower.includes("failed to fetch") ||
    lower.includes("network") ||
    lower.includes("econnrefused") ||
    lower.includes("could not reach")
  ) {
    return {
      title: "Couldn't reach Anthropic",
      body: "Check your internet connection, then try again. If you're on a VPN, try toggling it off.",
      details: r,
    };
  }

  // Couldn't read the PDF page (mupdf / render failures).
  if (
    lower.includes("render") &&
    (lower.includes("pdf") || lower.includes("page"))
  ) {
    return {
      title: "Couldn't render that page of the blueprint",
      body: "The PDF may be corrupted or use an unusual encoding. Try uploading it again, or pick a different page.",
      details: r,
    };
  }

  // Default — keep the raw message visible but framed.
  return {
    title: "Couldn't analyze your blueprint",
    body: "The AI takeoff didn't complete. Try again — if it keeps failing, check the details below.",
    details: r,
  };
}

export function TakeoffButton({ planPageId, onComplete }: Props) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [resultNote, setResultNote] = useState<string | null>(null);

  function showError(rawMessage: string) {
    const { title, body, details } = humanizeTakeoffError(rawMessage);
    setProgress({
      stage: "error",
      errorTitle: title,
      errorBody: body,
      errorDetails: details,
    });
    setRunning(false);
  }

  function dismissProgress() {
    setProgress(null);
  }

  async function run() {
    if (!planPageId) return;
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
        const rawText =
          typeof json.error === "string"
            ? json.error
            : `${res.status} ${await res.text().catch(() => "")}`.trim();
        showError(rawText || `${res.status} ${res.statusText}`);
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
        showError(errorPayload.error);
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
    } catch (err) {
      const raw =
        err instanceof Error ? err.message : "Could not reach the AI service.";
      showError(raw);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button
        variant="accent"
        size="lg"
        onClick={() => void run()}
        disabled={running || !planPageId}
        data-testid="run-takeoff"
        className="w-full h-12 text-[14px] font-semibold shadow-md"
        title="Find every room, wall, and door automatically."
      >
        {running ? (
          <>
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            Looking at your plan…
          </>
        ) : (
          <>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
            Measure my plan
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

      <TakeoffProgress
        visible={progress !== null}
        stage={progress?.stage ?? null}
        message={progress?.message}
        pageType={progress?.pageType}
        classifierConfidence={progress?.classifierConfidence}
        errorTitle={progress?.errorTitle}
        errorBody={progress?.errorBody}
        errorDetails={progress?.errorDetails}
        onDismiss={dismissProgress}
        onRetry={() => void run()}
      />
    </div>
  );
}
