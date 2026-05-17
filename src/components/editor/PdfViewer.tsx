"use client";

import { useEffect, useRef, useState } from "react";
import { useEditorStore, MIN_ZOOM, MAX_ZOOM } from "@/lib/store/editor-store";

interface RenderState {
  status: "loading" | "ready" | "error";
  message?: string;
  renderedWidth?: number;
  renderedHeight?: number;
}

export interface PdfViewerProps {
  planId: string;
  pageNumber: number;
  onPageRendered?: (info: { width: number; height: number }) => void;
  /** Render the surface overlay positioned on top of the PDF canvas */
  children?: (info: { width: number; height: number }) => React.ReactNode;
}

// Render the PDF at a higher native resolution than its on-screen size
// so zooming in stays crisp without re-rendering the page.
const RENDER_OVERSAMPLE = 2;

export function PdfViewer({
  planId,
  pageNumber,
  onPageRendered,
  children,
}: PdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<RenderState>({ status: "loading" });

  const zoom = useEditorStore((s) => s.zoom);
  const panX = useEditorStore((s) => s.panX);
  const panY = useEditorStore((s) => s.panY);
  const setViewport = useEditorStore((s) => s.setViewport);
  const resetViewport = useEditorStore((s) => s.resetViewport);
  const setCanvasDims = useEditorStore((s) => s.setCanvasDims);

  // Reset viewport whenever we switch pages so the user isn't dropped
  // into a zoomed-in corner of an unrelated sheet.
  useEffect(() => {
    resetViewport();
  }, [planId, pageNumber, resetViewport]);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      setState({ status: "loading" });
      try {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        if (!pdfjs.GlobalWorkerOptions.workerSrc) {
          pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
        }

        const url = `/api/plans/${planId}/file`;
        const doc = await pdfjs.getDocument({ url }).promise;
        if (cancelled) return;

        const page = await doc.getPage(pageNumber);
        if (cancelled) return;

        const containerWidth = containerRef.current?.clientWidth ?? 800;
        const containerHeight = containerRef.current?.clientHeight ?? 600;
        const targetWidth = Math.max(400, containerWidth - 40);
        const targetHeight = Math.max(400, containerHeight - 40);

        const baseViewport = page.getViewport({ scale: 1 });
        // CSS-display scale (what the user sees at zoom=1).
        const cssScale = Math.min(
          targetWidth / baseViewport.width,
          targetHeight / baseViewport.height,
        );
        // Render at a higher resolution so zooming in stays crisp without
        // re-rendering the page through pdfjs (which is slow).
        const dpr = window.devicePixelRatio || 1;
        const renderScale = cssScale * RENDER_OVERSAMPLE * dpr;
        const renderViewport = page.getViewport({ scale: renderScale });
        const cssViewport = page.getViewport({ scale: cssScale });

        const canvas = canvasRef.current;
        if (!canvas) return;
        const context = canvas.getContext("2d");
        if (!context) return;

        canvas.width = Math.floor(renderViewport.width);
        canvas.height = Math.floor(renderViewport.height);
        canvas.style.width = `${cssViewport.width}px`;
        canvas.style.height = `${cssViewport.height}px`;

        await page.render({
          canvasContext: context,
          viewport: renderViewport,
          canvas,
        }).promise;

        if (!cancelled) {
          setState({
            status: "ready",
            renderedWidth: cssViewport.width,
            renderedHeight: cssViewport.height,
          });
          setCanvasDims({
            containerW: containerWidth,
            containerH: containerHeight,
            contentW: cssViewport.width,
            contentH: cssViewport.height,
          });
          onPageRendered?.({
            width: cssViewport.width,
            height: cssViewport.height,
          });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            status: "error",
            message:
              "We couldn't display this blueprint page. Try refreshing the page.",
          });
          // eslint-disable-next-line no-console
          console.error("[PdfViewer]", err);
        }
      }
    }

    void render();
    return () => {
      cancelled = true;
    };
  }, [planId, pageNumber, onPageRendered]);

  // Wheel-to-zoom. Two-finger trackpad pinch surfaces here as wheel
  // events with ctrlKey on macOS. We zoom from the visual center and let
  // the clamp handle pan bounds; the alternative (cursor-anchored zoom)
  // requires accounting for the flex-centered wrapper and added complexity
  // for no real demo win.
  function onWheel(e: React.WheelEvent<HTMLDivElement>) {
    if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 10) {
      // Plain scroll on a trackpad — let it scroll the container.
      return;
    }
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
    if (nextZoom === zoom) return;
    setViewport({ zoom: nextZoom });
  }

  // Space-to-pan: hold space, the cursor turns into a grab and drag
  // moves the canvas without affecting drawing tools.
  const [panning, setPanning] = useState<{
    startX: number;
    startY: number;
    startPanX: number;
    startPanY: number;
  } | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);

  useEffect(() => {
    function down(e: KeyboardEvent) {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement) &&
          !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    }
    function up(e: KeyboardEvent) {
      if (e.code === "Space") setSpaceHeld(false);
    }
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Middle-click always pans; left-click pans only while space is held.
    if (e.button === 1 || (e.button === 0 && spaceHeld)) {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      setPanning({
        startX: e.clientX,
        startY: e.clientY,
        startPanX: panX,
        startPanY: panY,
      });
    }
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!panning) return;
    setViewport({
      panX: panning.startPanX + (e.clientX - panning.startX),
      panY: panning.startPanY + (e.clientY - panning.startY),
    });
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (panning) {
      e.currentTarget.releasePointerCapture(e.pointerId);
      setPanning(null);
    }
  }

  const cursor = panning
    ? "grabbing"
    : spaceHeld
      ? "grab"
      : undefined;

  return (
    <div
      ref={containerRef}
      data-testid="pdf-viewer"
      className="relative flex h-full w-full items-center justify-center overflow-hidden p-5"
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={cursor ? { cursor } : undefined}
    >
      {state.status === "loading" && (
        <div
          className="flex flex-col items-center gap-3 text-sm text-gray-600"
          data-testid="pdf-loading"
        >
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600" />
          <span>Loading blueprint page {pageNumber}...</span>
        </div>
      )}
      {state.status === "error" && (
        <div
          role="alert"
          className="max-w-md rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {state.message}
        </div>
      )}

      <div
        className={`relative ${state.status === "ready" ? "" : "hidden"}`}
        data-testid="pdf-page-wrapper"
        style={{
          transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
          transformOrigin: "0 0",
          // Disable transitions while panning/zooming — they make
          // wheel-zoom feel laggy.
          transition: panning ? "none" : "transform 60ms ease-out",
        }}
      >
        <canvas
          ref={canvasRef}
          data-testid="pdf-canvas"
          className="block bg-white shadow-md"
        />
        {state.status === "ready" &&
          state.renderedWidth &&
          state.renderedHeight &&
          children && (
            <div
              className="pointer-events-none absolute inset-0"
              data-testid="overlay-anchor"
              style={{ pointerEvents: spaceHeld || panning ? "none" : "auto" }}
            >
              {children({
                width: state.renderedWidth,
                height: state.renderedHeight,
              })}
            </div>
          )}
      </div>
    </div>
  );
}
