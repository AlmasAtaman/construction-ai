import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import type { SpecAnalysisResponse } from "@/lib/ai/test-mode";

export const dynamic = "force-dynamic";

const schema = z.object({
  projectId: z.string().min(1),
  specId: z.string().min(1),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request." },
      { status: 400 },
    );
  }

  const spec = await db.spec.findUnique({ where: { id: parsed.data.specId } });
  if (!spec || !spec.aiSummary) {
    return NextResponse.json(
      { error: "Spec analysis not available." },
      { status: 404 },
    );
  }

  let analysis: SpecAnalysisResponse;
  try {
    analysis = JSON.parse(spec.aiSummary) as SpecAnalysisResponse;
  } catch {
    return NextResponse.json(
      { error: "Couldn't read the spec analysis." },
      { status: 500 },
    );
  }

  let updated = 0;
  // For each finish schedule entry, update surfaces whose roomLabel matches.
  for (const fs of analysis.finishSchedule ?? []) {
    if (!fs.room) continue;
    const surfaces = await db.surface.findMany({
      where: {
        projectId: parsed.data.projectId,
        roomLabel: { contains: fs.room.split(" ")[0] },
      },
    });
    for (const s of surfaces) {
      await db.surface.update({
        where: { id: s.id },
        data: { paintType: fs.paintType },
      });
      updated++;
    }
  }

  await db.auditEntry.create({
    data: {
      projectId: parsed.data.projectId,
      action: `Applied spec finish schedule to ${updated} surface${updated === 1 ? "" : "s"}.`,
      source: "ai",
      after: JSON.stringify({ specId: parsed.data.specId, updated }),
    },
  });

  return NextResponse.json({ updated });
}
