import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runSanityChecks } from "@/lib/sanity-checks";
import type { SurfaceDTO } from "@/types/surface";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const project = await db.project.findUnique({ where: { id } });
  if (!project) {
    return NextResponse.json(
      { error: "Project not found." },
      { status: 404 },
    );
  }
  const surfaces = await db.surface.findMany({
    where: { projectId: id },
  });
  const dtos: SurfaceDTO[] = surfaces.map((s) => ({
    ...s,
    polygon: JSON.parse(s.polygon),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  })) as SurfaceDTO[];
  const report = runSanityChecks(dtos);
  return NextResponse.json({ report });
}
