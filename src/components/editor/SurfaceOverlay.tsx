"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Line, Rect, Circle } from "react-konva";
import {
  SURFACE_COLORS,
  FINISH_TYPE_COLORS,
  DEFAULT_FINISH_TYPE,
  type PathPoint,
  type SurfaceDTO,
  type SurfaceType,
} from "@/types/surface";
import { useEditorStore } from "@/lib/store/editor-store";
import { useUndoStore } from "@/lib/store/undo-store";
import {
  polylineLengthFt,
  screenRadiusToNorm,
  snapToWalls,
  type SnapResult,
} from "@/lib/wall-snap";
import {
  buildRunIndex,
  followRunBothWays,
  type RunIndex,
  type WallRun,
} from "@/lib/trace/wall-runs";

export interface SurfaceOverlayProps {
  width: number;
  height: number;
  surfaces: SurfaceDTO[];
  planPageId: string;
  projectId: string;
  /** Project ceiling height in feet. Drives the live `lf × ceiling`
   *  readout while tracing a wall-path and the persisted sqft of
   *  committed wall-path surfaces. */
  ceilingHeightFt: number;
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

/** Even-odd point-in-polygon test (normalized coords). */
function pointInPolygon(
  poly: { x: number; y: number }[],
  x: number,
  y: number,
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
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
  const wallData = useEditorStore((s) => s.wallData);
  const setWallData = useEditorStore((s) => s.setWallData);
  const snapMode = useEditorStore((s) => s.snapMode);
  const setSnapMode = useEditorStore((s) => s.setSnapMode);
  const zoom = useEditorStore((s) => s.zoom);
  const contentW = useEditorStore((s) => s.contentW);

  // Endpoint-adjacency index for "follow the wall" (polyline mode). Rebuilt
  // only when the page's wall network changes.
  const runIndex: RunIndex | null = useMemo(() => {
    if (!wallData || wallData.planPageId !== props.planPageId) return null;
    if (wallData.segments.length === 0) return null;
    return buildRunIndex(wallData.segments);
  }, [wallData, props.planPageId]);

  const [drawing, setDrawing] = useState<InProgressShape | null>(null);
  const [polyPoints, setPolyPoints] = useState<{ x: number; y: number }[]>([]);
  // Wall-path tool: in-progress traced path. Each vertex carries its
  // snap provenance so the persisted surface tells the breakdown panel
  // which segments are exact vs. free-click approximations.
  const [pathPoints, setPathPoints] = useState<PathPoint[]>([]);
  const [pathSnap, setPathSnap] = useState<SnapResult | null>(null);
  // Polyline mode: the connected wall run currently under the cursor,
  // previewed before the user clicks to commit it.
  const [previewRun, setPreviewRun] = useState<WallRun | null>(null);
  // Room (magic-wand) mode: enclosed room boundaries for this page, and the
  // one currently under the cursor.
  const [roomFaces, setRoomFaces] = useState<{ x: number; y: number }[][]>([]);
  const [previewRoom, setPreviewRoom] = useState<
    { x: number; y: number }[] | null
  >(null);

  function pxToNorm(p: { x: number; y: number }) {
    return { x: p.x / props.width, y: p.y / props.height };
  }
  function normToPx(p: { x: number; y: number }) {
    return { x: p.x * props.width, y: p.y * props.height };
  }

  // Lazy-fetch the cleaned wall network when the user activates the
  // wall-path tool on a page we haven't loaded yet. Cached by the
  // server, so re-activations after the first fetch are instant.
  useEffect(() => {
    if (tool !== "wall-path") return;
    if (wallData?.planPageId === props.planPageId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/plan-pages/${props.planPageId}/walls`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          planPageId: string;
          segments: {
            x1: number;
            y1: number;
            x2: number;
            y2: number;
          }[];
          pageWidthPt: number;
          pageHeightPt: number;
          ptPerFoot: number | null;
        };
        if (cancelled) return;
        setWallData({
          planPageId: data.planPageId,
          segments: data.segments,
          pageWidthPt: data.pageWidthPt,
          pageHeightPt: data.pageHeightPt,
          ptPerFoot: data.ptPerFoot,
        });
      } catch {
        /* network errors leave wallData null — the tool falls back to
           free-click for every point, which is the documented
           behavior. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tool, props.planPageId, wallData?.planPageId, setWallData]);

  // Room magic-wand: lazy-fetch enclosed room boundaries the first time the
  // user enters "room" snap mode on a page.
  const roomsPageRef = useRef<string | null>(null);
  useEffect(() => {
    if (tool !== "wall-path" || snapMode !== "room") return;
    if (roomsPageRef.current === props.planPageId) return;
    roomsPageRef.current = props.planPageId;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/plan-pages/${props.planPageId}/rooms`);
        if (!res.ok) return;
        const data = (await res.json()) as {
          rooms: { points: { x: number; y: number }[] }[];
        };
        if (!cancelled) setRoomFaces(data.rooms.map((r) => r.points));
      } catch {
        /* leave roomFaces empty — room mode just finds nothing */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tool, snapMode, props.planPageId]);

  // Keyboard handling for the wall-path tool: Esc cancels the
  // in-progress trace, Backspace removes the last point, Enter commits
  // (same as double-click). Bound at window level so the user doesn't
  // have to focus the canvas.
  useEffect(() => {
    if (tool !== "wall-path") return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setPathPoints([]);
        setPathSnap(null);
        setPreviewRun(null);
        setPreviewRoom(null);
      } else if (e.key === "Backspace") {
        // Prevent the browser from navigating back when the canvas is
        // focused but no input is.
        e.preventDefault();
        setPathPoints((pts) => pts.slice(0, -1));
      } else if (e.key === "Enter") {
        if (pathPoints.length >= 2) {
          void commitWallPath();
        }
      } else if (e.key === "1") {
        setSnapMode("point");
      } else if (e.key === "2") {
        setSnapMode("line");
      } else if (e.key === "3") {
        setSnapMode("polyline");
      } else if (e.key === "4") {
        setSnapMode("room");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, pathPoints]);

  /**
   * Snap probe shared by mouseDown (commit a point) and mouseMove
   * (preview the candidate). Returns null when no wall is close enough,
   * which the click handler interprets as a free-click fallback.
   */
  function snapFromPixel(pos: {
    x: number;
    y: number;
  }): SnapResult | null {
    if (!wallData || wallData.planPageId !== props.planPageId) return null;
    if (wallData.segments.length === 0) return null;
    const norm = pxToNorm(pos);
    // 8 px is a comfortable snap radius — narrow enough that
    // intentional free-clicks near a wall aren't hijacked, wide
    // enough that a sloppy click near a corner still locks on.
    const endpointR = screenRadiusToNorm(10, zoom, contentW || props.width);
    const edgeR = screenRadiusToNorm(8, zoom, contentW || props.width);
    return snapToWalls(norm, wallData.segments, {
      endpointRadiusNorm: endpointR,
      edgeRadiusNorm: edgeR,
    });
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
    } else if (tool === "wall-path") {
      if (snapMode === "room") {
        // Magic wand: trace the boundary of the room under the cursor.
        const n = pxToNorm(pos);
        const face = roomFaces.find((f) => pointInPolygon(f, n.x, n.y));
        if (face) void commitRoom(face);
        return;
      }
      const snap = snapFromPixel(pos);
      if (snapMode === "polyline") {
        // One click traces the whole connected wall run around corners.
        if (snap !== null && runIndex) {
          const run = followRunBothWays(runIndex, snap.segmentIndex);
          if (run.points.length >= 2) void commitRun(run);
        }
        return; // empty click in polyline mode: nothing to trace
      }
      if (snapMode === "line" && snap !== null && wallData) {
        // Grab the whole nearest wall segment (both endpoints).
        const seg = wallData.segments[snap.segmentIndex];
        setPathPoints((pts) => [
          ...pts,
          { x: seg.x1, y: seg.y1, snap: "endpoint" as const },
          { x: seg.x2, y: seg.y2, snap: "endpoint" as const },
        ]);
        return;
      }
      // Point mode (and line-mode fallback when nothing snapped): one
      // vertex. Endpoint snap > edge-projection > free-click fallback.
      // Free-clicks are tagged so the breakdown panel can mark them as
      // "not snapped to extracted geometry."
      const norm = pxToNorm(pos);
      const next: PathPoint =
        snap !== null
          ? { x: snap.x, y: snap.y, snap: snap.snap }
          : { x: norm.x, y: norm.y, snap: "free" };
      setPathPoints((pts) => [...pts, next]);
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
    if (tool === "wall-path") {
      const pos = e.target.getStage()?.getPointerPosition();
      if (!pos) return;
      if (snapMode === "room") {
        const n = pxToNorm(pos);
        setPreviewRoom(roomFaces.find((f) => pointInPolygon(f, n.x, n.y)) ?? null);
        return;
      }
      const snap = snapFromPixel(pos);
      setPathSnap(snap);
      if (snapMode === "polyline") {
        setPreviewRun(
          snap !== null && runIndex
            ? followRunBothWays(runIndex, snap.segmentIndex)
            : null,
        );
      } else if (previewRun) {
        setPreviewRun(null);
      }
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

  /**
   * Persist a finished wall-path. Exact arithmetic: linear feet = Σ segment
   * pt-lengths / ptPerFoot; wall area = lf × ceiling. Rounded only at
   * display; the exact values are stored. Shared by manual point/line
   * tracing (commitWallPath) and polyline "follow the wall" (commitRun).
   */
  async function persistWallPath(points: PathPoint[]) {
    if (points.length < 2) return;
    let linearFt: number | null = null;
    let sqft: number | null = null;
    if (wallData && wallData.ptPerFoot && wallData.ptPerFoot > 0) {
      linearFt = polylineLengthFt(
        points,
        wallData.pageWidthPt,
        wallData.pageHeightPt,
        wallData.ptPerFoot,
      );
      sqft = linearFt * props.ceilingHeightFt;
    }
    try {
      const polygon = points.map((p) => ({ x: p.x, y: p.y }));
      const res = await fetch("/api/surfaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: props.projectId,
          planPageId: props.planPageId,
          type: "wall-path",
          polygon,
          pathPoints: points,
          linearFootage: linearFt,
          squareFootage: sqft,
          // Default to Paint @ ceiling height; user can reclassify in review.
          finishType: "paint",
          heightBasis: "ceiling",
          wallHeightFt: props.ceilingHeightFt,
          status: "manual",
          source: "manual",
          derivation: "traced",
        }),
      });
      if (!res.ok) return;
      const json = await res.json();
      addSurface(json.surface);
      props.onSurfaceCreated?.();
      const newId = json.surface.id as string;
      useUndoStore.getState().push({
        label: `Traced a wall path`,
        undo: async () => {
          await fetch(`/api/surfaces/${newId}`, { method: "DELETE" });
          useEditorStore.getState().removeSurface(newId);
        },
        redo: async () => {
          /* re-tracing would duplicate work; user can draw again */
        },
      });
    } catch {
      /* leave state cleared; next click starts fresh */
    }
  }

