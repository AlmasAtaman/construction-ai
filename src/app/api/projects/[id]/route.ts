import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const project = await db.project.findUnique({
    where: { id },
    include: {
      plans: {
        include: {
          pages: { orderBy: { pageNumber: "asc" } },
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!project) {
    return NextResponse.json(
      { error: "Project not found." },
      { status: 404 },
    );
  }
  return NextResponse.json({ project });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    await db.project.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      {
        error:
          "Something went wrong deleting your project. Try again, or refresh the page.",
      },
      { status: 500 },
    );
  }
}
