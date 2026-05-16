"use client";

import { useEffect, useState } from "react";
import { useEditorStore } from "@/lib/store/editor-store";
import { Button } from "@/components/ui/button";

export function UndoToast() {
  const pending = useEditorStore((s) => s.pendingUndo);
  const setPending = useEditorStore((s) => s.setPendingUndo);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [pending]);

  useEffect(() => {
    if (!pending) return;
    if (now >= pending.expiresAt) {
      setPending(null);
    }
  }, [now, pending, setPending]);

  if (!pending) return null;
  const secondsLeft = Math.max(
    0,
    Math.ceil((pending.expiresAt - now) / 1000),
  );

  return (
    <div
      data-testid="undo-toast"
      className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-2.5 shadow-lg"
    >
      <span className="text-sm text-gray-700">{pending.label}</span>
      <Button
        size="sm"
        variant="secondary"
        data-testid="undo-button"
        onClick={async () => {
          const fn = pending.undo;
          setPending(null);
          await fn();
        }}
      >
        Undo ({secondsLeft}s)
      </Button>
    </div>
  );
}
