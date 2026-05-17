import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  wasteFactor: z.number().min(0).max(1).optional(),
  markup: z.number().min(0).max(1).optional(),
  overheadPct: z.number().min(0).max(1).optional(),
  measurementMode: z.enum(["net", "gross", "pca"]).optional(),
});

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

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          "Could not save settings — values must be between 0 and 1 (e.g. 0.20 for 20%).",
      },
      { status: 400 },
    );
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json(
      { error: "No settings provided to update." },
      { status: 400 },
    );
  }
  try {
    const project = await db.project.update({
      where: { id },
      data: parsed.data,
    });
    return NextResponse.json({ project });
  } catch {
    return NextResponse.json(
      { error: "Project not found or could not be updated." },
      { status: 404 },
    );
  }
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