  async function commitWallPath() {
    if (pathPoints.length < 2) return;
    const points = pathPoints;
    setPathPoints([]);
    setPathSnap(null);
    await persistWallPath(points);
    setTool("select");
  }

  /**
   * Polyline mode: commit the previewed connected run in one click. Every
   * vertex is a real extracted endpoint, so all snap as "endpoint". Stays
   * in the wall-path tool so the user can keep clicking walls.
   */
  async function commitRun(run: WallRun) {
    if (run.points.length < 2) return;
    const points: PathPoint[] = run.points.map((p) => ({
      x: p.x,
      y: p.y,
      snap: "endpoint" as const,
    }));
    setPreviewRun(null);
    setPathSnap(null);
    await persistWallPath(points);
  }

  /**
   * Room magic-wand: commit the clicked room's boundary as a closed wall-path.
   * The ring is closed (first point repeated) so the perimeter — and thus
   * linear footage / wall area — includes the closing edge.
   */
  async function commitRoom(face: { x: number; y: number }[]) {
    if (face.length < 3) return;
    const ring = [...face, face[0]];
    const points: PathPoint[] = ring.map((p) => ({
      x: p.x,
      y: p.y,
      snap: "endpoint" as const,
    }));
    setPreviewRoom(null);
    await persistWallPath(points);
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
          // wall-path surfaces are open polylines with ≥2 points; all
          // other surface types render as closed polygons with ≥3.
          (s.type === "wall-path"
            ? s.polygon.length >= 2
            : s.polygon.length >= 3) &&
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
          else if (tool === "wall-path") void commitWallPath();
        }}
      >
        <Layer>
          {visibleSurfaces.map(({ surface, flatPoints }) => {
            // Wall-paths are colored by finish scope (paint=green, FRP=orange,
            // …) like the answer PDF; other surfaces by their type color.
            const color =
              surface.type === "wall-path"
                ? FINISH_TYPE_COLORS[surface.finishType ?? DEFAULT_FINISH_TYPE]
                : SURFACE_COLORS[surface.type];
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

            // Wall-path surfaces are open polylines — no fill, no
            // close. Render with a slightly heavier stroke than the
            // closed-polygon defaults so the traced line reads as the
            // measured boundary instead of a polygon edge.
            const isWallPath = surface.type === "wall-path";
            const wallPathStroke = isWallPath
              ? Math.max(strokeWidth + 1, isSelected ? 4 : isHovered ? 3.5 : 2.5)
              : strokeWidth;
            return (
              <Line
                key={surface.id}
                surfaceId={surface.id}
                points={flatPoints}
                closed={!isWallPath}
                fill={isWallPath ? undefined : `${color}${fillAlpha}`}
                stroke={isLow ? "#dc2626" : color}
                strokeWidth={wallPathStroke}
                lineCap={isWallPath ? "round" : undefined}
                lineJoin={isWallPath ? "round" : undefined}
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

          {/* In-progress wall path. Solid line through committed
              points; dashed preview from the last point to the snap
              candidate (or cursor if no snap). Snap indicator: small
              filled circle whose color encodes endpoint vs. edge. */}
          {tool === "wall-path" && pathPoints.length > 0 && (
            <Line
              points={pathPoints.flatMap((p) => {
                const px = normToPx(p);
                return [px.x, px.y];
              })}
              stroke={SURFACE_COLORS["wall-path"]}
              strokeWidth={2.5}
              lineCap="round"
              lineJoin="round"
            />
          )}
          {tool === "wall-path" &&
            pathPoints.length > 0 &&
            pathSnap !== null && (
              (() => {
                const last = pathPoints[pathPoints.length - 1];
                const a = normToPx(last);
                const b = normToPx({ x: pathSnap.x, y: pathSnap.y });
                return (
                  <Line
                    points={[a.x, a.y, b.x, b.y]}
                    stroke={SURFACE_COLORS["wall-path"]}
                    strokeWidth={2}
                    dash={[4, 4]}
                    opacity={0.7}
                  />
                );
              })()
            )}
          {tool === "wall-path" &&
            pathPoints.map((p, i) => {
              const px = normToPx(p);
              return (
                <Circle
                  key={`wp-${i}`}
                  x={px.x}
                  y={px.y}
                  radius={4}
                  fill={
                    p.snap === "free"
                      ? "#f59e0b" // amber — free-click (not exact)
                      : p.snap === "edge"
                        ? "#60a5fa" // light blue — edge projection
                        : "#0ea5e9" // bright blue — endpoint snap
                  }
                  stroke="#0c4a6e"
                  strokeWidth={1}
                />
              );
            })}
          {tool === "wall-path" && pathSnap !== null && (
            (() => {
              const px = normToPx({ x: pathSnap.x, y: pathSnap.y });
              return (
                <Circle
                  x={px.x}
                  y={px.y}
                  radius={6}
                  fill={pathSnap.snap === "endpoint" ? "#0ea5e9" : "#60a5fa"}
                  opacity={0.45}
                  stroke={pathSnap.snap === "endpoint" ? "#0c4a6e" : "#1d4ed8"}
                  strokeWidth={1.5}
                />
              );
            })()
          )}

          {/* Polyline-mode preview: the connected wall run under the
              cursor, highlighted before the user clicks to trace it. */}
          {tool === "wall-path" &&
            snapMode === "polyline" &&
            previewRun &&
            previewRun.points.length >= 2 && (
              <>
                <Line
                  points={previewRun.points.flatMap((p) => {
                    const px = normToPx(p);
                    return [px.x, px.y];
                  })}
                  stroke="#06b6d4"
                  strokeWidth={4}
                  opacity={0.9}
                  lineCap="round"
                  lineJoin="round"
                  closed={previewRun.closed}
                />
                {previewRun.points.map((p, i) => {
                  const px = normToPx(p);
                  return (
                    <Circle
                      key={`pr-${i}`}
                      x={px.x}
                      y={px.y}
                      radius={3}
                      fill="#06b6d4"
                    />
                  );
                })}
              </>
            )}

          {/* Room magic-wand preview: highlight the enclosing room the
              click will trace. */}
          {tool === "wall-path" &&
            snapMode === "room" &&
            previewRoom &&
            previewRoom.length >= 3 && (
              <Line
                points={previewRoom.flatMap((p) => {
                  const px = normToPx(p);
                  return [px.x, px.y];
                })}
                closed
                stroke="#22c55e"
                strokeWidth={3}
                fill="#22c55e22"
                opacity={0.95}
                lineJoin="round"
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

      {tool === "wall-path" && (
        (() => {
          // Live measurement HUD. Includes the snap preview as the
          // would-be next vertex so the user sees what they'd commit
          // before clicking. Exact arithmetic in pt; rounding only at
          // display.
          let liveLf = 0;
          if (wallData && wallData.ptPerFoot && wallData.ptPerFoot > 0) {
            if (
              snapMode === "room" &&
              previewRoom &&
              previewRoom.length >= 3
            ) {
              liveLf = polylineLengthFt(
                [...previewRoom, previewRoom[0]],
                wallData.pageWidthPt,
                wallData.pageHeightPt,
                wallData.ptPerFoot,
              );
            } else if (
              snapMode === "polyline" &&
              previewRun &&
              previewRun.points.length >= 2
            ) {
              // Polyline mode: measure the run under the cursor.
              liveLf = polylineLengthFt(
                previewRun.points,
                wallData.pageWidthPt,
                wallData.pageHeightPt,
                wallData.ptPerFoot,
              );
            } else if (pathPoints.length >= 1) {
              const previewTail =
                pathSnap !== null ? { x: pathSnap.x, y: pathSnap.y } : null;
              const pts = previewTail
                ? [...pathPoints, previewTail]
                : pathPoints;
              if (pts.length >= 2) {
                liveLf = polylineLengthFt(
                  pts,
                  wallData.pageWidthPt,
                  wallData.pageHeightPt,
                  wallData.ptPerFoot,
                );
              }
            }
          }
          const liveSqft = liveLf * props.ceilingHeightFt;
          const hasScale =
            wallData?.ptPerFoot != null && wallData.ptPerFoot > 0;
          return (
            <div className="absolute bottom-4 left-4 z-20 max-w-xs space-y-1.5 rounded-md bg-gray-900/90 px-3 py-2 text-[11px] leading-relaxed text-white">
              <div className="flex items-center gap-1" data-testid="snap-mode-toggle">
                {(["point", "line", "polyline", "room"] as const).map((m, i) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setSnapMode(m)}
                    title={`${m} mode (${i + 1})`}
                    data-testid={`snap-mode-${m}`}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium capitalize transition-colors ${
                      snapMode === m
                        ? "bg-[#06b6d4] text-white"
                        : "bg-white/10 text-white/70 hover:bg-white/20"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <div className="font-medium">
                {snapMode === "room"
                  ? "Click inside a room to trace its whole wall boundary."
                  : snapMode === "polyline"
                  ? "Hover a wall, then click to trace the whole connected run."
                  : snapMode === "line"
                    ? pathPoints.length === 0
                      ? "Click a wall to grab that whole segment."
                      : `${pathPoints.length} pts — add segments, Enter to finish, Backspace to undo.`
                    : pathPoints.length === 0
                      ? "Click to place each vertex along a wall."
                      : `${pathPoints.length} pts — double-click/Enter to finish, Backspace to undo.`}
              </div>
              {hasScale ? (
                <div>
                  {liveLf > 0
                    ? `${liveLf.toFixed(1)} ft  ×  ${props.ceilingHeightFt.toFixed(1)} ft ceiling  =  ${liveSqft.toFixed(1)} sqft`
                    : "Waiting for the next point to compute length."}
                </div>
              ) : (
                <div className="text-amber-200">
                  No page scale yet — set one to see lf / sqft.
                </div>
              )}
              {wallData && wallData.segments.length === 0 ? (
                <div className="text-amber-200">
                  No wall geometry found on this page — every click is a
                  free-click (not snapped to extracted geometry).
                </div>
              ) : null}
            </div>
          );
        })()
      )}
    </div>
  );
}
