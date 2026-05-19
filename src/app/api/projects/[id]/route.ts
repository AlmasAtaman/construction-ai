import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  wasteFactor: z.number().min(0).max(1).optional(),
  markup: z.number().min(0).max(1).optional(),
  overheadPct: z.number().min(0).max(1).optional(),
  measurementMode: z.enum(["net", "gross", "pca"]).optional(),
  ceilingHeightFt: z.number().min(6).max(30).optional(),
  /**
   * Set true when the caller wants the server to recompute wall
   * area_sqft = linear_ft × ceilingHeightFt for all PROPOSED wall
   * surfaces in this project. Accepted/manual surfaces are NEVER
   * silently mutated — the response reports their count so the UI
   * can prompt the estimator before opting in.
   */
  recomputeProposedWalls: z.boolean().optional(),
  /**
   * Set true ONLY after the estimator has explicitly confirmed they
   * want their accepted / hand-drawn walls recomputed with the new
   * ceiling height. The UI surfaces a confirmation prompt; this flag
   * is the user's "yes".
   */
  recomputeAcceptedWalls: z.boolean().optional(),
});

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const project = await db.project.findUnique({
    where: { id },
    include: {
      plans: {
        include: {
          pages: { orderBy: { pageNumber: "asc" } },
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!project) {
    return NextResponse.json(
      { error: "Project not found." },
      { status: 404 },
    );
  }
  return NextResponse.json({ project });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          "Could not save settings — values must be between 0 and 1 (e.g. 0.20 for 20%).",
      },
      { status: 400 },
    );
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json(
      { error: "No settings provided to update." },
      { status: 400 },
    );
  }
  try {
    const {
      recomputeProposedWalls,
      recomputeAcceptedWalls,
      ...projectData
    } = parsed.data;
    const project = await db.project.update({
      where: { id },
      data: projectData,
    });

    // When ceilingHeightFt changed, recompute wall area_sqft using
    // linear_ft × the new ceiling. Proposed surfaces are touched only
    // when `recomputeProposedWalls` is set; accepted/manual ones only
    // when `recomputeAcceptedWalls` is set (the UI gates this on an
    // explicit confirmation prompt).
    let recomputedProposedCount = 0;
    let recomputedAcceptedCount = 0;
    let affectedAcceptedCount = 0;
    if (
      (recomputeProposedWalls || recomputeAcceptedWalls) &&
      projectData.ceilingHeightFt != null
    ) {
      const ceilingHt = projectData.ceilingHeightFt;
      const walls = await db.surface.findMany({
        where: { projectId: id, type: "wall" },
        select: {
          id: true,
          status: true,
          linearFootage: true,
          squareFootage: true,
        },
      });
      for (const w of walls) {
        if (w.linearFootage == null || w.linearFootage <= 0) continue;
        const next = Math.round(w.linearFootage * ceilingHt * 10) / 10;
        const sameAsBefore =
          w.squareFootage != null && Math.abs(w.squareFootage - next) < 0.05;
        if (sameAsBefore) continue;
        if (w.status === "proposed" && recomputeProposedWalls) {
          await db.surface.update({
            where: { id: w.id },
            data: { squareFootage: next },
          });
          recomputedProposedCount++;
        } else if (
          (w.status === "accepted" || w.status === "manual") &&
          recomputeAcceptedWalls
        ) {
          await db.surface.update({
            where: { id: w.id },
            data: { squareFootage: next },
          });
          recomputedAcceptedCount++;
        } else if (w.status === "accepted" || w.status === "manual") {
          affectedAcceptedCount++;
        }
      }
    }

    return NextResponse.json({
      project,
      recomputedProposedCount,
      recomputedAcceptedCount,
      affectedAcceptedCount,
    });
  } catch {
    return NextResponse.json(
      { error: "Project not found or could not be updated." },
      { status: 404 },
    );
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    await db.project.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      {
        error:
          "Something went wrong deleting your project. Try again, or refresh the page.",
      },
      { status: 500 },
    );
  }
}
