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
  const hoveredSurfaceId = useEditorStore((s) => s.hoveredSurfaceId);
  const setHovered = useEditorStore((s) => s.setHovered);
  const showAiOverlay = useEditorStore((s) => s.showAiOverlay);
  const visibleTypes = useEditorStore((s) => s.visibleTypes);
  const removeSurface = useEditorStore((s) => s.removeSurface);
  const addSurface = useEditorStore((s) => s.addSurface);
  const updateSurface = useEditorStore((s) => s.updateSurface);
  const scaleCalib = useEditorStore((s) => s.scaleCalib);
  const pushScalePoint = useEditorStore((s) => s.pushScalePoint);

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
    evt?: MouseEvent;
    cancelBubble?: boolean;
  };

  // Drag-to-pan state for the select tool. We start "potential pan" on
  // mousedown over empty stage; if the cursor moves past a threshold we
  // upgrade to actual panning, otherwise the mouseup is treated as a
  // click-on-empty (deselect). Uses native screen coordinates because
  // konva's pointerPosition is in transformed Stage space.
  const [panState, setPanState] = useState<{
    startClientX: number;
    startClientY: number;
    startPanX: number;
    startPanY: number;
    moved: boolean;
  } | null>(null);
  const panX = useEditorStore((s) => s.panX);
  const panY = useEditorStore((s) => s.panY);
  const setViewport = useEditorStore((s) => s.setViewport);
  const PAN_DRAG_THRESHOLD_PX = 3;

  function onMouseDown(e: KonvaEvt) {
    const stage = e.target.getStage();
    const pos = stage?.getPointerPosition();
    if (!pos) return;

    // Scale calibration intercepts clicks before the draw tools see
    // them. The user is picking two points; nothing else fires.
    if (
      scaleCalib.stage === "pick-p1" ||
      scaleCalib.stage === "pick-p2"
    ) {
      pushScalePoint(pxToNorm(pos));
      return;
    }

    if (tool === "rectangle") {
      setDrawing({ start: pos, end: pos });
    } else if (tool === "polygon") {
      setPolyPoints((pts) => [...pts, pos]);
    } else if (tool === "eraser") {
      const id = e.target.attrs?.surfaceId ?? null;
      if (id) {
        void deleteSurface(id);
      }
    } else if (tool === "note") {
      // Drop a sticky note at the click position. Prompt for text.
      const text = window.prompt("Note (visible to your team):", "");
      if (text && text.trim().length > 0) {
        const norm = pxToNorm(pos);
        const r = 0.015; // tiny bbox around the click for the polygon
        void persistAnnotationNote(
          [
            { x: norm.x - r, y: norm.y - r },
            { x: norm.x + r, y: norm.y - r },
            { x: norm.x + r, y: norm.y + r },
            { x: norm.x - r, y: norm.y + r },
          ],
          text.trim(),
        );
      }
      setTool("select");
    } else if (tool === "select") {
      // Empty stage click in select mode → start a potential pan. If the
      // cursor doesn't move past the threshold, we'll treat it as a
      // click-to-deselect on mouseup. If it does, the user is panning.
      if (!e.target.attrs?.surfaceId && e.evt) {
        setPanState({
          startClientX: e.evt.clientX,
          startClientY: e.evt.clientY,
          startPanX: panX,
          startPanY: panY,
          moved: false,
        });
      }
    }
  }

  async function persistAnnotationNote(
    polygon: { x: number; y: number }[],
    text: string,
  ): Promise<void> {
    try {
      const res = await fetch("/api/surfaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: props.projectId,
          planPageId: props.planPageId,
          type: "annotation:note",
          polygon,
          status: "manual",
          source: "manual",
          notes: text,
        }),
      });
      if (!res.ok) return;
      const json = await res.json();
      addSurface(json.surface);
      props.onSurfaceCreated?.();
    } catch {
      /* ignore */
    }
  }

  function onMouseMove(e: KonvaEvt) {
    if (tool === "rectangle" && drawing) {
      const pos = e.target.getStage()?.getPointerPosition();
      if (pos) setDrawing({ ...drawing, end: pos });
      return;
    }
    if (panState && e.evt) {
      const dx = e.evt.clientX - panState.startClientX;
      const dy = e.evt.clientY - panState.startClientY;
      const moved =
        panState.moved || Math.hypot(dx, dy) > PAN_DRAG_THRESHOLD_PX;
      if (moved) {
        if (!panState.moved) setPanState({ ...panState, moved: true });
        setViewport({
          panX: panState.startPanX + dx,
          panY: panState.startPanY + dy,
        });
      }
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
    if (panState) {
      // Mouseup without movement → it was a click on empty canvas →
      // preserve the original "click to deselect" behavior.
      if (!panState.moved) {
        setSelected(null);
      }
      setPanState(null);
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

  /**
   * Drag-end handler: konva moves the Line by an internal x/y offset, but
   * our polygon coords are in normalized 0..1 space. We rebake the offset
   * into the polygon points, reset the node's x/y, persist, and update
   * the store so future renders use the new coords.
   */
  async function commitPolygonDrag(
    surfaceId: string,
    offsetPx: { x: number; y: number },
    node: { x: (v: number) => void; y: (v: number) => void },
  ) {
    const surface = props.surfaces.find((s) => s.id === surfaceId);
    if (!surface) return;
    const newPolygon = surface.polygon.map((p) => ({
      x: p.x + offsetPx.x / props.width,
      y: p.y + offsetPx.y / props.height,
    }));
    // Reset the konva node's x/y back to 0 since we're baking the offset
    // into the points themselves.
    node.x(0);
    node.y(0);
    updateSurface(surfaceId, { polygon: newPolygon });
    try {
      await fetch(`/api/surfaces/${surfaceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ polygon: newPolygon }),
      });
    } catch {
      /* the optimistic update already happened; user can drag again */
    }
  }

  // Memo: pre-compute pixel polygons for visible surfaces. Annotations
  // are rendered separately as markers, not as polygon outlines.
  // Skips empty polygons (surfaces tagged ai-fallback / geometry-uncertain
  // / scale-needed without a reliable boundary deliberately carry no
  // shape — they live in the queue with a "needs measurement" badge
  // and don't draw anything on the canvas).
  const visibleSurfaces = useMemo(() => {
    return props.surfaces
      .filter(
        (s) =>
          s.status !== "excluded" &&
          s.type !== ("annotation:note" as SurfaceType) &&
          s.polygon.length >= 3 &&
          (showAiOverlay || s.source !== "ai") &&
          (visibleTypes[s.type as keyof typeof visibleTypes] ?? true),
      )
      .map((s) => ({
        surface: s,
        flatPoints: s.polygon.flatMap((p) => [
          p.x * props.width,
          p.y * props.height,
        ]),
      }));
  }, [props.surfaces, props.width, props.height, showAiOverlay, visibleTypes]);

  const annotations = useMemo(
    () =>
      props.surfaces
        .filter((s) => s.type === "annotation:note" && s.status !== "excluded")
        .map((s) => {
          // Note position: centroid of the polygon.
          let cx = 0, cy = 0;
          for (const p of s.polygon) {
            cx += p.x;
            cy += p.y;
          }
          cx /= s.polygon.length;
          cy /= s.polygon.length;
          const px = normToPx({ x: cx, y: cy });
          return { id: s.id, text: s.notes ?? "", x: px.x, y: px.y };
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.surfaces, props.width, props.height],
  );

  const [hoveredNote, setHoveredNote] = useState<string | null>(null);

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
            const isHovered = hoveredSurfaceId === surface.id;
            const isLow = surface.confidence < 0.6;
            const isMid = surface.confidence >= 0.6 && surface.confidence < 0.8;
            // Lighter default fill so the blueprint underneath stays
            // readable. Bump opacity on hover/selection so the user can
            // still see exactly what's highlighted.
            // Outline-only by default — these are markers, not painted
            // regions, and a filled blob hides the wall lines on the
            // plan underneath. Hover / select bump the fill slightly
            // so the user can confirm what they're focused on.
            const fillAlpha = isSelected
              ? "33" // 20%
              : isHovered
                ? "1A" // 10%
                : "00"; // 0% — outline only
            const strokeWidth = isSelected ? 3 : isHovered ? 2.5 : 1.5;
            // Selected surface becomes draggable in select mode; everything
            // else stays anchored so the user can't accidentally yank a
            // polygon while panning.
            const draggable = tool === "select" && isSelected;

            return (
              <Line
                key={surface.id}
                surfaceId={surface.id}
                points={flatPoints}
                closed
                fill={`${color}${fillAlpha}`}
                stroke={isLow ? "#dc2626" : color}
                strokeWidth={strokeWidth}
                dash={isMid ? [8, 4] : undefined}
                shadowEnabled={isLow || isHovered}
                shadowColor={isLow ? "#dc2626" : color}
                shadowBlur={isLow ? 15 : isHovered ? 8 : 0}
                shadowOpacity={isLow ? 0.5 : isHovered ? 0.4 : 0}
                draggable={draggable}
                onMouseEnter={() => setHovered(surface.id)}
                onMouseLeave={() => setHovered(null)}
                onDragEnd={(e) => {
                  const node = e.target as unknown as {
                    x: () => number;
                    y: () => number;
                  } & { x: (v: number) => void; y: (v: number) => void };
                  void commitPolygonDrag(
                    surface.id,
                    { x: node.x(), y: node.y() },
                    node,
                  );
                }}
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

          {/* Scale-calibration line — visible while the user is picking
              the two points and after both are set. */}
          {scaleCalib.p1 && (
            (() => {
              const a = normToPx(scaleCalib.p1);
              const b = scaleCalib.p2 ? normToPx(scaleCalib.p2) : null;
              return (
                <>
                  <Rect
                    x={a.x - 5}
                    y={a.y - 5}
                    width={10}
                    height={10}
                    fill="#0ea5e9"
                    stroke="#0c4a6e"
                    strokeWidth={1.5}
                    cornerRadius={6}
                  />
                  {b && (
                    <>
                      <Line
                        points={[a.x, a.y, b.x, b.y]}
                        stroke="#0ea5e9"
                        strokeWidth={2}
                        dash={[6, 4]}
                      />
                      <Rect
                        x={b.x - 5}
                        y={b.y - 5}
                        width={10}
                        height={10}
                        fill="#0ea5e9"
                        stroke="#0c4a6e"
                        strokeWidth={1.5}
                        cornerRadius={6}
                      />
                    </>
                  )}
                </>
              );
            })()
          )}

          {/* Annotation notes — small yellow markers */}
          {annotations.map((a) => (
            <Rect
              key={a.id}
              x={a.x - 6}
              y={a.y - 6}
              width={12}
              height={12}
              fill="#facc15"
              stroke="#854d0e"
              strokeWidth={1.5}
              cornerRadius={2}
              onMouseEnter={() => setHoveredNote(a.id)}
              onMouseLeave={() => setHoveredNote(null)}
              onClick={(e) => {
                if (tool === "eraser") {
                  void deleteSurface(a.id);
                }
                e.cancelBubble = true;
              }}
            />
          ))}
        </Layer>
      </Stage>

      {hoveredNote &&
        (() => {
          const a = annotations.find((x) => x.id === hoveredNote);
          if (!a) return null;
          return (
            <div
              className="pointer-events-none absolute z-30 max-w-xs rounded-[6px] border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-[hsl(var(--ink-1))] shadow-md"
              style={{
                left: Math.min(a.x + 12, props.width - 240),
                top: Math.max(a.y - 8, 0),
              }}
            >
              {a.text}
            </div>
          );
        })()}

      {tool === "polygon" && polyPoints.length > 0 && (
        <div className="absolute left-4 top-4 rounded-md bg-gray-900/90 px-3 py-1.5 text-xs text-white">
          Click to add points. Double-click to finish ({polyPoints.length}{" "}
          point{polyPoints.length === 1 ? "" : "s"}).
        </div>
      )}
    </div>
  );
}
