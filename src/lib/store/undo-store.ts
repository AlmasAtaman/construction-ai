"use client";

import { create } from "zustand";

export interface UndoableAction {
  label: string;
  undo: () => void | Promise<void>;
  redo: () => void | Promise<void>;
}

interface UndoState {
  past: UndoableAction[];
  future: UndoableAction[];
  push: (a: UndoableAction) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  clear: () => void;
}

const MAX_HISTORY = 50;

export const useUndoStore = create<UndoState>((set, get) => ({
  past: [],
  future: [],
  push: (a) =>
    set((s) => ({
      past: [...s.past.slice(-(MAX_HISTORY - 1)), a],
      future: [],
    })),
  undo: async () => {
    const last = get().past[get().past.length - 1];
    if (!last) return;
    await last.undo();
    set((s) => ({
      past: s.past.slice(0, -1),
      future: [last, ...s.future],
    }));
  },
  redo: async () => {
    const next = get().future[0];
    if (!next) return;
    await next.redo();
    set((s) => ({
      past: [...s.past, next],
      future: s.future.slice(1),
    }));
  },
  clear: () => set({ past: [], future: [] }),
}));
