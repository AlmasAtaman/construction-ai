import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const pointSchema = z.object({ x: z.number(), y: z.number() });
const mergeSchema = z.object({
  /** IDs of the surfaces to merge (must be 2+ in the same project + page). */
  surfaceIds: z.array(z.string()).min(2),
  /** Polygon for the merged surface — caller computes the union. */
  mergedPolygon: z.array(pointSchema).min(3),
  /** Optional new room label for the merged surface. */
  roomLabel: z.string().nullable().optional(),
});

/**
 * Merge two or more surfaces into one. Estimator uses this when AI
 * over-split a room (e.g., detected two slivers that are actually the
 * same room). The original surfaces are deleted; a new surface with
 * summed quantities and the caller-provided polygon is created.
 *
 * All surfaces must belong to the same project + plan page and have
 * the same type (can't merge a wall with a ceiling).
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = mergeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid merge request. Send `surfaceIds` (>=2) and `mergedPolygon`." },
      { status: 400 },
    );
  }
  const surfaces = await db.surface.findMany({
    where: { id: { in: parsed.data.surfaceIds } },
  });
  if (surfaces.length < 2) {
    return NextResponse.json(
      { error: "At least two existing surfaces are required." },
      { status: 400 },
    );
  }
  const projectId = surfaces[0].projectId;
  const planPageId = surfaces[0].planPageId;
  const type = surfaces[0].type;
  for (const s of surfaces) {
    if (s.projectId !== projectId) {
      return NextResponse.json(
        { error: "Surfaces must belong to the same project." },
        { status: 400 },
      );
    }
    if (s.planPageId !== planPageId) {
      return NextResponse.json(
        { error: "Surfaces must be on the same plan page." },
        { status: 400 },
      );
    }
    if (s.type !== type) {
      return NextResponse.json(
        { error: "Surfaces to merge must be the same type." },
        { status: 400 },
      );
    }
  }

  // Sum quantities across the merged surfaces.
  const sumOf = (k: "squareFootage" | "linearFootage" | "count"): number | null => {
    const values = surfaces.map((s) => s[k]).filter((v): v is number => v !== null);
    if (values.length === 0) return null;
    return values.reduce((a, b) => a + b, 0);
  };

  const first = surfaces[0];
  const merged = await db.$transaction(async (tx) => {
    const newSurface = await tx.surface.create({
      data: {
        projectId,
        planPageId,
        type,
        paintType: first.paintType,
        coats: first.coats,
        substrate: first.substrate,
        roomLabel: parsed.data.roomLabel ?? first.roomLabel,
        polygon: JSON.stringify(parsed.data.mergedPolygon),
        squareFootage: sumOf("squareFootage"),
        linearFootage: sumOf("linearFootage"),
        count: sumOf("count"),
        confidence: Math.max(...surfaces.map((s) => s.confidence)),
        status: first.status,
        source: "manual",
        notes: `merged from ${surfaces.length} surfaces`,
      },
    });
    await tx.surface.deleteMany({
      where: { id: { in: parsed.data.surfaceIds } },
    });
    await tx.auditEntry.create({
      data: {
        projectId,
        action: `Merged ${surfaces.length} ${type}s into one.`,
        source: "user",
        before: JSON.stringify(surfaces),
        after: JSON.stringify(newSurface),
      },
    });
    return newSurface;
  });

  return NextResponse.json({
    surface: { ...merged, polygon: JSON.parse(merged.polygon) },
  });
}
