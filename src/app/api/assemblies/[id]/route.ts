import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  paintType: z.string().min(1).optional(),
  coats: z.number().int().min(1).max(10).optional(),
  productionRate: z.number().positive().optional(),
  wasteFactor: z.number().min(0).max(1).optional(),
  laborRate: z.number().positive().optional(),
  paintCost: z.number().positive().optional(),
  notes: z.string().nullable().optional(),
});

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid update." },
      { status: 400 },
    );
  }
  try {
    const updated = await db.toolChestItem.update({
      where: { id },
      data: parsed.data,
    });
    return NextResponse.json({ assembly: updated });
  } catch {
    return NextResponse.json(
      { error: "Assembly not found." },
      { status: 404 },
    );
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  try {
    await db.toolChestItem.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Assembly not found." },
      { status: 404 },
    );
  }
}
