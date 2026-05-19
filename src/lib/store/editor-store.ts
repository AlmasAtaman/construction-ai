"use client";

import { create } from "zustand";
import type { SurfaceDTO } from "@/types/surface";

export type EditorTool = "select" | "rectangle" | "polygon" | "eraser" | "note";

interface UndoEntry {
  label: string;
  expiresAt: number;
  undo: () => void | Promise<void>;
}

interface EditorState {
  surfaces: SurfaceDTO[];
  selectedSurfaceId: string | null;
  hoveredSurfaceId: string | null;
  tool: EditorTool;
  pendingUndo: UndoEntry | null;
  // Canvas viewport state — zoom 1.0 fits the page, panX/panY are in CSS px.
  zoom: number;
  panX: number;
  panY: number;
  // Canvas dimensions reported by PdfViewer for clamping pan bounds.
  // container = visible area, content = on-screen size of the rendered
  // PDF at zoom=1. Both are in CSS px.
  containerW: number;
  containerH: number;
  contentW: number;
  contentH: number;
  // Toggle that hides AI-detected polygons so the user can read the
  // bare blueprint when validating.
  showAiOverlay: boolean;
  // Per-surface-type visibility. On dense plans, every room produces 4-5
  // overlapping polygons (wall + ceiling + trim + door + window) and the
  // canvas becomes unreadable. Default to walls-only and let the user
  // toggle the others on when they want to verify a specific type.
  visibleTypes: {
    wall: boolean;
    ceiling: boolean;
    trim: boolean;
    door: boolean;
    window: boolean;
  };
  // Two-point scale calibration. When stage is non-null the overlay
  // intercepts the next click(s) on the canvas instead of starting a
  // draw — the user is calibrating, not annotating.
  scaleCalib: {
    stage: "pick-p1" | "pick-p2" | "enter-feet" | null;
    p1: { x: number; y: number } | null;
    p2: { x: number; y: number } | null;
  };
  setSurfaces: (s: SurfaceDTO[]) => void;
  addSurface: (s: SurfaceDTO) => void;
  updateSurface: (id: string, change: Partial<SurfaceDTO>) => void;
  removeSurface: (id: string) => void;
  setSelected: (id: string | null) => void;
  setHovered: (id: string | null) => void;
  setTool: (tool: EditorTool) => void;
  setPendingUndo: (entry: UndoEntry | null) => void;
  setViewport: (v: { zoom?: number; panX?: number; panY?: number }) => void;
  resetViewport: () => void;
  setCanvasDims: (d: {
    containerW?: number;
    containerH?: number;
    contentW?: number;
    contentH?: number;
  }) => void;
  setShowAiOverlay: (v: boolean) => void;
  toggleType: (t: keyof EditorState["visibleTypes"]) => void;
  startScaleCalibration: () => void;
  cancelScaleCalibration: () => void;
  pushScalePoint: (p: { x: number; y: number }) => void;
}

// Zoom range: 1 = fit to container (any tighter and the blueprint becomes
// a useless thumbnail; 0 just resets to 1). 4 = 400% which keeps text on
// the federal procurement drawings readable.
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

/**
 * Pan-clamp. The PDF wrapper is flex-centered inside the canvas
 * container, so panX=0 means "natural center." As soon as zoomed-content
 * exceeds the container, content overflows half on each side; the user
 * can pan up to ±(overflow/2) to see either edge. At zoom 1 (or smaller
 * content) pan is locked to 0 so the blueprint stays centered and can't
 * drift into the void.
 */
function clampPan(
  panX: number,
  panY: number,
  zoom: number,
  containerW: number,
  containerH: number,
  contentW: number,
  contentH: number,
): { panX: number; panY: number } {
  if (containerW === 0 || contentW === 0) return { panX, panY };
  const overflowX = Math.max(0, (contentW * zoom - containerW) / 2);
  const overflowY = Math.max(0, (contentH * zoom - containerH) / 2);
  return {
    panX: Math.max(-overflowX, Math.min(overflowX, panX)),
    panY: Math.max(-overflowY, Math.min(overflowY, panY)),
  };
}

function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

export const useEditorStore = create<EditorState>((set) => ({
  surfaces: [],
  selectedSurfaceId: null,
  hoveredSurfaceId: null,
  tool: "select",
  pendingUndo: null,
  zoom: 1,
  panX: 0,
  panY: 0,
  containerW: 0,
  containerH: 0,
  contentW: 0,
  contentH: 0,
  showAiOverlay: true,
  visibleTypes: {
    wall: true,
    ceiling: false,
    trim: false,
    door: false,
    window: false,
  },
  scaleCalib: { stage: null, p1: null, p2: null },
  setSurfaces: (s) => set({ surfaces: s }),
  addSurface: (s) =>
    set((st) => ({ surfaces: [...st.surfaces, s] })),
  updateSurface: (id, change) =>
    set((st) => ({
      surfaces: st.surfaces.map((s) =>
        s.id === id ? { ...s, ...change } : s,
      ),
    })),
  removeSurface: (id) =>
    set((st) => ({
      surfaces: st.surfaces.filter((s) => s.id !== id),
      selectedSurfaceId:
        st.selectedSurfaceId === id ? null : st.selectedSurfaceId,
      hoveredSurfaceId:
        st.hoveredSurfaceId === id ? null : st.hoveredSurfaceId,
    })),
  setSelected: (id) => set({ selectedSurfaceId: id }),
  setHovered: (id) => set({ hoveredSurfaceId: id }),
  setTool: (tool) => set({ tool }),
  setPendingUndo: (entry) => set({ pendingUndo: entry }),
  setViewport: ({ zoom, panX, panY }) =>
    set((st) => {
      const nextZoom = clampZoom(zoom ?? st.zoom);
      const clamped = clampPan(
        panX ?? st.panX,
        panY ?? st.panY,
        nextZoom,
        st.containerW,
        st.containerH,
        st.contentW,
        st.contentH,
      );
      return {
        zoom: nextZoom,
        panX: clamped.panX,
        panY: clamped.panY,
      };
    }),
  resetViewport: () => set({ zoom: 1, panX: 0, panY: 0 }),
  setCanvasDims: ({ containerW, containerH, contentW, contentH }) =>
    set((st) => ({
      containerW: containerW ?? st.containerW,
      containerH: containerH ?? st.containerH,
      contentW: contentW ?? st.contentW,
      contentH: contentH ?? st.contentH,
    })),
  setShowAiOverlay: (v) => set({ showAiOverlay: v }),
  toggleType: (t) =>
    set((st) => ({
      visibleTypes: { ...st.visibleTypes, [t]: !st.visibleTypes[t] },
    })),
  startScaleCalibration: () =>
    set({ scaleCalib: { stage: "pick-p1", p1: null, p2: null } }),
  cancelScaleCalibration: () =>
    set({ scaleCalib: { stage: null, p1: null, p2: null } }),
  pushScalePoint: (p) =>
    set((st) => {
      if (st.scaleCalib.stage === "pick-p1") {
        return { scaleCalib: { stage: "pick-p2", p1: p, p2: null } };
      }
      if (st.scaleCalib.stage === "pick-p2") {
        return {
          scaleCalib: { stage: "enter-feet", p1: st.scaleCalib.p1, p2: p },
        };
      }
      return {};
    }),
}));
