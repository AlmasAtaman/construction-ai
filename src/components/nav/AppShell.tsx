"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

interface RailItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  match: (p: string) => boolean;
}

function FolderIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  );
}
function SettingsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1A2 2 0 1 1 7 4.6l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  );
}
function MeterIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <path d="M21 12a9 9 0 1 1-9-9" />
      <path d="m12 12 4-3" />
    </svg>
  );
}
function BookIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5v-17Z" />
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    </svg>
  );
}

const RAIL: RailItem[] = [
  {
    href: "/",
    label: "Projects",
    icon: <FolderIcon />,
    match: (p) => p === "/" || p.startsWith("/projects"),
  },
  {
    href: "/settings/rates",
    label: "Rates",
    icon: <MeterIcon />,
    match: (p) => p.startsWith("/settings/rates"),
  },
  {
    href: "/settings/rules",
    label: "Rules",
    icon: <BookIcon />,
    match: (p) => p.startsWith("/settings/rules"),
  },
  {
    href: "/settings",
    label: "Settings",
    icon: <SettingsIcon />,
    match: (p) =>
      p === "/settings" ||
      p.startsWith("/settings/tool-chest") ||
      p.startsWith("/settings/usage"),
  },
];

export function LeftRail() {
  const pathname = usePathname() ?? "/";
  return (
    <nav
      data-testid="left-rail"
      className="flex h-full w-[60px] flex-col items-center gap-0.5 border-r border-black/30 bg-[hsl(var(--rail))] py-2"
    >
      <Link
        href="/"
        className="mb-1 flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] bg-[hsl(var(--brand))] text-[13px] font-bold text-white"
        title="PainterDesk — home"
      >
        P
      </Link>
      <div className="my-1 h-px w-8 bg-white/10" />
      <div className="flex flex-col gap-0.5">
        {RAIL.map((item) => {
          const active = item.match(pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              data-testid={`rail-${item.label.toLowerCase()}`}
              title={item.label}
              className={cn(
                "group flex w-[52px] flex-col items-center justify-center gap-0.5 rounded-[var(--radius-sm)] px-1 py-1.5 transition-colors",
                active
                  ? "bg-white/[0.09] text-white"
                  : "text-[hsl(var(--rail-fg))] hover:bg-white/[0.05] hover:text-white",
              )}
            >
              {item.icon}
              <span className="text-[9.5px] font-medium leading-none tracking-wide">
                {item.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export function TopBar({
  title,
  subtitle,
  status,
  children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  status?: { label: string; tone?: "draft" | "active" | "sent" };
  children?: React.ReactNode;
}) {
  return (
    <header className="flex h-11 flex-shrink-0 items-center justify-between border-b border-[hsl(var(--line))] bg-white px-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[13.5px] font-semibold tracking-[-0.005em] text-[hsl(var(--ink))]">
              {title}
            </h1>
            {status && (
              <span
                className={cn(
                  "pill",
                  status.tone === "active"
                    ? "pill-active"
                    : status.tone === "sent"
                      ? "pill-sent"
                      : "pill-draft",
                )}
              >
                {status.label}
              </span>
            )}
            {subtitle && (
              <span className="truncate text-[11.5px] text-[hsl(var(--ink-3))]">
                · {subtitle}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1.5">{children}</div>
    </header>
  );
}

interface StatusSegment {
  key?: string;
  value: React.ReactNode;
  right?: boolean;
}

export function StatusBar({ segments }: { segments: StatusSegment[] }) {
  return (
    <div className="statusbar" data-testid="status-bar">
      {segments.map((s, i) => (
        <span key={i} className={cn("seg", s.right && "right")}>
          {s.key && <span className="seg-key">{s.key}</span>}
          <span className="seg-val">{s.value}</span>
        </span>
      ))}
    </div>
  );
}

export function AppShell({
  children,
  statusBar,
}: {
  children: React.ReactNode;
  statusBar?: React.ReactNode;
}) {
  return (
    <div className="flex h-screen flex-col">
      <div className="flex min-h-0 flex-1">
        <LeftRail />
        <div className="flex h-full min-w-0 flex-1 flex-col">{children}</div>
      </div>
      {statusBar ?? <DefaultStatusBar />}
    </div>
  );
}

function DefaultStatusBar() {
  return (
    <StatusBar
      segments={[
        { key: "Ready", value: "" },
        { key: "Model", value: "Opus 4.7" },
        { right: true, key: "Build", value: "PainterDesk · v0.5" },
      ]}
    />
  );
}
