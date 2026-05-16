"use client";

import { useEffect, useRef, useState } from "react";
import { useChatStore } from "@/lib/store/chat-store";
import { Button } from "@/components/ui/button";

interface Props {
  projectId: string;
  onAfterAction: () => void | Promise<void>;
}

function AssistantAvatar() {
  return (
    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[hsl(var(--brand))] text-[11px] font-semibold text-white">
      AI
    </div>
  );
}

function UserAvatar() {
  return (
    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-[hsl(var(--line))] bg-white text-[11px] font-semibold text-[hsl(var(--ink-2))]">
      You
    </div>
  );
}

export function ChatSidebar({ projectId, onAfterAction }: Props) {
  const messages = useChatStore((s) => s.messages);
  const sending = useChatStore((s) => s.sending);
  const setSending = useChatStore((s) => s.setSending);
  const add = useChatStore((s) => s.add);
  const setMessages = useChatStore((s) => s.setMessages);
  const [input, setInput] = useState("");
  const [confirmModal, setConfirmModal] = useState<{
    token: string;
    summary: string;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `/api/chat/messages?projectId=${projectId}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        setMessages(
          json.messages.map(
            (m: {
              id: string;
              role: string;
              content: string;
              toolCalls: string | null;
            }) => ({
              id: m.id,
              role: m.role as "user" | "assistant",
              content: m.content,
              toolCalls: m.toolCalls ? JSON.parse(m.toolCalls) : undefined,
            }),
          ),
        );
      } catch {
        /* ignore */
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId, setMessages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length, sending]);

  async function send(content: string, confirmBulkToken?: string) {
    if (!content.trim() && !confirmBulkToken) return;
    setSending(true);
    if (!confirmBulkToken) {
      add({
        id: `local-${Date.now()}`,
        role: "user",
        content,
      });
      setInput("");
    }
    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          message: confirmBulkToken ? "[confirmed]" : content,
          confirmBulkToken,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        add({
          id: `local-err-${Date.now()}`,
          role: "assistant",
          content: json.error ?? "Something went wrong. Try again.",
        });
        return;
      }
      const newMsg = {
        id: `local-asst-${Date.now()}`,
        role: "assistant" as const,
        content: json.assistantText,
        toolCalls: json.executions?.map(
          (e: {
            name: string;
            description: string;
            affectedCount?: number;
          }) => ({
            name: e.name,
            description: e.description,
            affectedCount: e.affectedCount,
          }),
        ),
        pendingConfirmation: json.pendingConfirmation
          ? {
              token: json.pendingConfirmation.token,
              summary: json.pendingConfirmation.summary,
            }
          : null,
      };
      add(newMsg);
      if (json.pendingConfirmation) {
        setConfirmModal({
          token: json.pendingConfirmation.token,
          summary: json.pendingConfirmation.summary,
        });
      }
      window.dispatchEvent(new Event("ai-usage-changed"));
      window.dispatchEvent(new Event("settings-changed"));
      await onAfterAction();
    } catch {
      add({
        id: `local-err-${Date.now()}`,
        role: "assistant",
        content:
          "We couldn't reach the AI service. Check your internet and try again.",
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-full flex-col" data-testid="chat-sidebar">
      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto px-3 py-3"
        data-testid="chat-thread"
      >
        {messages.length === 0 && (
          <div className="rounded-[6px] border border-dashed border-[hsl(var(--line))] bg-[hsl(var(--panel-2))] p-3 text-[12px] text-[hsl(var(--ink-2))]">
            <p className="font-medium text-[hsl(var(--ink))]">
              Talk to the takeoff
            </p>
            <p className="mt-1">Try one of these:</p>
            <ul className="mt-1.5 space-y-0.5 text-[12px] text-[hsl(var(--ink-2))]">
              <li>&quot;Change all bathroom walls to semi-gloss&quot;</li>
              <li>&quot;What&apos;s the total square footage?&quot;</li>
              <li>&quot;Exclude all corridor trim&quot;</li>
              <li>&quot;Set waste factor to 12%&quot;</li>
            </ul>
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            data-testid="chat-message"
            data-role={m.role}
            className="flex gap-2"
          >
            {m.role === "assistant" ? <AssistantAvatar /> : <UserAvatar />}
            <div className="min-w-0 flex-1">
              <div
                className={`rounded-[6px] px-3 py-2 text-[13px] ${
                  m.role === "user"
                    ? "bg-[hsl(var(--brand-soft))] text-[hsl(var(--ink))]"
                    : "bg-[hsl(var(--panel-2))] text-[hsl(var(--ink))]"
                }`}
              >
                <div className="whitespace-pre-wrap break-words leading-snug">
                  {m.content}
                </div>
              </div>
              {m.toolCalls && m.toolCalls.length > 0 && (
                <div className="mt-1.5 space-y-1">
                  {m.toolCalls.map((tc, i) => (
                    <div
                      key={i}
                      data-testid="chat-tool-call"
                      className="flex items-center gap-1.5 rounded-[4px] border border-[hsl(var(--line))] bg-white px-2 py-1 text-[12px] text-[hsl(var(--ink-2))]"
                    >
                      <span className="text-[hsl(var(--success))]">
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </span>
                      <span className="font-medium text-[hsl(var(--ink))]">
                        {tc.description}
                      </span>
                      {typeof tc.affectedCount === "number" && (
                        <span className="num text-[hsl(var(--ink-3))]">
                          ({tc.affectedCount})
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex gap-2" data-testid="chat-typing">
            <AssistantAvatar />
            <div className="rounded-[6px] bg-[hsl(var(--panel-2))] px-3 py-2 text-[13px] text-[hsl(var(--ink-3))]">
              <span className="inline-flex gap-1">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:120ms]" />
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:240ms]" />
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-[hsl(var(--line))] p-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
          className="flex gap-1.5"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask me to make changes…"
            data-testid="chat-input"
            disabled={sending}
            className="flex-1 rounded-[6px] border border-[hsl(var(--line))] bg-white px-2.5 py-1.5 text-[13px] focus:border-[hsl(var(--brand))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--brand-soft))] disabled:bg-[hsl(var(--panel-2))]"
          />
          <Button
            type="submit"
            size="sm"
            disabled={sending || !input.trim()}
            data-testid="chat-send"
          >
            Send
          </Button>
        </form>
      </div>

      {confirmModal && (
        <ConfirmBulkModal
          summary={confirmModal.summary}
          onCancel={() => setConfirmModal(null)}
          onConfirm={() => {
            const token = confirmModal.token;
            setConfirmModal(null);
            void send("[confirmed]", token);
          }}
        />
      )}
    </div>
  );
}

function ConfirmBulkModal({
  summary,
  onCancel,
  onConfirm,
}: {
  summary: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="dialog"
      data-testid="confirm-bulk-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[hsl(var(--ink))]/40 px-4"
    >
      <div className="w-full max-w-md rounded-[8px] border border-[hsl(var(--line))] bg-white p-5 shadow-xl">
        <h3 className="text-[15px] font-semibold text-[hsl(var(--ink))]">
          Confirm this change
        </h3>
        <p className="mt-1.5 text-[13px] text-[hsl(var(--ink-2))]">
          This will {summary}. Continue?
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm} data-testid="confirm-bulk-yes">
            Yes, continue
          </Button>
        </div>
      </div>
    </div>
  );
}
