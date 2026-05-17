import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const applySchema = z.object({
  /** Surface IDs to apply this assembly to. */
  surfaceIds: z.array(z.string()).min(1),
});

/**
 * Apply an assembly to a set of surfaces — sets paintType and coats
 * from the assembly. The rest (production rate, waste, paint cost) is
 * pulled from the assembly at bid-calculation time.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = applySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Send surfaceIds[]." },
      { status: 400 },
    );
  }

  const assembly = await db.toolChestItem.findUnique({ where: { id } });
  if (!assembly) {
    return NextResponse.json(
      { error: "Assembly not found." },
      { status: 404 },
    );
  }

  const result = await db.surface.updateMany({
    where: { id: { in: parsed.data.surfaceIds } },
    data: {
      paintType: assembly.paintType,
      coats: assembly.coats,
    },
  });

  // Audit trail.
  const projectIds = await db.surface.findMany({
    where: { id: { in: parsed.data.surfaceIds } },
    select: { projectId: true },
    distinct: ["projectId"],
  });
  for (const { projectId } of projectIds) {
    await db.auditEntry.create({
      data: {
        projectId,
        action: `Applied assembly "${assembly.name}" to ${result.count} surface${result.count === 1 ? "" : "s"}.`,
        source: "user",
        after: JSON.stringify({ assemblyId: id, surfaceIds: parsed.data.surfaceIds }),
      },
    });
  }

  return NextResponse.json({
    updated: result.count,
    assembly: {
      id: assembly.id,
      name: assembly.name,
      paintType: assembly.paintType,
      coats: assembly.coats,
    },
  });
}
