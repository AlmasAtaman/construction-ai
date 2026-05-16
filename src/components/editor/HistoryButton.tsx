"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { HistoryDrawer } from "./HistoryDrawer";

export function HistoryButton({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen(true)}
        data-testid="history-button"
      >
        History
      </Button>
      <HistoryDrawer
        projectId={projectId}
        open={open}
        onClose={() => setOpen(false)}
        onUndone={async () => {
          // The workspace listens for an event to refresh.
          window.dispatchEvent(new Event("history-undone"));
        }}
      />
    </>
  );
}
