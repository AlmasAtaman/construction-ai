import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

interface SurfaceSnapshot {
  id: string;
  paintType: string | null;
  coats: number;
  substrate: string | null;
  status: string;
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const entry = await db.auditEntry.findUnique({ where: { id } });
  if (!entry) {
    return NextResponse.json(
      { error: "History entry not found." },
      { status: 404 },
    );
  }
  if (!entry.before) {
    return NextResponse.json(
      {
        error:
          "This change can't be undone (no snapshot was saved).",
      },
      { status: 400 },
    );
  }

  // Two shapes of before: array of {id, paintType, ...} for bulk OR a single object.
  let snapshots: SurfaceSnapshot[] = [];
  try {
    const parsed = JSON.parse(entry.before);
    if (Array.isArray(parsed)) snapshots = parsed as SurfaceSnapshot[];
    else if (parsed && typeof parsed === "object") {
      snapshots = [parsed as SurfaceSnapshot];
    }
  } catch {
    return NextResponse.json(
      { error: "Couldn't read the previous state." },
      { status: 500 },
    );
  }

  if (snapshots.length === 0) {
    // Project-level change (e.g., waste factor)
    try {
      const parsed = JSON.parse(entry.before);
      if (
        parsed &&
        typeof parsed === "object" &&
        ("wasteFactor" in parsed ||
          "measurementMode" in parsed ||
          "markup" in parsed ||
          "overheadPct" in parsed)
      ) {
        await db.project.update({
          where: { id: entry.projectId },
          data: parsed,
        });
        await db.auditEntry.create({
          data: {
            projectId: entry.projectId,
            action: `Undid: ${entry.action}`,
            source: "user",
          },
        });
        return NextResponse.json({ ok: true });
      }
    } catch {
      /* fall through */
    }
  }

  for (const s of snapshots) {
    if (!s.id) continue;
    const data: Record<string, unknown> = {};
    if ("paintType" in s) data.paintType = s.paintType;
    if ("coats" in s) data.coats = s.coats;
    if ("substrate" in s) data.substrate = s.substrate;
    if ("status" in s) data.status = s.status;
    if (Object.keys(data).length === 0) continue;
    await db.surface.update({ where: { id: s.id }, data }).catch(() => {});
  }

  await db.auditEntry.create({
    data: {
      projectId: entry.projectId,
      action: `Undid: ${entry.action}`,
      source: "user",
    },
  });

  return NextResponse.json({ ok: true });
}
