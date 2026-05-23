import { NextResponse } from "next/server";
import { classifyPlanPages } from "@/lib/ai/classify-plan";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let force = false;
  try {
    const body = await req.json();
    force = body?.force === true;
  } catch {
    /* no body — default force=false */
  }
  try {
    const pages = await classifyPlanPages(id, { force });
    return NextResponse.json({ pages });
  } catch {
    return NextResponse.json(
      { error: "Could not classify pages." },
      { status: 500 },
    );
  }
}
