"use client";

import { useMemo, useState } from "react";
import { Stage, Layer, Line, Rect } from "react-konva";
import {
  SURFACE_COLORS,
  type SurfaceDTO,
  type SurfaceType,
} from "@/types/surface";
import { useEditorStore } from "@/lib/store/editor-store";
import { useUndoStore } from "@/lib/store/undo-store";

export interface SurfaceOverlayProps {
  width: number;
  height: number;
  surfaces: SurfaceDTO[];
  planPageId: string;
  projectId: string;
  onContextMenu?: (
    surfaceId: string,
    pos: { x: number; y: number },
  ) => void;
  onSurfaceCreated?: () => void;
}

interface InProgressShape {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export function SurfaceOverlay(props: SurfaceOverlayProps) {
  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);
  const setSelected = useEditorStore((s) => s.setSelected);
  const selectedSurfaceId = useEditorStore((s) => s.selectedSurfaceId);
  const removeSurface = useEditorStore((s) => s.removeSurface);
  const addSurface = useEditorStore((s) => s.addSurface);

  const [drawing, setDrawing] = useState<InProgressShape | null>(null);
  const [polyPoints, setPolyPoints] = useState<{ x: number; y: number }[]>([]);

  function pxToNorm(p: { x: number; y: number }) {
    return { x: p.x / props.width, y: p.y / props.height };
  }
  function normToPx(p: { x: number; y: number }) {
    return { x: p.x * props.width, y: p.y * props.height };
  }

