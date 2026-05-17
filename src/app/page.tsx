import Link from "next/link";
import { db } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { UsageBadge } from "@/components/usage/UsageBadge";
import { UsageWarningBanner } from "@/components/usage/UsageWarningBanner";
import { GlobalCommandPalette } from "@/components/command/GlobalCommandPalette";
import { AppShell, TopBar } from "@/components/nav/AppShell";
import { Input } from "@/components/ui/input";
import { ProjectRow } from "@/components/projects/ProjectRow";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const projects = await db.project.findMany({
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      clientName: true,
      status: true,
      updatedAt: true,
      _count: { select: { surfaces: true, plans: true } },
    },
  });

  return (
    <AppShell>
      <GlobalCommandPalette />
      <UsageWarningBanner />
      <TopBar title="Projects" subtitle="Active bids and proposals">
        <Input
          type="search"
          placeholder="Search projects…"
          className="h-9 w-64"
        />
        <UsageBadge />
        <Link href="/projects/new">
          <Button size="default" data-testid="new-project-button">
            New project
          </Button>
        </Link>
      </TopBar>

      <main className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-6xl">
          {projects.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-hidden rounded-[var(--radius)] border border-[hsl(var(--line))] bg-white">
              <table className="sheet w-full">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Client</th>
                    <th>Status</th>
                    <th className="text-right">Plans</th>
                    <th className="text-right">Rooms</th>
                    <th className="text-right">Updated</th>
                    <th className="w-[44px]"></th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => (
                    <ProjectRow key={p.id} project={p} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </AppShell>
  );
}

function EmptyState() {
  return (
    <div
      data-testid="empty-state"
      className="rounded-[var(--radius)] border border-[hsl(var(--line))] bg-white px-6 py-16 text-center"
    >
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-[8px] bg-[hsl(var(--brand-soft))] text-[hsl(var(--brand))]">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.7}
          stroke="currentColor"
          className="h-6 w-6"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
          />
        </svg>
      </div>
      <h3 className="text-[18px] font-semibold text-[hsl(var(--ink))]">
        No projects yet
      </h3>
      <p className="mx-auto mt-2 max-w-md text-[13px] text-[hsl(var(--ink-2))]">
        Each bid starts with a new project. Upload a blueprint, run the AI
        takeoff, and generate a professional proposal in minutes.
      </p>
      <div className="mt-6">
        <Link href="/projects/new">
          <Button size="lg" data-testid="empty-new-project-button">
            Create your first project
          </Button>
        </Link>
      </div>
    </div>
  );
}
