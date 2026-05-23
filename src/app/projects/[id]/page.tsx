import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { UsageBadge } from "@/components/usage/UsageBadge";
import { UsageWarningBanner } from "@/components/usage/UsageWarningBanner";
import { ProjectWorkspace } from "@/components/editor/ProjectWorkspace";
import { HistoryButton } from "@/components/editor/HistoryButton";
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
    <AppShell>
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
        <Link href={`/projects/${project.id}/bid`}>
          <Button variant="secondary" size="sm" data-testid="open-bid-link">
            See estimate
          </Button>
        </Link>
        <Link href={`/projects/${project.id}/bid`}>
          <Button variant="accent" size="sm" data-testid="generate-bid-cta">
            Get price
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
