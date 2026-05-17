"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { PdfViewer } from "./PdfViewer";
import { PlanUploader } from "./PlanUploader";
import { ToolPalette } from "./ToolPalette";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { EstimateWorksheet } from "@/components/worksheet/EstimateWorksheet";
import { CommandPalette } from "@/components/command/CommandPalette";
import { useEditorStore } from "@/lib/store/editor-store";
import { useUndoStore } from "@/lib/store/undo-store";
import { TakeoffButton } from "./TakeoffButton";
import { UndoToast } from "./UndoToast";
import { SurfaceContextMenu } from "./SurfaceContextMenu";
import type { SurfaceDTO } from "@/types/surface";
import { DetectionQueue } from "./DetectionQueue";
import { CanvasToolbar } from "./CanvasToolbar";
import { cn } from "@/lib/utils";

const SurfaceOverlay = dynamic(
  () => import("./SurfaceOverlay").then((m) => ({ default: m.SurfaceOverlay })),
  { ssr: false },
);

export interface PlanData {
  id: string;
  filename: string;
  pageCount: number;
  pages: { id: string; pageNumber: number }[];
}

type RightPanelTab = "queue" | "chat";

const WORKSHEET_MIN_PX = 120;
const WORKSHEET_MAX_PX = 600;
const WORKSHEET_DEFAULT_PX = 288; // matches the old max-h-72 (72 * 4)

