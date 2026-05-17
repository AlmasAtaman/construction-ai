import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  buildProjectConfig,
  calculateBid,
} from "@/lib/math/bid-calculator";
import type { SurfaceDTO } from "@/types/surface";

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

  const config = buildProjectConfig({ project, rates });

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
