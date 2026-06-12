import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { scanSegmentsByLayer } from "@/lib/extract/layer-scan";
import {
  classifyLayers,
  type LayerRole,
} from "@/lib/extract/layer-classify";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface LayerEntry {
  name: string;
  role: LayerRole;
  segments: number;
}

interface LayersPayload {
  planPageId: string;
  /** Layers actually drawn on this page. Empty = flattened PDF. */
  layers: LayerEntry[];
  hasWallLayers: boolean;
  source: "cache" | "fresh";
}

/**
 * GET the CAD layer (PDF optional content) summary for a page: which
 * layers are drawn on it, their classified role, and how many vector
 * segments each contributes. Drives the takeoff-layers panel. Cached in
 * PlanPage.layersJson (layers can't change unless the PDF is replaced).
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

  const hasWalls = (layers: LayerEntry[]): boolean =>
    layers.some((l) => l.role === "wall-new" || l.role === "wall-existing");

  if (page.layersJson) {
    try {
      const cached = JSON.parse(page.layersJson) as { layers: LayerEntry[] };
      const payload: LayersPayload = {
        planPageId: id,
        layers: cached.layers,
        hasWallLayers: hasWalls(cached.layers),
        source: "cache",
      };
      return NextResponse.json(payload);
    } catch {
      // Corrupted cache — fall through and rebuild.
    }
  }

  const buf = await readFile(path.join(UPLOADS_DIR, page.plan.filePath));
  const scan = await scanSegmentsByLayer(buf, page.pageNumber);
  const present = Object.keys(scan.segmentsPerLayer);
  const classified = classifyLayers(present);
  const layers: LayerEntry[] = classified.map((c) => ({
    name: c.name,
    role: c.role,
    segments: scan.segmentsPerLayer[c.name],
  }));

  await db.planPage.update({
    where: { id },
    data: { layersJson: JSON.stringify({ layers }) },
  });

  const payload: LayersPayload = {
    planPageId: id,
    layers,
    hasWallLayers: hasWalls(layers),
    source: "fresh",
  };
  return NextResponse.json(payload);
}