export function ProjectWorkspace({
  projectId,
  initialPlan,
}: {
  projectId: string;
  initialPlan: PlanData | null;
}) {
  const [plan, setPlan] = useState<PlanData | null>(initialPlan);
  const [currentPage, setCurrentPage] = useState(1);
  const [worksheetOpen, setWorksheetOpen] = useState(true);
  const [worksheetHeight, setWorksheetHeight] = useState(WORKSHEET_DEFAULT_PX);
  const [rightTab, setRightTab] = useState<RightPanelTab>("queue");
  const [contextMenu, setContextMenu] = useState<{
    surfaceId: string;
    position: { x: number; y: number };
  } | null>(null);

  // Worksheet drag-to-resize: hold the top edge and drag to shrink/grow
  // the bottom panel, like the VSCode terminal.
  const worksheetResizing = useRef<{ startY: number; startHeight: number } | null>(null);
  function onWorksheetHandleDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    worksheetResizing.current = {
      startY: e.clientY,
      startHeight: worksheetHeight,
    };
  }
  function onWorksheetHandleMove(e: React.PointerEvent<HTMLDivElement>) {
    const r = worksheetResizing.current;
    if (!r) return;
    // Drag up to grow (negative delta), down to shrink.
    const next = r.startHeight - (e.clientY - r.startY);
    setWorksheetHeight(
      Math.min(WORKSHEET_MAX_PX, Math.max(WORKSHEET_MIN_PX, next)),
    );
  }
  function onWorksheetHandleUp(e: React.PointerEvent<HTMLDivElement>) {
    if (worksheetResizing.current) {
      (e.target as Element).releasePointerCapture(e.pointerId);
      worksheetResizing.current = null;
    }
  }

  const surfaces = useEditorStore((s) => s.surfaces);
  const setSurfaces = useEditorStore((s) => s.setSurfaces);
  const setTool = useEditorStore((s) => s.setTool);
  const removeSurface = useEditorStore((s) => s.removeSurface);
  const selectedSurfaceId = useEditorStore((s) => s.selectedSurfaceId);

  const currentPlanPage = plan?.pages.find((p) => p.pageNumber === currentPage);

  const refreshSurfaces = useCallback(async () => {
    if (!currentPlanPage) return;
    const res = await fetch(
      `/api/surfaces?planPageId=${currentPlanPage.id}`,
      { cache: "no-store" },
    );
    if (!res.ok) return;
    const json = (await res.json()) as { surfaces: SurfaceDTO[] };
    setSurfaces(json.surfaces);
  }, [currentPlanPage, setSurfaces]);

  useEffect(() => {
    void refreshSurfaces();
  }, [refreshSurfaces]);

  useEffect(() => {
    function onUndone() {
      void refreshSurfaces();
    }
    window.addEventListener("history-undone", onUndone);
    return () => window.removeEventListener("history-undone", onUndone);
  }, [refreshSurfaces]);

  // Queue is the default tab; user can flip to Chat manually. We don't
  // auto-switch tabs because surfaces refresh after every action, which
  // would otherwise yank the user back to Queue while they're typing.

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return;
      if (e.target instanceof HTMLTextAreaElement) return;

      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.shiftKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        void useUndoStore.getState().redo();
        return;
      }
      if (isMod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        void useUndoStore.getState().undo();
        return;
      }

      if (e.key === "a" || e.key === "A") setTool("rectangle");
      if (e.key === "l" || e.key === "L") setTool("polygon");
      if (e.key === "c" || e.key === "C") setTool("polygon");
      if (e.key === "v" || e.key === "V") setTool("select");
      if (e.key === "r" || e.key === "R") setTool("rectangle");
      if (e.key === "p" || e.key === "P") setTool("polygon");
      if (e.key === "e" || e.key === "E") setTool("eraser");

      if (e.key === "Escape") {
        setTool("select");
        useEditorStore.getState().setSelected(null);
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        const id = selectedSurfaceId;
        if (id) {
          e.preventDefault();
          removeSurface(id);
          void fetch(`/api/surfaces/${id}`, { method: "DELETE" });
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setTool, removeSurface, selectedSurfaceId]);

  // Stop macOS trackpad pinch / Ctrl+Wheel from zooming the entire
  // browser window when the user is trying to zoom our canvas. The
  // PdfViewer handles canvas zoom locally; anywhere else inside the
  // workspace, we just swallow the gesture so the browser doesn't run
  // its own page-zoom.
  useEffect(() => {
    function onWheelCapture(e: WheelEvent) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    }
    // Must be non-passive to preventDefault on macOS pinch.
    document.addEventListener("wheel", onWheelCapture, { passive: false });
    return () => document.removeEventListener("wheel", onWheelCapture);
  }, []);

  // Command palette dispatched events
  useEffect(() => {
    function onRunTakeoff() {
      document
        .querySelector<HTMLButtonElement>('[data-testid="run-takeoff"]')
        ?.click();
    }
    function onToggleWorksheet() {
      setWorksheetOpen((v) => !v);
    }
    window.addEventListener("command:run-takeoff", onRunTakeoff);
    window.addEventListener("command:toggle-worksheet", onToggleWorksheet);
    return () => {
      window.removeEventListener("command:run-takeoff", onRunTakeoff);
      window.removeEventListener("command:toggle-worksheet", onToggleWorksheet);
    };
  }, []);

  async function onAcceptAllHighConfidence() {
    const proposed = surfaces.filter(
      (s) => s.status === "proposed" && s.confidence >= 0.8,
    );
    if (proposed.length === 0) return;
    for (const s of proposed) {
      useEditorStore.getState().updateSurface(s.id, { status: "accepted" });
    }
    await fetch("/api/surfaces/bulk", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ids: proposed.map((s) => s.id),
        changes: { status: "accepted" },
      }),
    });
  }

  const proposedCount = surfaces.filter((s) => s.status === "proposed").length;
  const acceptedCount = surfaces.filter(
    (s) => s.status === "accepted" || s.status === "manual",
  ).length;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: pages + AI takeoff */}
        <aside
          data-testid="left-sidebar"
          className="flex w-56 flex-shrink-0 flex-col border-r border-[hsl(var(--line))] bg-white"
        >
          <SectionHeader>Pages</SectionHeader>
          <div className="flex-1 overflow-y-auto py-2">
            {!plan ? (
              <p
                data-testid="pages-placeholder"
                className="px-3 text-[12px] text-[hsl(var(--ink-3))]"
              >
                Pages appear here once you upload a blueprint.
              </p>
            ) : (
              <ul className="space-y-0.5 px-1.5" data-testid="pages-list">
                {plan.pages.map((p) => (
                  <li key={p.id}>
                    <button
                      onClick={() => setCurrentPage(p.pageNumber)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-[4px] px-2 py-1.5 text-left text-[13px] transition-colors",
                        currentPage === p.pageNumber
                          ? "bg-[hsl(var(--brand-soft))] text-[hsl(var(--brand))] font-medium"
                          : "text-[hsl(var(--ink-2))] hover:bg-[hsl(var(--panel-2))]",
                      )}
                      data-testid={`page-button-${p.pageNumber}`}
                    >
                      <span className="num inline-block w-5 text-[12px] text-[hsl(var(--ink-3))]">
                        {p.pageNumber}
                      </span>
                      <span>Page {p.pageNumber}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-[hsl(var(--line))] p-3">
            <div className="mb-2 flex items-center justify-between">
              <SectionTitle>Measure plan</SectionTitle>
              <span className="text-[11px] text-[hsl(var(--ink-3))]">
                {acceptedCount} kept · {proposedCount} to review
              </span>
            </div>
            <TakeoffButton
              planPageId={currentPlanPage?.id ?? null}
              onComplete={refreshSurfaces}
            />
          </div>
        </aside>

        {/* Tool ribbon */}
        {plan && currentPlanPage && <ToolPalette />}

        {/* Center canvas */}
        <main
          data-testid="center-canvas"
          className="relative flex flex-1 flex-col overflow-hidden bg-[hsl(var(--canvas))]"
        >
          {!plan ? (
            <div className="flex flex-1 items-center justify-center p-8">
              <PlanUploader
                projectId={projectId}
                onUploaded={(p) => {
                  setPlan(p);
                  setCurrentPage(1);
                }}
              />
            </div>
          ) : currentPlanPage ? (
            <>
              <CanvasToolbar />
              <PdfViewer planId={plan.id} pageNumber={currentPage}>
                {(size) => (
                  <SurfaceOverlay
                    width={size.width}
                    height={size.height}
                    surfaces={surfaces}
                    planPageId={currentPlanPage.id}
                    projectId={projectId}
                    onSurfaceCreated={refreshSurfaces}
                    onContextMenu={(surfaceId, pos) =>
                      setContextMenu({
                        surfaceId,
                        position: pos,
                      })
                    }
                  />
                )}
              </PdfViewer>
            </>
          ) : null}
          {contextMenu && (
            <SurfaceContextMenu
              surfaceId={contextMenu.surfaceId}
              position={contextMenu.position}
              onClose={() => setContextMenu(null)}
            />
          )}
        </main>

        {/* Right panel: tabbed queue / chat */}
        <aside
          data-testid="right-sidebar"
          className="flex w-80 flex-shrink-0 flex-col border-l border-[hsl(var(--line))] bg-white"
        >
          <div className="flex border-b border-[hsl(var(--line))]">
            <TabButton
              active={rightTab === "queue"}
              onClick={() => setRightTab("queue")}
              testId="tab-queue"
            >
              Review
              {proposedCount > 0 && (
                <span className="ml-1.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[hsl(var(--accent))] px-1 text-[10px] font-semibold text-white">
                  {proposedCount}
                </span>
              )}
            </TabButton>
            <TabButton
              active={rightTab === "chat"}
              onClick={() => setRightTab("chat")}
              testId="tab-chat"
            >
              Chat
            </TabButton>
          </div>
          <div className="flex-1 overflow-y-auto">
            {rightTab === "queue" && (
              <DetectionQueue
                onAcceptAllHighConfidence={onAcceptAllHighConfidence}
              />
            )}
            {rightTab === "chat" && (
              <ChatSidebar
                projectId={projectId}
                hasPlan={!!plan}
                onAfterAction={refreshSurfaces}
              />
            )}
          </div>
        </aside>
      </div>

      {/* Bottom panel: worksheet */}
      <section
        data-testid="bottom-panel"
        className="relative flex-shrink-0 border-t border-[hsl(var(--line))] bg-white"
      >
        {worksheetOpen && (
          <div
            data-testid="worksheet-resize-handle"
            onPointerDown={onWorksheetHandleDown}
            onPointerMove={onWorksheetHandleMove}
            onPointerUp={onWorksheetHandleUp}
            onPointerCancel={onWorksheetHandleUp}
            onDoubleClick={() => setWorksheetHeight(WORKSHEET_DEFAULT_PX)}
            title="Drag to resize. Double-click to reset."
            className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize bg-transparent transition-colors hover:bg-[hsl(var(--brand))]/30"
          />
        )}
        <button
          onClick={() => setWorksheetOpen((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-2 text-left transition-colors hover:bg-[hsl(var(--panel-2))]"
          data-testid="worksheet-toggle"
        >
          <div className="flex items-center gap-2">
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className={cn(
                "text-[hsl(var(--ink-3))] transition-transform",
                worksheetOpen ? "rotate-0" : "-rotate-90",
              )}
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
            <span className="text-[13px] font-semibold text-[hsl(var(--ink))]">
              Cost breakdown
            </span>
            <span className="text-[11px] text-[hsl(var(--ink-3))]">
              ({acceptedCount} {acceptedCount === 1 ? "room" : "rooms"})
            </span>
          </div>
        </button>
        {worksheetOpen && (
          <div
            className="overflow-auto border-t border-[hsl(var(--line))]"
            style={{ height: worksheetHeight }}
          >
            <EstimateWorksheet projectId={projectId} />
          </div>
        )}
      </section>

      <UndoToast />
      <CommandPalette projectId={projectId} />
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-[hsl(var(--line))] px-3 py-2">
      <SectionTitle>{children}</SectionTitle>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[hsl(var(--ink-3))]">
      {children}
    </h3>
  );
}

function TabButton({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      data-active={active}
      className={cn(
        "relative flex-1 px-3 py-2.5 text-[12px] font-medium transition-colors",
        active
          ? "text-[hsl(var(--brand))]"
          : "text-[hsl(var(--ink-3))] hover:text-[hsl(var(--ink-2))]",
      )}
    >
      <span className="inline-flex items-center justify-center">
        {children}
      </span>
      {active && (
        <span className="absolute inset-x-0 bottom-0 h-0.5 bg-[hsl(var(--brand))]" />
      )}
    </button>
  );
}
