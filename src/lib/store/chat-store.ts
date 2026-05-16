"use client";

import { create } from "zustand";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ChatToolCall[];
  pendingConfirmation?: {
    token: string;
    summary: string;
  } | null;
}

export interface ChatToolCall {
  name: string;
  description: string;
  affectedCount?: number;
}

interface ChatState {
  messages: ChatMessage[];
  sending: boolean;
  add: (msg: ChatMessage) => void;
  setMessages: (msgs: ChatMessage[]) => void;
  setSending: (b: boolean) => void;
  clearPending: () => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  sending: false,
  add: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  setMessages: (msgs) => set({ messages: msgs }),
  setSending: (b) => set({ sending: b }),
  clearPending: () =>
    set((s) => ({
      messages: s.messages.map((m) => ({ ...m, pendingConfirmation: null })),
    })),
}));
