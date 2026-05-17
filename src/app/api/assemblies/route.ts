import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { ensureDefaultAssemblies } from "@/lib/assemblies";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(1),
  category: z.string().min(1),
  paintType: z.string().min(1),
  coats: z.number().int().min(1).max(10),
  productionRate: z.number().positive(),
  wasteFactor: z.number().min(0).max(1),
  laborRate: z.number().positive(),
  paintCost: z.number().positive(),
  notes: z.string().optional().nullable(),
});

export async function GET(): Promise<NextResponse> {
  await ensureDefaultAssemblies();
  const items = await db.toolChestItem.findMany({
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });
  return NextResponse.json({ assemblies: items });
}

export async function POST(req: Request): Promise<NextResponse> {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid assembly. Send name, category, paintType, coats, productionRate, wasteFactor, laborRate, paintCost." },
      { status: 400 },
    );
  }
  const created = await db.toolChestItem.create({ data: parsed.data });
  return NextResponse.json({ assembly: created });
}
