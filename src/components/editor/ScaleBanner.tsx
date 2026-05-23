"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useEditorStore } from "@/lib/store/editor-store";
import { cn } from "@/lib/utils";

interface Props {
  planPageId: string;
}

interface ScaleInfo {
  ptPerFoot: number;
  method: "text-notation" | "scale-bar" | "user";
  label: string;
}

interface ScaleResponse {
  planPageId: string;
  scale: ScaleInfo | null;
  /** One-time heads-up when an auto-detected scale passed a cross-check uneasily. */
  warning?: string | null;
  pageWidthPt: number | null;
  pageHeightPt: number | null;
}

// Subtle banner that runs full-width above the PDF canvas. Shows the
// plan's established scale + how it was determined. When no scale is
// set, it prompts the user to calibrate. The "Edit / Set scale" button
// pops a small panel that walks the user through a two-point
// calibration. The banner is the only authoritative scale UI — there
// is no tool-palette entry for scale by design (it's a setup step,
// not a recurring drawing action).
export function ScaleBanner({ planPageId }: Props) {
  const [info, setInfo] = useState<ScaleResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const scaleCalib = useEditorStore((s) => s.scaleCalib);
  const startCalib = useEditorStore((s) => s.startScaleCalibration);
  const cancelCalib = useEditorStore((s) => s.cancelScaleCalibration);

  // Guards against out-of-order responses: switching pages (or the
  // auto-jump to the first floor plan) fires several /scale fetches, and
  // a page whose scale must be auto-detected resolves slower than one
  // already cached. Without this, a stale "no scale" response can land
  // last and clobber the current page's detected scale.
  const latestPageRef = useRef(planPageId);
  latestPageRef.current = planPageId;

  const fetchScale = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/plan-pages/${planPageId}/scale`, {
        cache: "no-store",
      });
      if (res.ok) {
        const json = (await res.json()) as ScaleResponse;
        // Only commit if this response is still for the active page.
        if (json.planPageId === latestPageRef.current) setInfo(json);
      }
    } finally {
      setLoading(false);
    }
  }, [planPageId]);

  useEffect(() => {
    void fetchScale();
  }, [fetchScale]);

  useEffect(() => {
    function refresh() {
      void fetchScale();
    }
    window.addEventListener("scale-updated", refresh);
    return () => window.removeEventListener("scale-updated", refresh);
  }, [fetchScale]);

  function startPicking() {
    setOpen(true);
    startCalib();
  }

  function closePanel() {
    setOpen(false);
    cancelCalib();
  }

  async function saveDirect(ptPerFoot: number, label: string) {
    const res = await fetch(`/api/plan-pages/${planPageId}/scale`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ptPerFoot, label }),
    });
    if (res.ok) {
      window.dispatchEvent(new Event("scale-updated"));
      cancelCalib();
      setOpen(false);
    }
  }

  async function clearScale() {
    const res = await fetch(`/api/plan-pages/${planPageId}/scale`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clear: true }),
    });
    if (res.ok) {
      window.dispatchEvent(new Event("scale-updated"));
      cancelCalib();
      setOpen(false);
    }
  }

  const scale = info?.scale ?? null;
  const methodLabel: Record<ScaleInfo["method"], string> = {
    "text-notation": "read from text",
    "scale-bar": "from scale bar",
    user: "set by you",
  };

  return (
    <div className="relative border-b border-[hsl(var(--line))] bg-white">
      <div className="flex items-center gap-3 px-3 py-1.5 text-[12px]">
        <span
          className={cn(
            "inline-flex h-2 w-2 flex-shrink-0 rounded-full",
            scale
              ? scale.method === "user"
                ? "bg-sky-500"
                : "bg-emerald-500"
              : "bg-amber-500",
          )}
          aria-hidden
        />
        {scale ? (
          <div className="flex flex-1 items-baseline gap-2">
            <span className="font-semibold text-[hsl(var(--ink))]">
              Scale:
            </span>
            <span className="num text-[hsl(var(--ink))]">{scale.label}</span>
            <span className="text-[hsl(var(--ink-3))]">
              · {methodLabel[scale.method]} · {scale.ptPerFoot.toFixed(2)} pt/ft
            </span>
          </div>
        ) : (
          <div className="flex flex-1 items-baseline gap-2">
            <span className="font-semibold text-amber-800">
              No scale set —
            </span>
            <span className="text-[hsl(var(--ink-2))]">
              measurements will read as &ldquo;scale needed&rdquo; until you
              calibrate.
            </span>
          </div>
        )}
        <Button
          size="sm"
          variant={scale ? "ghost" : "primary"}
          onClick={startPicking}
          className="h-7 px-2 text-[11px]"
          disabled={loading}
        >
          {scale ? "Edit" : "Set scale"}
        </Button>
      </div>

      {scale && info?.warning && (
        <div className="flex items-start gap-2 border-t border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800">
          <span className="mt-0.5 inline-flex h-2 w-2 flex-shrink-0 rounded-full bg-amber-500" aria-hidden />
          <span>{info.warning}</span>
        </div>
      )}

      {open && (
        <CalibrationPanel
          planPageId={planPageId}
          stage={scaleCalib.stage}
          p1Norm={scaleCalib.p1}
          p2Norm={scaleCalib.p2}
          pageWidthPt={info?.pageWidthPt ?? null}
          pageHeightPt={info?.pageHeightPt ?? null}
          onCancel={closePanel}
          onClear={scale ? clearScale : undefined}
          onSaveDirect={saveDirect}
        />
      )}
    </div>
  );
}

interface PanelProps {
  planPageId: string;
  stage: "pick-p1" | "pick-p2" | "enter-feet" | null;
  p1Norm: { x: number; y: number } | null;
  p2Norm: { x: number; y: number } | null;
  pageWidthPt: number | null;
  pageHeightPt: number | null;
  onCancel: () => void;
  onClear?: () => void;
  onSaveDirect: (ptPerFoot: number, label: string) => void | Promise<void>;
}

function CalibrationPanel(props: PanelProps) {
  const [realFeet, setRealFeet] = useState<string>("10");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function commit() {
    if (
      !props.p1Norm ||
      !props.p2Norm ||
      !props.pageWidthPt ||
      !props.pageHeightPt
    ) {
      setError("Pick two points on the plan first.");
      return;
    }
    const ft = parseFloat(realFeet);
    if (!Number.isFinite(ft) || ft <= 0) {
      setError("Enter a positive distance in feet (e.g. 10).");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/plan-pages/${props.planPageId}/scale`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          p1: props.p1Norm,
          p2: props.p2Norm,
          realFeet: ft,
          pageWidthPt: props.pageWidthPt,
          pageHeightPt: props.pageHeightPt,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(j?.error ?? "Couldn't save scale. Try again.");
        return;
      }
      window.dispatchEvent(new Event("scale-updated"));
      props.onCancel();
    } finally {
      setSaving(false);
    }
  }

  const stage = props.stage;

  return (
    <div className="absolute right-3 top-full z-40 mt-1 w-80 rounded-md border border-[hsl(var(--line))] bg-white shadow-lg">
      <div className="border-b border-[hsl(var(--line))] px-3 py-2 text-[12px] font-semibold text-[hsl(var(--ink))]">
        Set the plan&rsquo;s scale
      </div>
      <div className="space-y-2 px-3 py-3 text-[12px] text-[hsl(var(--ink-2))]">
        {stage === "pick-p1" && (
          <p>
            Click <strong>two points</strong> along a known dimension on the
            plan — the longer the better. Tip: pick the endpoints of a wall
            with a printed dimension like &ldquo;24&rsquo;-0&rdquo;.
          </p>
        )}
        {stage === "pick-p2" && (
          <p>First point set. Click the second point now.</p>
        )}
        {stage === "enter-feet" && (
          <div className="space-y-2">
            <p>
              How long is that distance in <strong>feet</strong>? (Decimals
              like 12.5 are fine; this is what the plan says it should be.)
            </p>
            <div className="flex items-center gap-2">
              <input
                type="number"
                step="0.1"
                min="0.5"
                autoFocus
                value={realFeet}
                onChange={(e) => setRealFeet(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void commit();
                }}
                className="w-24 rounded border border-[hsl(var(--line))] bg-white px-2 py-1 text-[13px]"
              />
              <span className="text-[hsl(var(--ink-3))]">feet</span>
            </div>
          </div>
        )}
        {error && (
          <p className="text-rose-700">{error}</p>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-[hsl(var(--line))] px-3 py-2">
        {props.onClear ? (
          <button
            onClick={props.onClear}
            className="text-[11px] text-[hsl(var(--ink-3))] underline-offset-2 hover:underline"
          >
            Use auto-detected scale
          </button>
        ) : (
          <span />
        )}
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            onClick={props.onCancel}
            className="h-7 px-2 text-[11px]"
          >
            Cancel
          </Button>
          {stage === "enter-feet" && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => void commit()}
              disabled={saving}
              className="h-7 px-2 text-[11px]"
            >
              {saving ? "Saving…" : "Save scale"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
