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
  const messages = await db.chatMessage.findMany({
    where: {
      projectId,
      role: { in: ["user", "assistant"] },
    },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ messages });
}
