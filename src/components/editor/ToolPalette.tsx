"use client";

import {
  useEditorStore,
  type EditorTool,
  type SnapMode,
} from "@/lib/store/editor-store";
import { cn } from "@/lib/utils";

interface PaletteButton {
  key: string;
  label: string;
  shortcut?: string;
  /** Tool to activate. */
  tool: EditorTool;
  /** Optional snap mode to set (for wall-path sub-modes). */
  snap?: SnapMode;
  icon: React.ReactNode;
}

const BUTTONS: PaletteButton[] = [
  {
    key: "select",
    label: "Select",
    shortcut: "V",
    tool: "select",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l8 17 2.5-7.5L23 10 5 3z" />
      </svg>
    ),
  },
  {
    key: "rectangle",
    label: "Area",
    shortcut: "R",
    tool: "rectangle",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7}>
        <rect x="4" y="6" width="16" height="12" rx="1" />
        <path d="M4 12h16" strokeDasharray="2 2" />
      </svg>
    ),
  },
  {
    key: "polygon",
    label: "Polygon",
    shortcut: "P",
    tool: "polygon",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l9 7-3 10H6l-3-10 9-7z" />
      </svg>
    ),
  },
  {
    key: "wall-path",
    label: "Trace wall",
    shortcut: "W",
    tool: "wall-path",
    snap: "polyline",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 18 L9 18 L9 7 L17 7 L17 14 L21 14" />
        <circle cx="3" cy="18" r="1.4" fill="currentColor" stroke="none" />
        <circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none" />
        <circle cx="9" cy="7" r="1.4" fill="currentColor" stroke="none" />
        <circle cx="17" cy="7" r="1.4" fill="currentColor" stroke="none" />
        <circle cx="17" cy="14" r="1.4" fill="currentColor" stroke="none" />
        <circle cx="21" cy="14" r="1.4" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    key: "room",
    label: "Room wand",
    shortcut: "4",
    tool: "wall-path",
    snap: "room",
    icon: (
      // A room outline with a sparkle — click inside a room to auto-trace it.
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7}>
        <rect x="3" y="4" width="13" height="13" rx="1" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l1.2 2.8L23 18l-2.8 1.2L19 22l-1.2-2.8L15 18l2.8-1.2L19 14z" />
      </svg>
    ),
  },
  {
    key: "eraser",
    label: "Erase",
    shortcut: "E",
    tool: "eraser",
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 17l6 6 12-12-9-9L3 11z" />
      </svg>
    ),
  },
  {
    key: "note",
    label: "Note",
    shortcut: "N",
    tool: "note",
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
  const snapMode = useEditorStore((s) => s.snapMode);
  const setSnapMode = useEditorStore((s) => s.setSnapMode);

  const isActive = (b: PaletteButton): boolean => {
    if (b.tool !== "wall-path") return tool === b.tool;
    if (b.snap === "room") return tool === "wall-path" && snapMode === "room";
    // The plain wall-trace button: active for any non-room wall-path mode.
    return tool === "wall-path" && snapMode !== "room";
  };

  return (
    <div
      data-testid="tool-palette"
      className="flex w-12 flex-shrink-0 flex-col items-center gap-1 border-r border-[hsl(var(--line))] bg-white py-2"
    >
      {BUTTONS.map((b) => (
        <button
          key={b.key}
          onClick={() => {
            setTool(b.tool);
            if (b.snap) setSnapMode(b.snap);
          }}
          title={b.shortcut ? `${b.label} (${b.shortcut})` : b.label}
          data-testid={`tool-${b.key}`}
          data-active={isActive(b) ? "true" : "false"}
          className={cn(
            "group relative flex h-10 w-10 items-center justify-center rounded-[6px] transition-colors",
            isActive(b)
              ? "bg-[hsl(var(--brand))] text-white"
              : "text-[hsl(var(--ink-2))] hover:bg-[hsl(var(--panel-2))] hover:text-[hsl(var(--ink))]",
          )}
        >
          {b.icon}
          <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-[4px] bg-[hsl(var(--rail))] px-2 py-1 text-[11px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
            {b.label}
            {b.shortcut && <span className="opacity-70"> ({b.shortcut})</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
