import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { diffTakeoffs } from "@/lib/takeoff-diff";
import type { SurfaceDTO } from "@/types/surface";

export const dynamic = "force-dynamic";

/**
 * GET /api/projects/[id]/compare?against=<otherProjectId>
 *
 * Diff this project's surfaces against another project's surfaces.
 * Useful when the user re-uploads a revised plan as a new project and
 * wants a per-room change report (added/removed/resized rooms, symbol
 * count deltas).
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const against = url.searchParams.get("against");
  if (!against) {
    return NextResponse.json(
      { error: "Pass ?against=<project-id> for comparison." },
      { status: 400 },
    );
  }
  if (against === id) {
    return NextResponse.json(
      { error: "Cannot compare a project to itself." },
      { status: 400 },
    );
  }

  const [thisProject, otherProject] = await Promise.all([
    db.project.findUnique({ where: { id } }),
    db.project.findUnique({ where: { id: against } }),
  ]);
  if (!thisProject || !otherProject) {
    return NextResponse.json(
      { error: "One or both projects not found." },
      { status: 404 },
    );
  }
  const [oldSurfaces, newSurfaces] = await Promise.all([
    db.surface.findMany({ where: { projectId: against } }),
    db.surface.findMany({ where: { projectId: id } }),
  ]);

  const oldDtos = oldSurfaces.map(
    (s) =>
      ({
        ...s,
        polygon: JSON.parse(s.polygon),
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      }) as SurfaceDTO,
  );
  const newDtos = newSurfaces.map(
    (s) =>
      ({
        ...s,
        polygon: JSON.parse(s.polygon),
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      }) as SurfaceDTO,
  );

  const diff = diffTakeoffs(oldDtos, newDtos);

  return NextResponse.json({
    diff,
    thisProject: { id: thisProject.id, name: thisProject.name },
    otherProject: { id: otherProject.id, name: otherProject.name },
  });
}
