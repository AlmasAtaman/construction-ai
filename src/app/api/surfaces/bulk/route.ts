import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const bulkUpdateSchema = z.object({
  ids: z.array(z.string()).min(1),
  changes: z.object({
    status: z.enum(["proposed", "accepted", "manual", "excluded"]).optional(),
    paintType: z.string().nullable().optional(),
    coats: z.number().int().min(1).max(10).optional(),
    substrate: z.string().nullable().optional(),
  }),
});

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = bulkUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid bulk update." },
      { status: 400 },
    );
  }

  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data.changes)) {
    if (v === undefined) continue;
    data[k] = v;
  }

  const result = await db.surface.updateMany({
    where: { id: { in: parsed.data.ids } },
    data,
  });

  // Audit entry: pick the first surface's project for the entry (all should match).
  const sample = await db.surface.findFirst({
    where: { id: { in: parsed.data.ids } },
  });
  if (sample) {
    await db.auditEntry.create({
      data: {
        projectId: sample.projectId,
        action: describeBulk(parsed.data.ids.length, parsed.data.changes),
        source: "user",
        after: JSON.stringify({ ids: parsed.data.ids, ...parsed.data.changes }),
      },
    });
  }

  return NextResponse.json({ updated: result.count });
}

function describeBulk(
  n: number,
  changes: { status?: string; paintType?: string | null; coats?: number; substrate?: string | null },
): string {
  if (changes.status === "accepted")
    return `Accepted ${n} surface${n === 1 ? "" : "s"}.`;
  if (changes.status === "excluded")
    return `Excluded ${n} surface${n === 1 ? "" : "s"} from the bid.`;
  if (changes.paintType)
    return `Changed paint on ${n} surface${n === 1 ? "" : "s"} to ${changes.paintType}.`;
  if (typeof changes.coats === "number")
    return `Changed coats on ${n} surface${n === 1 ? "" : "s"} to ${changes.coats}.`;
  return `Updated ${n} surface${n === 1 ? "" : "s"}.`;
}
