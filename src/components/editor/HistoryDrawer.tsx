"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

interface AuditItem {
  id: string;
  action: string;
  source: string;
  createdAt: string;
  undoable: boolean;
}

interface Props {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onUndone: () => void | Promise<void>;
}

export function HistoryDrawer({ projectId, open, onClose, onUndone }: Props) {
  const [entries, setEntries] = useState<AuditItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/audit?projectId=${projectId}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled) setEntries(json.entries);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  if (!open) return null;

  async function undo(id: string) {
    await fetch(`/api/audit/${id}/undo`, { method: "POST" });
    await onUndone();
    // refresh history
    const res = await fetch(`/api/audit?projectId=${projectId}`, {
      cache: "no-store",
    });
    if (res.ok) {
      const json = await res.json();
      setEntries(json.entries);
    }
  }

  return (
    <div
      role="dialog"
      data-testid="history-drawer"
      className="fixed inset-0 z-40 flex justify-end bg-black/30"
      onClick={onClose}
    >
      <div
        className="flex h-full w-96 flex-col bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <h3 className="font-semibold text-gray-900">History</h3>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {loading && (
            <p className="px-2 text-sm text-gray-500">Loading...</p>
          )}
          {!loading && entries.length === 0 && (
            <p className="px-2 text-sm text-gray-500">
              No changes yet. Everything you and the AI do will appear here.
            </p>
          )}
          <ul className="space-y-2">
            {entries.map((e) => (
              <li
                key={e.id}
                data-testid="history-entry"
                className="rounded-md border border-gray-200 bg-white p-3"
              >
                <div className="text-sm text-gray-900">{e.action}</div>
                <div className="mt-1 flex items-center justify-between text-xs text-gray-500">
                  <span>
                    {e.source === "ai" ? "AI" : "You"} &middot;{" "}
                    {new Date(e.createdAt).toLocaleTimeString()}
                  </span>
                  {e.undoable && (
                    <Button
                      size="sm"
                      variant="secondary"
                      data-testid="history-undo"
                      onClick={() => void undo(e.id)}
                    >
                      Undo
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
