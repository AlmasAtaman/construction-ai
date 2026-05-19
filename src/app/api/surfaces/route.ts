import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  projectId: z.string().min(1),
  planPageId: z.string().min(1),
  // Accept any string here — supports new typed values like
  // "annotation:note" and "symbol:single_door" without a schema change.
  // Surface render code already discriminates on the prefix.
  type: z.string().min(1),
  polygon: z
    .array(z.object({ x: z.number(), y: z.number() }))
    .min(3),
  paintType: z.string().optional().nullable(),
  coats: z.number().int().min(1).max(10).default(2),
  substrate: z.string().optional().nullable(),
  roomLabel: z.string().optional().nullable(),
  squareFootage: z.number().optional().nullable(),
  linearFootage: z.number().optional().nullable(),
  count: z.number().int().optional().nullable(),
  notes: z.string().optional().nullable(),
  status: z.enum(["proposed", "accepted", "manual", "excluded"]).default("manual"),
  source: z.enum(["ai", "manual"]).default("manual"),
  derivation: z
    .enum([
      "scale-measured",
      "table-cross-checked",
      "traced",
      "sized-from-dimensions",
      "table-only",
      "virtual-partition",
      "scale-needed",
      "geometry-uncertain",
      "ai-fallback",
      "manual",
    ])
    .optional()
    .nullable(),
});

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId");
  const planPageId = searchParams.get("planPageId");
  if (!projectId && !planPageId) {
    return NextResponse.json({ error: "Missing filter." }, { status: 400 });
  }
  const surfaces = await db.surface.findMany({
    where: {
      ...(projectId ? { projectId } : {}),
      ...(planPageId ? { planPageId } : {}),
    },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({
    surfaces: surfaces.map((s) => ({
      ...s,
      polygon: JSON.parse(s.polygon) as { x: number; y: number }[],
    })),
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Could not create surface — invalid data." },
      { status: 400 },
    );
  }
  const d = parsed.data;
  const surface = await db.surface.create({
    data: {
      projectId: d.projectId,
      planPageId: d.planPageId,
      type: d.type,
      polygon: JSON.stringify(d.polygon),
      paintType: d.paintType ?? null,
      coats: d.coats,
      substrate: d.substrate ?? null,
      roomLabel: d.roomLabel ?? null,
      squareFootage: d.squareFootage ?? null,
      linearFootage: d.linearFootage ?? null,
      count: d.count ?? null,
      notes: d.notes ?? null,
      confidence: 1.0,
      status: d.status,
      source: d.source,
      derivation: d.derivation ?? (d.source === "manual" ? "manual" : null),
    },
  });

  await db.auditEntry.create({
    data: {
      projectId: d.projectId,
      action: `Drew a new ${d.type}${d.roomLabel ? ` in ${d.roomLabel}` : ""}.`,
      source: "user",
      after: JSON.stringify(surface),
    },
  });

  return NextResponse.json({
    surface: { ...surface, polygon: JSON.parse(surface.polygon) },
  });
}
