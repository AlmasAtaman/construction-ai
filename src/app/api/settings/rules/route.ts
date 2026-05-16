import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const schema = z.object({
  rules: z.array(
    z.object({
      category: z.string().default("general"),
      rule: z.string().min(1),
      active: z.boolean().default(true),
    }),
  ),
});

export async function GET() {
  const rules = await db.painterRule.findMany({
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ rules });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid rules." },
      { status: 400 },
    );
  }
  await db.painterRule.deleteMany({});
  await db.painterRule.createMany({
    data: parsed.data.rules.map((r) => ({
      category: r.category,
      rule: r.rule,
      active: r.active,
    })),
  });
  return NextResponse.json({ ok: true });
}
