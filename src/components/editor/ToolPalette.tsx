"use client";

import { useEditorStore, type EditorTool } from "@/lib/store/editor-store";
import { cn } from "@/lib/utils";

interface Tool {
  id: EditorTool;
  label: string;
  shortcut: string;
  icon: React.ReactNode;
}

const TOOLS: Tool[] = [
  {
    id: "select",
    label: "Select",
    shortcut: "V",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l8 17 2.5-7.5L23 10 5 3z" />
      </svg>
    ),
  },
  {
    id: "rectangle",
    label: "Area",
    shortcut: "R",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7}>
        <rect x="4" y="6" width="16" height="12" rx="1" />
        <path d="M4 12h16" strokeDasharray="2 2" />
      </svg>
    ),
  },
  {
    id: "polygon",
    label: "Polygon",
    shortcut: "P",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l9 7-3 10H6l-3-10 9-7z" />
      </svg>
    ),
  },
  {
    id: "eraser",
    label: "Erase",
    shortcut: "E",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 17l6 6 12-12-9-9L3 11z" />
      </svg>
    ),
  },
  {
    id: "note",
    label: "Note",
    shortcut: "N",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9l-6-6z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M14 3v6h6" />
      </svg>
    ),
  },
];

export function ToolPalette() {
  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);

  return (
    <div
      data-testid="tool-palette"
      className="flex w-12 flex-shrink-0 flex-col items-center gap-1 border-r border-[hsl(var(--line))] bg-white py-2"
    >
      {TOOLS.map((t) => (
        <button
          key={t.id}
          onClick={() => setTool(t.id)}
          title={`${t.label} (${t.shortcut})`}
          data-testid={`tool-${t.id}`}
          data-active={tool === t.id ? "true" : "false"}
          className={cn(
            "group relative flex h-10 w-10 items-center justify-center rounded-[6px] transition-colors",
            tool === t.id
              ? "bg-[hsl(var(--brand))] text-white"
              : "text-[hsl(var(--ink-2))] hover:bg-[hsl(var(--panel-2))] hover:text-[hsl(var(--ink))]",
          )}
        >
          {t.icon}
          <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-[4px] bg-[hsl(var(--rail))] px-2 py-1 text-[11px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
            {t.label} <span className="opacity-70">({t.shortcut})</span>
          </span>
        </button>
      ))}
    </div>
  );
}
