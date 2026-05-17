"use client";

import { useEffect, useRef, useState } from "react";
import { useChatStore } from "@/lib/store/chat-store";
import { Button } from "@/components/ui/button";

interface Props {
  projectId: string;
  onAfterAction: () => void | Promise<void>;
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [input]);

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

  function suggest(text: string) {
    setInput(text);
    textareaRef.current?.focus();
  }

  return (
    <div
      className="flex h-full flex-col bg-[hsl(var(--panel))]"
      data-testid="chat-sidebar"
    >
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-4"
        data-testid="chat-thread"
      >
        {messages.length === 0 && (
          <EmptyState onPick={suggest} />
        )}

        <div className="space-y-5">
          {messages.map((m) => (
            <MessageRow key={m.id} message={m} />
          ))}
          {sending && <TypingRow />}
        </div>
      </div>

      <Composer
        value={input}
        onChange={setInput}
        onSubmit={() => void send(input)}
        sending={sending}
        textareaRef={textareaRef}
      />

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

interface ToolCall {
  name: string;
  description: string;
  affectedCount?: number;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
}

function MessageRow({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <div data-testid="chat-message" data-role={message.role}>
      <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[hsl(var(--ink-3))]">
        {isUser ? "You" : "PainterDesk AI"}
      </div>
      <div
        className={
          isUser
            ? "rounded-[6px] bg-[hsl(var(--panel-2))] px-3 py-2.5 text-[13px] leading-[1.55] text-[hsl(var(--ink))]"
            : "px-0 text-[13px] leading-[1.55] text-[hsl(var(--ink))]"
        }
      >
        <div className="whitespace-pre-wrap break-words">
          {message.content}
        </div>
      </div>
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="mt-2 space-y-1">
          {message.toolCalls.map((tc, i) => (
            <ToolCallRow key={i} call={tc} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCallRow({ call }: { call: ToolCall }) {
  return (
    <div
      data-testid="chat-tool-call"
      className="flex items-center gap-2 rounded-[5px] border border-[hsl(var(--line))] bg-[hsl(var(--panel-2))] px-2.5 py-1.5 text-[12px]"
    >
      <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-[hsl(var(--success))] text-white">
        <svg
          viewBox="0 0 24 24"
          width="10"
          height="10"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
      <span className="truncate font-medium text-[hsl(var(--ink))]">
        {call.description}
      </span>
      {typeof call.affectedCount === "number" && (
        <span className="num ml-auto rounded-full bg-white px-1.5 py-0.5 text-[10.5px] font-medium text-[hsl(var(--ink-2))]">
          {call.affectedCount}
        </span>
      )}
    </div>
  );
}

function TypingRow() {
  return (
    <div data-testid="chat-typing">
      <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[hsl(var(--ink-3))]">
        PainterDesk AI
      </div>
      <div className="flex items-center gap-1 px-0 py-1 text-[hsl(var(--ink-3))]">
        <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
        <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:120ms]" />
        <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:240ms]" />
      </div>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  const examples = [
    "Change all bathroom walls to semi-gloss",
    "What's the total square footage?",
    "Exclude all corridor trim",
    "Set waste factor to 12%",
  ];
  return (
    <div className="pt-2">
      <div className="text-[13px] font-semibold text-[hsl(var(--ink))]">
        How can I help on this plan?
      </div>
      <div className="mt-1 text-[12px] text-[hsl(var(--ink-2))]">
        Ask anything about your takeoff — I can update rooms, paint specs, and
        more.
      </div>
      <div className="mt-4 space-y-1.5">
        {examples.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => onPick(ex)}
            className="block w-full rounded-[6px] border border-[hsl(var(--line))] bg-white px-3 py-2 text-left text-[12.5px] text-[hsl(var(--ink))] transition-colors hover:border-[hsl(var(--brand))] hover:bg-[hsl(var(--brand-soft))]"
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}

function Composer({
  value,
  onChange,
  onSubmit,
  sending,
  textareaRef,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  sending: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <div className="border-t border-[hsl(var(--line))] bg-[hsl(var(--panel))] px-3 pb-3 pt-2">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        className="rounded-[8px] border border-[hsl(var(--line))] bg-white shadow-[0_1px_0_rgba(0,0,0,0.02)] transition-colors focus-within:border-[hsl(var(--brand))] focus-within:ring-2 focus-within:ring-[hsl(var(--brand-soft))]"
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder="Ask anything — Enter to send, Shift+Enter for new line"
          rows={1}
          data-testid="chat-input"
          disabled={sending}
          className="block w-full resize-none bg-transparent px-3 pb-1 pt-2.5 text-[13px] leading-[1.5] text-[hsl(var(--ink))] placeholder:text-[hsl(var(--ink-3))] focus:outline-none disabled:opacity-60"
          style={{ maxHeight: 200 }}
        />
        <div className="flex items-center justify-between px-2 pb-1.5">
          <div className="flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-full bg-[hsl(var(--panel-2))] px-2 py-0.5 text-[10.5px] font-medium text-[hsl(var(--ink-2))]">
              <svg
                viewBox="0 0 24 24"
                width="10"
                height="10"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path d="M12 2 4 7v10l8 5 8-5V7z" />
              </svg>
              Opus 4.7
            </span>
            <span className="text-[10.5px] text-[hsl(var(--ink-3))]">
              this project
            </span>
          </div>
          <Button
            type="submit"
            size="sm"
            disabled={sending || !value.trim()}
            data-testid="chat-send"
            className="h-7 gap-1 px-2 text-[12px]"
          >
            {sending ? (
              "Sending…"
            ) : (
              <>
                Send
                <svg
                  viewBox="0 0 24 24"
                  width="12"
                  height="12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  aria-hidden="true"
                >
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </>
            )}
          </Button>
        </div>
      </form>
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
