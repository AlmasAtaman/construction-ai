import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { UsageBadge } from "@/components/usage/UsageBadge";
import { UsageWarningBanner } from "@/components/usage/UsageWarningBanner";
import { ProjectWorkspace } from "@/components/editor/ProjectWorkspace";
import { HistoryButton } from "@/components/editor/HistoryButton";
import { EditorStatusBar } from "@/components/editor/EditorStatusBar";
import { AppShell, TopBar } from "@/components/nav/AppShell";

export const dynamic = "force-dynamic";

function statusTone(s: string): "draft" | "active" | "sent" {
  if (s === "active") return "active";
  if (s === "sent") return "sent";
  return "draft";
}

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await db.project.findUnique({
    where: { id },
    include: {
      plans: {
        include: { pages: { orderBy: { pageNumber: "asc" } } },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!project) notFound();

  const latestPlan = project.plans[0] ?? null;

  return (
    <AppShell statusBar={<EditorStatusBar />}>
      <UsageWarningBanner />
      <TopBar
        title={project.name}
        subtitle={project.clientName ?? "No client set"}
        status={{ label: project.status, tone: statusTone(project.status) }}
      >
        <UsageBadge />
        <Link href={`/projects/${project.id}/specs`}>
          <Button variant="ghost" size="sm" data-testid="specs-link">
            Specs
          </Button>
        </Link>
        <Link href={`/projects/${project.id}/settings`}>
          <Button variant="ghost" size="sm" data-testid="project-settings-link">
            Settings
          </Button>
        </Link>
        <HistoryButton projectId={project.id} />
        {/* One door to the money. The old "See estimate" + "Get price" pair
            both went here; two buttons, one destination reads as two
            features. */}
        <Link href={`/projects/${project.id}/bid`}>
          <Button variant="primary" size="sm" data-testid="open-bid-link">
            Estimate
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" className="ml-1">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14m-6-6 6 6-6 6" />
            </svg>
          </Button>
        </Link>
      </TopBar>

      <ProjectWorkspace
        projectId={project.id}
        initialPlan={
          latestPlan
            ? {
                id: latestPlan.id,
                filename: latestPlan.filename,
                pageCount: latestPlan.pageCount,
                pages: latestPlan.pages.map((p) => ({
                  id: p.id,
                  pageNumber: p.pageNumber,
                  pageType: p.pageType,
                  hidden: p.hidden,
                })),
              }
            : null
        }
      />
    </AppShell>
  );
}
