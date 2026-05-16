import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const upsertSchema = z.object({
  rates: z.array(
    z.object({
      surfaceType: z.string().min(1),
      unit: z.string().min(1),
      rate: z.number().min(0),
      hourlyCost: z.number().min(0),
      notes: z.string().nullable().optional(),
    }),
  ),
});

export async function GET() {
  const rates = await db.laborRate.findMany();
  return NextResponse.json({ rates });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid labor rates." },
      { status: 400 },
    );
  }
  await db.laborRate.deleteMany({});
  await db.laborRate.createMany({
    data: parsed.data.rates.map((r) => ({
      surfaceType: r.surfaceType,
      unit: r.unit,
      rate: r.rate,
      hourlyCost: r.hourlyCost,
      notes: r.notes ?? null,
    })),
  });
  return NextResponse.json({ ok: true });
}
