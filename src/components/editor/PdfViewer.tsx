"use client";

import { useEffect, useRef, useState } from "react";

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

export function PdfViewer({
  planId,
  pageNumber,
  onPageRendered,
  children,
}: PdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<RenderState>({ status: "loading" });

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
        const scale = Math.min(
          targetWidth / baseViewport.width,
          targetHeight / baseViewport.height,
        );
        const viewport = page.getViewport({ scale });

        const canvas = canvasRef.current;
        if (!canvas) return;
        const context = canvas.getContext("2d");
        if (!context) return;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        context.setTransform(dpr, 0, 0, dpr, 0, 0);

        await page.render({
          canvasContext: context,
          viewport,
          canvas,
        }).promise;

        if (!cancelled) {
          setState({
            status: "ready",
            renderedWidth: viewport.width,
            renderedHeight: viewport.height,
          });
          onPageRendered?.({
            width: viewport.width,
            height: viewport.height,
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

  return (
    <div
      ref={containerRef}
      data-testid="pdf-viewer"
      className="flex h-full w-full items-center justify-center overflow-auto p-5"
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
      >
        <canvas
          ref={canvasRef}
          data-testid="pdf-canvas"
          className="block max-h-full max-w-full bg-white shadow-md"
        />
        {state.status === "ready" &&
          state.renderedWidth &&
          state.renderedHeight &&
          children && (
            <div
              className="pointer-events-none absolute inset-0"
              data-testid="overlay-anchor"
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
