import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VALID_TYPES = new Set([
  "floor_plan",
  "rcp",
  "elevation",
  "section",
  "schedule",
  "detail",
  "site_plan",
  "cover",
  "other",
]);

/**
 * Per-page overrides for the page rail: reclassify a sheet (promote a
 * misfiled floor plan, demote junk) or hide/restore it. Non-destructive —
 * never touches the source PDF.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: { pageType?: unknown; hidden?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const data: { pageType?: string; hidden?: boolean } = {};
  if ("pageType" in body) {
    if (typeof body.pageType !== "string" || !VALID_TYPES.has(body.pageType)) {
      return NextResponse.json({ error: "Invalid pageType" }, { status: 400 });
    }
    data.pageType = body.pageType;
  }
  if ("hidden" in body) {
    if (typeof body.hidden !== "boolean") {
      return NextResponse.json({ error: "Invalid hidden" }, { status: 400 });
    }
    data.hidden = body.hidden;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  try {
    const page = await db.planPage.update({
      where: { id },
      data,
      select: { id: true, pageNumber: true, pageType: true, hidden: true },
    });
    return NextResponse.json({ page });
  } catch {
    return NextResponse.json({ error: "Page not found" }, { status: 404 });
  }
}
