import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { scanVectorPaths } from "@/lib/extract/page-extract";
import { detectRooms, type Segment } from "@/lib/planar-graph";
import { extractTextLayer, pickRoomLabels } from "@/lib/pdf-render";
import { scanSegmentsByLayer } from "@/lib/extract/layer-scan";
import { classifyLayers, WALL_ROLES } from "@/lib/extract/layer-classify";
import { extractRoomSeeds } from "@/lib/extract/room-seeds";
import { segmentRoomsBySeeds } from "@/lib/extract/seeded-rooms";

/** Even-odd point-in-polygon (normalized coords). */
function inPoly(
  poly: { x: number; y: number }[],
  x: number,
  y: number,
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

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

  // --- Preferred: seeded room segmentation. Splits OPEN-CONNECTED rooms
  // that planar-graph face detection merges into one blob, using the
  // correct CAD-layer walls as barriers and the architect's in-room tags
  // as seeds. Needs ≥2 room tags + wall layers; otherwise falls back. ---
  let seededRooms: {
    points: { x: number; y: number }[];
    areaPt: number;
    label: string | null;
  }[] | null = null;
  try {
    const layerScan = await scanSegmentsByLayer(buf, page.pageNumber);
    if (layerScan.layerNames.length > 0) {
      const roles = Object.fromEntries(
        classifyLayers(Object.keys(layerScan.segmentsPerLayer)).map((c) => [
          c.name,
          c.role,
        ]),
      );
      const wallSegs = layerScan.segments
        .filter((s) => s.layer && WALL_ROLES.has(roles[s.layer]) && !s.diagonal)
        .map((s) => ({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 }));
      const seeds = await extractRoomSeeds(buf, page.pageNumber);
      if (wallSegs.length > 0 && seeds.length >= 2) {
        const ptPerFoot = page.scaleRatio ?? 18;
        const result = segmentRoomsBySeeds(wallSegs, seeds, {
          ptPerFoot,
          pageWidthPt,
          pageHeightPt,
        });
        if (result && result.rooms.length >= 2) {
          seededRooms = result.rooms.map((r) => ({
            points: r.polygonPt.map((p) => ({
              x: p.x / pageWidthPt,
              y: p.y / pageHeightPt,
            })),
            areaPt: r.areaSqft * ptPerFoot * ptPerFoot,
            label: r.label,
          }));
        }
      }
    }
  } catch (err) {
    console.error("[rooms] seeded segmentation failed, using planar:", err);
  }

  const segments: Segment[] = scan.walls.map((s) => ({
    x1: s.x1,
    y1: s.y1,
    x2: s.x2,
    y2: s.y2,
  }));
  const faces = seededRooms ? [] : detectRooms(segments, pageWidthPt, pageHeightPt, {});

  // Pull room-label text (Kitchen, Overstock, …) so the wand can auto-name
  // each room it traces. TextFragment positions are already normalized
  // 0..1 y-down, matching the face polygons.
  let labels: { text: string; xNorm: number; yNorm: number }[] = [];
  try {
    const { textFragments } = await extractTextLayer(buf, page.pageNumber);
    // Keep only room-name-like text: short, lettered, no punctuation that
    // marks it as a note/title-block string (":", ".", leading digit).
    labels = pickRoomLabels(textFragments).filter((l) => {
      const t = l.text.trim();
      return (
        t.length >= 2 &&
        t.length <= 18 &&
        /[A-Za-z]/.test(t) &&
        !/[:."]/.test(t) &&
        !/^\d/.test(t)
      );
    });
  } catch {
    /* no labels — rooms just come back unnamed */
  }

  // Normalize each face polygon to 0..1, y-down (matches SurfaceOverlay), and
  // attach the room label whose position falls inside the face. The mupdf
  // scan already emits top-left-origin y-down coordinates, so y passes
  // through unflipped (the old `1 - y` mirrored every face vertically —
  // the wand only highlighted when hovering at the mirrored position).
  const rooms =
    seededRooms ??
    faces.map((f) => {
      const points = f.polygon.map((p) => ({
        x: p.x / pageWidthPt,
        y: p.y / pageHeightPt,
      }));
      const hit = labels.find((l) => inPoly(points, l.xNorm, l.yNorm));
      return { points, areaPt: Math.abs(f.area), label: hit?.text ?? null };
    });

  return NextResponse.json({
    planPageId: id,
    pageNumber: page.pageNumber,
    rooms,
    ptPerFoot: page.scaleRatio,
    pageWidthPt,
    pageHeightPt,
  });
}
