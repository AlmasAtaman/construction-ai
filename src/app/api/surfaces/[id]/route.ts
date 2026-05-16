import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const updateSchema = z.object({
  status: z.enum(["proposed", "accepted", "manual", "excluded"]).optional(),
  paintType: z.string().nullable().optional(),
  coats: z.number().int().min(1).max(10).optional(),
  substrate: z.string().nullable().optional(),
  roomLabel: z.string().nullable().optional(),
  squareFootage: z.number().nullable().optional(),
  linearFootage: z.number().nullable().optional(),
  count: z.number().int().nullable().optional(),
  polygon: z.array(z.object({ x: z.number(), y: z.number() })).min(3).optional(),
});

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Could not update surface — invalid data." },
      { status: 400 },
    );
  }

  const existing = await db.surface.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json(
      { error: "Surface not found." },
      { status: 404 },
    );
  }

  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    if (k === "polygon") {
      data.polygon = JSON.stringify(v);
    } else {
      data[k] = v;
    }
  }

  const updated = await db.surface.update({ where: { id }, data });

  await db.auditEntry.create({
    data: {
      projectId: existing.projectId,
      action: describeUpdate(existing, parsed.data),
      source: "user",
      before: JSON.stringify(existing),
      after: JSON.stringify(updated),
    },
  });

  return NextResponse.json({
    surface: { ...updated, polygon: JSON.parse(updated.polygon) },
  });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const existing = await db.surface.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json(
      { error: "Surface not found." },
      { status: 404 },
    );
  }
  await db.surface.delete({ where: { id } });

  await db.auditEntry.create({
    data: {
      projectId: existing.projectId,
      action: `Removed a ${existing.type}${existing.roomLabel ? ` in ${existing.roomLabel}` : ""}.`,
      source: "user",
      before: JSON.stringify(existing),
    },
  });

  return NextResponse.json({ ok: true });
}

function describeUpdate(
  existing: { type: string; roomLabel: string | null },
  change: z.infer<typeof updateSchema>,
): string {
  const room = existing.roomLabel ? ` in ${existing.roomLabel}` : "";
  if (change.status === "accepted") {
    return `Accepted a ${existing.type}${room}.`;
  }
  if (change.status === "excluded") {
    return `Excluded a ${existing.type}${room} from the bid.`;
  }
  if (change.paintType) {
    return `Changed paint on a ${existing.type}${room} to ${change.paintType}.`;
  }
  if (typeof change.coats === "number") {
    return `Changed coats on a ${existing.type}${room} to ${change.coats}.`;
  }
  if (change.substrate) {
    return `Changed substrate on a ${existing.type}${room} to ${change.substrate}.`;
  }
  return `Updated a ${existing.type}${room}.`;
}
