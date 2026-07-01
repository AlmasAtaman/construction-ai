"use client";

import { StatusBar } from "@/components/nav/AppShell";
import { useEditorStore } from "@/lib/store/editor-store";

const TOOL_LABELS: Record<string, string> = {
  select: "Select",
  rectangle: "Area",
  polygon: "Polygon",
  "wall-path": "Trace wall",
  "room-wand": "Room wand",
  eraser: "Erase",
  note: "Note",
};

/**
 * Live status strip for the editor — the working facts an estimator
 * glances at (scale, active tool, kept counts), not build internals.
 */
export function EditorStatusBar() {
  const pageScale = useEditorStore((s) => s.pageScale);
  const tool = useEditorStore((s) => s.tool);
  const surfaces = useEditorStore((s) => s.surfaces);

  const kept = surfaces.filter(
    (s) => s.status === "accepted" || s.status === "manual",
  ).length;
  const proposed = surfaces.filter((s) => s.status === "proposed").length;

  return (
    <StatusBar
      segments={[
        {
          key: "Scale",
          value: pageScale ? pageScale.label : pageScale === null ? "not set" : "—",
        },
        { key: "Tool", value: TOOL_LABELS[tool] ?? tool },
        {
          key: "Kept",
          value: String(kept),
        },
        ...(proposed > 0
          ? [{ key: "To review", value: String(proposed) }]
          : []),
        { right: true, key: "Build", value: "PainterDesk · v0.5" },
      ]}
    />
  );
}
