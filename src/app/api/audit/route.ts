import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json(
      { error: "Missing project ID." },
      { status: 400 },
    );
  }
  const entries = await db.auditEntry.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return NextResponse.json({
    entries: entries.map((e) => ({
      id: e.id,
      action: e.action,
      source: e.source,
      createdAt: e.createdAt.toISOString(),
      undoable: Boolean(e.before),
    })),
  });
}
