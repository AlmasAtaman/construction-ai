"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";

interface CommandItemSpec {
  id: string;
  label: string;
  hint?: string;
  action: () => void;
}

export function CommandPalette({ projectId }: { projectId?: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    function down(e: KeyboardEvent) {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  const commands: CommandItemSpec[] = [
    {
      id: "new-project",
      label: "New project",
      hint: "Start a new bid",
      action: () => {
        setOpen(false);
        router.push("/projects/new");
      },
    },
    {
      id: "settings",
      label: "Open settings",
      hint: "Labor rates, painter rules, usage",
      action: () => {
        setOpen(false);
        router.push("/settings");
      },
    },
    {
      id: "ai-usage",
      label: "View AI usage",
      hint: "Today's AI budget breakdown",
      action: () => {
        setOpen(false);
        router.push("/settings/usage");
      },
    },
  ];

  if (projectId) {
    commands.push(
      {
        id: "run-takeoff",
        label: "Run AI Takeoff on current page",
        hint: "Analyze the visible blueprint page",
        action: () => {
          setOpen(false);
          window.dispatchEvent(new Event("command:run-takeoff"));
        },
      },
      {
        id: "generate-bid",
        label: "Generate bid",
        hint: "Roll up surfaces into a proposal",
        action: () => {
          setOpen(false);
          router.push(`/projects/${projectId}/bid`);
        },
      },
      {
        id: "toggle-worksheet",
        label: "Toggle estimate worksheet",
        hint: "Hide or show the bottom panel",
        action: () => {
          setOpen(false);
          window.dispatchEvent(new Event("command:toggle-worksheet"));
        },
      },
      {
        id: "search-surfaces",
        label: "Search surfaces",
        hint: "Coming soon",
        action: () => setOpen(false),
      },
      {
        id: "specs",
        label: "Open specs analyzer",
        hint: "Read the specifications PDF",
        action: () => {
          setOpen(false);
          router.push(`/projects/${projectId}/specs`);
        },
      },
    );
  }

  if (!open) return null;

  return (
    <div
      data-testid="command-palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[15vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg border border-gray-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <Command label="Command palette">
          <div className="border-b border-gray-200 px-3 py-2">
            <Command.Input
              autoFocus
              placeholder="Type a command…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-gray-400"
              data-testid="command-input"
            />
          </div>
          <Command.List className="max-h-80 overflow-y-auto p-1">
            <Command.Empty className="px-3 py-4 text-sm text-gray-500">
              No commands match.
            </Command.Empty>
            {commands.map((c) => (
              <Command.Item
                key={c.id}
                onSelect={c.action}
                value={c.label}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-sm aria-selected:bg-blue-50"
                data-testid={`command-${c.id}`}
              >
                <span>{c.label}</span>
                {c.hint && (
                  <span className="text-xs text-gray-500">{c.hint}</span>
                )}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
