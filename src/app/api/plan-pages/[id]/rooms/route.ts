import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { scanVectorPaths } from "@/lib/extract/page-extract";
import { detectRooms, type Segment } from "@/lib/planar-graph";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET — enclosed room faces for the click-a-room magic wand. Runs the
 * existing axis-aligned planar-graph room detector on this page's walls and
 * returns each room's boundary polygon, normalized 0..1 (y-down) to match
 * the overlay. The wand finds the face under the cursor and traces it as a
 * measured wall-path — scoped to one room, so dimension/tile noise (which
 * doesn't enclose a room) never gets picked up.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const page = await db.planPage.findUnique({
    where: { id },
    include: { plan: true },
  });
  if (!page) {
    return NextResponse.json({ error: "Page not found." }, { status: 404 });
  }

  const buf = await readFile(path.join(UPLOADS_DIR, page.plan.filePath));
  const { scan, pageWidthPt, pageHeightPt } = await scanVectorPaths(
    buf,
    page.pageNumber,
  );
  const segments: Segment[] = scan.walls.map((s) => ({
    x1: s.x1,
    y1: s.y1,
    x2: s.x2,
    y2: s.y2,
  }));
  const faces = detectRooms(segments, pageWidthPt, pageHeightPt, {});

  // Normalize each face polygon to 0..1, y-down (matches SurfaceOverlay).
  const rooms = faces.map((f) => ({
    points: f.polygon.map((p) => ({
      x: p.x / pageWidthPt,
      y: 1 - p.y / pageHeightPt,
    })),
    areaPt: Math.abs(f.area),
  }));

  return NextResponse.json({
    planPageId: id,
    pageNumber: page.pageNumber,
    rooms,
    ptPerFoot: page.scaleRatio,
    pageWidthPt,
    pageHeightPt,
  });
}
