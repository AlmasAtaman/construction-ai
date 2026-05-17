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
  tool: EditorTool;
  pendingUndo: UndoEntry | null;
  setSurfaces: (s: SurfaceDTO[]) => void;
  addSurface: (s: SurfaceDTO) => void;
  updateSurface: (id: string, change: Partial<SurfaceDTO>) => void;
  removeSurface: (id: string) => void;
  setSelected: (id: string | null) => void;
  setTool: (tool: EditorTool) => void;
  setPendingUndo: (entry: UndoEntry | null) => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  surfaces: [],
  selectedSurfaceId: null,
  tool: "select",
  pendingUndo: null,
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
    })),
  setSelected: (id) => set({ selectedSurfaceId: id }),
  setTool: (tool) => set({ tool }),
  setPendingUndo: (entry) => set({ pendingUndo: entry }),
}));
