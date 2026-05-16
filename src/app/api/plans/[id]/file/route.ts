import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const plan = await db.plan.findUnique({ where: { id } });
  if (!plan) {
    return NextResponse.json({ error: "Plan not found." }, { status: 404 });
  }
  const filePath = path.join(UPLOADS_DIR, plan.filePath);
  if (!existsSync(filePath)) {
    return NextResponse.json(
      { error: "Uploaded file is missing." },
      { status: 404 },
    );
  }
  const data = await readFile(filePath);
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${plan.filename}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
