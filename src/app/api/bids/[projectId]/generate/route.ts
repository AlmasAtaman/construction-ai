import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  calculateBid,
  DEFAULT_CONFIG,
  type BidConfig,
} from "@/lib/math/bid-calculator";
import type { SurfaceDTO, SurfaceType } from "@/types/surface";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return NextResponse.json(
      { error: "Project not found." },
      { status: 404 },
    );
  }

  const surfaces = await db.surface.findMany({ where: { projectId } });
  const surfaceDtos: SurfaceDTO[] = surfaces.map((s) => ({
    ...s,
    polygon: JSON.parse(s.polygon),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  })) as SurfaceDTO[];

  const rates = await db.laborRate.findMany();
  const rules = await db.painterRule.findMany({ where: { active: true } });

  const hourlyCostBySurface: Partial<Record<SurfaceType, number>> = {};
  for (const r of rates) {
    hourlyCostBySurface[r.surfaceType as SurfaceType] = r.hourlyCost;
  }
  let wasteFactor = project.wasteFactor;
  for (const r of rules) {
    const m =
      r.rule.match(/(\d+(?:\.\d+)?)\s*%\s*waste/i) ??
      r.rule.match(/waste.*?(\d+(?:\.\d+)?)\s*%/i);
    if (m) wasteFactor = parseFloat(m[1]) / 100;
  }

  const config: BidConfig = {
    ...DEFAULT_CONFIG,
    measurementMode: project.measurementMode as "net" | "gross" | "pca",
    wasteFactor,
    markup: project.markup,
    hourlyCostBySurface,
  };

  const bid = calculateBid(surfaceDtos, config);

  const last = await db.bidVersion.findFirst({
    where: { projectId },
    orderBy: { versionNumber: "desc" },
  });
  const versionNumber = (last?.versionNumber ?? 0) + 1;

  const created = await db.bidVersion.create({
    data: {
      projectId,
      versionNumber,
      totalMaterial: bid.totalMaterial,
      totalLabor: bid.totalLabor,
      totalOverhead: bid.totalOverhead,
      totalMarkup: bid.totalMarkup,
      grandTotal: bid.grandTotal,
      lineItems: JSON.stringify(bid.lineItems),
    },
  });

  return NextResponse.json({
    bid: {
      id: created.id,
      versionNumber: created.versionNumber,
      ...bid,
    },
  });
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  const versions = await db.bidVersion.findMany({
    where: { projectId },
    orderBy: { versionNumber: "desc" },
  });
  if (versions.length === 0) {
    return NextResponse.json({ bid: null });
  }
  const latest = versions[0];
  return NextResponse.json({
    bid: {
      id: latest.id,
      versionNumber: latest.versionNumber,
      totalMaterial: latest.totalMaterial,
      totalLabor: latest.totalLabor,
      totalOverhead: latest.totalOverhead,
      totalMarkup: latest.totalMarkup,
      grandTotal: latest.grandTotal,
      lineItems: JSON.parse(latest.lineItems),
    },
  });
}