  async function persistManualSurface(
    type: SurfaceType,
    polygon: { x: number; y: number }[],
  ) {
    try {
      const res = await fetch("/api/surfaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: props.projectId,
          planPageId: props.planPageId,
          type,
          polygon,
          status: "manual",
          source: "manual",
        }),
      });
      if (!res.ok) return;
      const json = await res.json();
      addSurface(json.surface);
      props.onSurfaceCreated?.();

      // Record an undoable action.
      const newId = json.surface.id as string;
      const snapshot = json.surface;
      useUndoStore.getState().push({
        label: `Drew a ${type}`,
        undo: async () => {
          await fetch(`/api/surfaces/${newId}`, { method: "DELETE" });
          useEditorStore.getState().removeSurface(newId);
        },
        redo: async () => {
          const re = await fetch("/api/surfaces", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectId: snapshot.projectId,
              planPageId: snapshot.planPageId,
              type: snapshot.type,
              polygon: snapshot.polygon,
              status: "manual",
              source: "manual",
            }),
          });
          if (re.ok) {
            const j = await re.json();
            useEditorStore.getState().addSurface(j.surface);
          }
        },
      });
    } catch {
      /* ignore */
    }
  }

  // Konva event types are awkward across versions; use a minimal local type.
  type KonvaEvt = {
    target: {
      getStage: () => {
        getPointerPosition: () => { x: number; y: number } | null;
      } | null;
      attrs?: { surfaceId?: string };
    };
    evt?: Event;
    cancelBubble?: boolean;
  };

  function onMouseDown(e: KonvaEvt) {
    const stage = e.target.getStage();
    const pos = stage?.getPointerPosition();
    if (!pos) return;

    if (tool === "rectangle") {
      setDrawing({ start: pos, end: pos });
    } else if (tool === "polygon") {
      setPolyPoints((pts) => [...pts, pos]);
    } else if (tool === "eraser") {
      const id = e.target.attrs?.surfaceId ?? null;
      if (id) {
        void deleteSurface(id);
      }
    } else if (tool === "select") {
      // Clicked empty stage — deselect (compare via attrs absence)
      if (!e.target.attrs?.surfaceId) {
        setSelected(null);
      }
    }
  }

  function onMouseMove(e: KonvaEvt) {
    if (tool === "rectangle" && drawing) {
      const pos = e.target.getStage()?.getPointerPosition();
      if (pos) setDrawing({ ...drawing, end: pos });
    }
  }

  async function onMouseUp() {
    if (tool === "rectangle" && drawing) {
      const x1 = Math.min(drawing.start.x, drawing.end.x);
      const y1 = Math.min(drawing.start.y, drawing.end.y);
      const x2 = Math.max(drawing.start.x, drawing.end.x);
      const y2 = Math.max(drawing.start.y, drawing.end.y);
      const w = x2 - x1;
      const h = y2 - y1;
      setDrawing(null);
      if (w > 5 && h > 5) {
        const polygon = [
          pxToNorm({ x: x1, y: y1 }),
          pxToNorm({ x: x2, y: y1 }),
          pxToNorm({ x: x2, y: y2 }),
          pxToNorm({ x: x1, y: y2 }),
        ];
        await persistManualSurface("wall", polygon);
        // Auto-return to select tool after a manual draw.
        setTool("select");
      }
    }
  }

  async function commitPolygon() {
    if (polyPoints.length < 3) return;
    const polygon = polyPoints.map(pxToNorm);
    setPolyPoints([]);
    await persistManualSurface("wall", polygon);
    setTool("select");
  }

  async function deleteSurface(id: string) {
    await fetch(`/api/surfaces/${id}`, { method: "DELETE" });
    removeSurface(id);
  }

  // Memo: pre-compute pixel polygons for visible surfaces.
  const visibleSurfaces = useMemo(
    () =>
      props.surfaces
        .filter((s) => s.status !== "excluded")
        .map((s) => ({
          surface: s,
          flatPoints: s.polygon.flatMap((p) => {
            const px = normToPx(p);
            return [px.x, px.y];
          }),
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.surfaces, props.width, props.height],
  );

  // Pointer-events strategy: when a tool is active that needs canvas
  // interaction, the overlay must accept pointer events. The wrapper sets
  // pointer-events: none by default, so we re-enable here.
  const overlayInteractive =
    tool !== "select" || selectedSurfaceId !== null;

  return (
    <div
      className="absolute inset-0"
      style={{ pointerEvents: "auto" }}
      data-testid="surface-overlay"
      data-tool={tool}
      data-interactive={overlayInteractive ? "true" : "false"}
    >
      <Stage
        width={props.width}
        height={props.height}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onDblClick={() => {
          if (tool === "polygon") void commitPolygon();
        }}
      >
        <Layer>
          {visibleSurfaces.map(({ surface, flatPoints }) => {
            const color = SURFACE_COLORS[surface.type];
            const isSelected = selectedSurfaceId === surface.id;
            const isLow = surface.confidence < 0.6;
            const isMid = surface.confidence >= 0.6 && surface.confidence < 0.8;

            return (
              <Line
                key={surface.id}
                surfaceId={surface.id}
                points={flatPoints}
                closed
                fill={`${color}33`}
                stroke={isLow ? "#dc2626" : color}
                strokeWidth={isSelected ? 4 : 2}
                dash={isMid ? [8, 4] : undefined}
                shadowEnabled={isLow}
                shadowColor="#dc2626"
                shadowBlur={isLow ? 15 : 0}
                shadowOpacity={isLow ? 0.5 : 0}
                onClick={(e) => {
                  if (tool === "eraser") {
                    void deleteSurface(surface.id);
                  } else if (tool === "select") {
                    e.cancelBubble = true;
                    setSelected(surface.id);
                  }
                }}
                onContextMenu={(e) => {
                  e.evt.preventDefault();
                  const stage = e.target.getStage();
                  const pos = stage?.getPointerPosition();
                  if (pos && props.onContextMenu) {
                    props.onContextMenu(surface.id, pos);
                  }
                }}
              />
            );
          })}

          {/* In-progress rectangle */}
          {tool === "rectangle" && drawing && (
            <Rect
              x={Math.min(drawing.start.x, drawing.end.x)}
              y={Math.min(drawing.start.y, drawing.end.y)}
              width={Math.abs(drawing.end.x - drawing.start.x)}
              height={Math.abs(drawing.end.y - drawing.start.y)}
              stroke="#1d4ed8"
              strokeWidth={2}
              dash={[4, 4]}
            />
          )}

          {/* In-progress polygon (rubber band) */}
          {tool === "polygon" && polyPoints.length > 0 && (
            <Line
              points={polyPoints.flatMap((p) => [p.x, p.y])}
              stroke="#1d4ed8"
              strokeWidth={2}
              dash={[4, 4]}
            />
          )}
        </Layer>
      </Stage>

      {tool === "polygon" && polyPoints.length > 0 && (
        <div className="absolute left-4 top-4 rounded-md bg-gray-900/90 px-3 py-1.5 text-xs text-white">
          Click to add points. Double-click to finish ({polyPoints.length}{" "}
          point{polyPoints.length === 1 ? "" : "s"}).
        </div>
      )}
    </div>
  );
}
