import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

interface CsvLineItem {
  type: string;
  roomLabel: string | null;
  paintType: string | null;
  coats: number;
  quantity: number;
  unit: string;
  productionRate: number;
  laborHours: number;
  materialCost: number;
  laborCost: number;
}

function escapeCsv(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  const bid = await db.bidVersion.findFirst({
    where: { projectId },
    orderBy: { versionNumber: "desc" },
  });
  if (!bid) {
    return NextResponse.json(
      { error: "No bid yet. Click Generate Bid first." },
      { status: 404 },
    );
  }
  const lineItems = JSON.parse(bid.lineItems) as CsvLineItem[];
  const project = await db.project.findUnique({ where: { id: projectId } });

  const header = [
    "Room",
    "Type",
    "Paint",
    "Coats",
    "Quantity",
    "Unit",
    "Production rate",
    "Labor hours",
    "Material cost",
    "Labor cost",
  ];
  const rows = lineItems.map((li) =>
    [
      li.roomLabel,
      li.type,
      li.paintType,
      li.coats,
      Math.round(li.quantity),
      li.unit,
      li.productionRate.toFixed(2),
      li.laborHours.toFixed(2),
      li.materialCost.toFixed(2),
      li.laborCost.toFixed(2),
    ].map(escapeCsv).join(","),
  );

  const csv = [header.join(","), ...rows, "", `Subtotal,,,,,,,,${bid.totalMaterial.toFixed(2)},${bid.totalLabor.toFixed(2)}`, `Overhead,,,,,,,,,${bid.totalOverhead.toFixed(2)}`, `Markup,,,,,,,,,${bid.totalMarkup.toFixed(2)}`, `Grand total,,,,,,,,,${bid.grandTotal.toFixed(2)}`].join("\n");

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${(project?.name ?? "bid").replace(/[^a-zA-Z0-9._-]/g, "_")}-line-items.csv"`,
    },
  });
}
