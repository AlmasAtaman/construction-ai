import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const pointSchema = z.object({ x: z.number(), y: z.number() });
const splitSchema = z.object({
  /** Two new polygons that should replace the original. */
  polygons: z.array(z.array(pointSchema).min(3)).length(2),
  /** Optional new room labels for each split. */
  labels: z.array(z.string().nullable()).length(2).optional(),
  /**
   * How to divide the original surface's quantity between the two
   * pieces. Default "area_weighted" — split sqft proportional to
   * polygon areas. Other option: "equal".
   */
  quantityMode: z.enum(["area_weighted", "equal"]).default("area_weighted"),
});

function shoelaceArea(poly: { x: number; y: number }[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum / 2);
}

/**
 * Split a detected surface into two pieces. The estimator does this
 * when AI merged two rooms into one face — they draw a line through
 * the polygon and end up with two separate surfaces.
 *
 * Result: the original surface is deleted; two new surfaces with the
 * same metadata (type, substrate, paint) and quantity proportional to
 * polygon areas are created. Each gets a unique label from the input.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = splitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid split request. Send `polygons` (two polygons of ≥3 points each)." },
      { status: 400 },
    );
  }
  const orig = await db.surface.findUnique({ where: { id } });
  if (!orig) {
    return NextResponse.json({ error: "Surface not found." }, { status: 404 });
  }

  const [polyA, polyB] = parsed.data.polygons;
  const [labelA, labelB] = parsed.data.labels ?? [
    orig.roomLabel,
    orig.roomLabel,
  ];

  // Apportion the original quantity by polygon area.
  const areaA = shoelaceArea(polyA);
  const areaB = shoelaceArea(polyB);
  const totalArea = Math.max(areaA + areaB, 1e-6);
  const fracA =
    parsed.data.quantityMode === "equal" ? 0.5 : areaA / totalArea;
  const fracB = 1 - fracA;

  function apportion(value: number | null, frac: number): number | null {
    if (value === null || value === undefined) return null;
    return Math.round(value * frac * 10) / 10;
  }

  const created = await db.$transaction(async (tx) => {
    const a = await tx.surface.create({
      data: {
        projectId: orig.projectId,
        planPageId: orig.planPageId,
        type: orig.type,
        paintType: orig.paintType,
        coats: orig.coats,
        substrate: orig.substrate,
        roomLabel: labelA ?? null,
        polygon: JSON.stringify(polyA),
        squareFootage: apportion(orig.squareFootage, fracA),
        linearFootage: apportion(orig.linearFootage, fracA),
        count: orig.count === null ? null : Math.round(orig.count * fracA),
        confidence: orig.confidence,
        status: orig.status,
        source: "manual",
        notes: orig.notes ? `${orig.notes} (split)` : "split from another surface",
      },
    });
    const b = await tx.surface.create({
      data: {
        projectId: orig.projectId,
        planPageId: orig.planPageId,
        type: orig.type,
        paintType: orig.paintType,
        coats: orig.coats,
        substrate: orig.substrate,
        roomLabel: labelB ?? null,
        polygon: JSON.stringify(polyB),
        squareFootage: apportion(orig.squareFootage, fracB),
        linearFootage: apportion(orig.linearFootage, fracB),
        count: orig.count === null ? null : Math.round(orig.count * fracB),
        confidence: orig.confidence,
        status: orig.status,
        source: "manual",
        notes: orig.notes ? `${orig.notes} (split)` : "split from another surface",
      },
    });
    await tx.surface.delete({ where: { id: orig.id } });
    await tx.auditEntry.create({
      data: {
        projectId: orig.projectId,
        action: `Split a ${orig.type}${orig.roomLabel ? ` in ${orig.roomLabel}` : ""} into two.`,
        source: "user",
        before: JSON.stringify(orig),
        after: JSON.stringify({ a, b }),
      },
    });
    return [a, b];
  });

  return NextResponse.json({
    surfaces: created.map((s) => ({
      ...s,
      polygon: JSON.parse(s.polygon),
    })),
  });
}
