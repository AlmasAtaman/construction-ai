"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";

interface Project {
  id: string;
  name: string;
  clientName: string | null;
  status: string;
  updatedAt: Date;
  _count: { surfaces: number; plans: number };
}

function statusTone(status: string): "draft" | "active" | "sent" {
  if (status === "active") return "active";
  if (status === "sent") return "sent";
  return "draft";
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function ProjectRow({ project: p }: { project: Project }) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectHref = `/projects/${p.id}`;

  // Mouse users click anywhere on the row to open. Keyboard users still
  // tab to the project-name <Link> and the kebab trigger — both are real
  // interactive elements with focus rings.
  function handleRowClick(e: React.MouseEvent<HTMLTableRowElement>) {
    // Cmd/Ctrl/middle-click → open in new tab (preserve browser semantics)
    if (e.metaKey || e.ctrlKey || e.button === 1) {
      window.open(projectHref, "_blank", "noopener,noreferrer");
      return;
    }
    router.push(projectHref);
  }

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    const res = await fetch(`/api/projects/${p.id}`, { method: "DELETE" });
    setDeleting(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "Couldn't delete this project. Try again.");
      return;
    }
    setConfirmOpen(false);
    router.refresh();
  }

  return (
    <tr
      onClick={handleRowClick}
      className="cursor-pointer transition-colors hover:bg-[hsl(var(--panel-2))]"
      data-testid="project-row"
      data-project-id={p.id}
    >
      <td>
        <Link
          href={projectHref}
          onClick={(e) => e.stopPropagation()}
          className="font-medium text-[hsl(var(--ink))] hover:text-[hsl(var(--brand))]"
        >
          {p.name}
        </Link>
      </td>
      <td className="text-[hsl(var(--ink-2))]">{p.clientName ?? "—"}</td>
      <td>
        <span className={`pill pill-${statusTone(p.status)}`}>{p.status}</span>
      </td>
      <td className="text-right num text-[hsl(var(--ink-2))]">
        {p._count.plans}
      </td>
      <td className="text-right num text-[hsl(var(--ink-2))]">
        {p._count.surfaces}
      </td>
      <td className="text-right text-[hsl(var(--ink-3))]">
        {formatDate(p.updatedAt)}
      </td>
      <td
        className="text-right"
        // Action cell must not propagate clicks to the row.
        onClick={(e) => e.stopPropagation()}
      >
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${p.name}`}
              data-testid="project-row-actions"
            >
              <KebabIcon />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              className="z-50 min-w-[180px] rounded-[6px] border border-[hsl(var(--line))] bg-white p-1 shadow-lg"
            >
              <DropdownMenu.Item asChild>
                <Link
                  href={projectHref}
                  className="flex cursor-pointer items-center rounded-[4px] px-2.5 py-1.5 text-[13px] text-[hsl(var(--ink))] outline-none data-[highlighted]:bg-[hsl(var(--panel-2))]"
                  data-testid="project-row-open"
                >
                  Open
                </Link>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() =>
                  window.open(projectHref, "_blank", "noopener,noreferrer")
                }
                className="cursor-pointer rounded-[4px] px-2.5 py-1.5 text-[13px] text-[hsl(var(--ink))] outline-none data-[highlighted]:bg-[hsl(var(--panel-2))]"
              >
                Open in new tab
              </DropdownMenu.Item>
              <DropdownMenu.Item asChild>
                <Link
                  href={`${projectHref}/settings`}
                  className="flex cursor-pointer items-center rounded-[4px] px-2.5 py-1.5 text-[13px] text-[hsl(var(--ink))] outline-none data-[highlighted]:bg-[hsl(var(--panel-2))]"
                >
                  Project settings
                </Link>
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-[hsl(var(--line))]" />
              <DropdownMenu.Item
                onSelect={(e) => {
                  // Prevent the menu's default close; let our dialog manage focus.
                  e.preventDefault();
                  setConfirmOpen(true);
                }}
                className="cursor-pointer rounded-[4px] px-2.5 py-1.5 text-[13px] text-[hsl(var(--danger))] outline-none data-[highlighted]:bg-[hsl(var(--danger))]/10"
                data-testid="project-row-delete"
              >
                Delete project…
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        <Dialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
            <Dialog.Content
              className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[8px] border border-[hsl(var(--line))] bg-white p-5 text-left shadow-xl"
              data-testid="delete-project-dialog"
            >
              <Dialog.Title className="text-[15px] font-semibold text-[hsl(var(--ink))]">
                Delete this project?
              </Dialog.Title>
              <Dialog.Description className="mt-1.5 text-[13px] leading-[1.5] text-[hsl(var(--ink-2))]">
                <strong>{p.name}</strong> and every blueprint, surface, bid
                version, and history entry on it will be permanently
                removed. This can&apos;t be undone.
              </Dialog.Description>
              {error && (
                <div
                  role="alert"
                  className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800"
                >
                  {error}
                </div>
              )}
              <div className="mt-5 flex justify-end gap-2">
                <Dialog.Close asChild>
                  <Button variant="secondary" disabled={deleting}>
                    Cancel
                  </Button>
                </Dialog.Close>
                <Button
                  variant="destructive"
                  onClick={() => void handleDelete()}
                  disabled={deleting}
                  data-testid="delete-project-confirm"
                >
                  {deleting ? "Deleting…" : "Delete project"}
                </Button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </td>
    </tr>
  );
}

function KebabIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <circle cx="12" cy="5" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="19" r="1.2" fill="currentColor" />
    </svg>
  );
}
