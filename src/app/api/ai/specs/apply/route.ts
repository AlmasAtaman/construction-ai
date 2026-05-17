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

  // Load all surfaces with a room label once; the previous implementation
  // ran a per-entry `contains` query on `fs.room.split(" ")[0]`, which
  // turned "Bathroom 201" into "Bathroom" and silently over-applied that
  // entry's paint to every bathroom in the project. We now match on the
  // full room label, trimmed and case-insensitive. If a finish-schedule
  // row has no confident match we skip it — better to apply nothing than
  // overwrite the wrong surfaces in a money document.
  const allSurfaces = await db.surface.findMany({
    where: {
      projectId: parsed.data.projectId,
      roomLabel: { not: null },
    },
    select: { id: true, roomLabel: true },
  });

  let updated = 0;
  for (const fs of analysis.finishSchedule ?? []) {
    if (!fs.room) continue;
    const target = fs.room.trim().toLowerCase();
    if (!target) continue;
    const matches = allSurfaces.filter(
      (s) => (s.roomLabel ?? "").trim().toLowerCase() === target,
    );
    if (matches.length === 0) continue;
    for (const s of matches) {
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
