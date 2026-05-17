import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

interface ExcelLineItem {
  surfaceId: string;
  type: string;
  roomLabel: string | null;
  paintType: string | null;
  coats: number;
  quantity: number;
  unit: string;
  productionRate: number;
  laborHours: number;
  laborCost: number;
  gallons: number;
  materialCost: number;
}

/**
 * Export the latest bid as a multi-sheet XLSX:
 *   Sheet 1 — Summary (totals + bid metadata)
 *   Sheet 2 — Line items (every surface with quantity, labor, material)
 *   Sheet 3 — Room schedule (by room with totals)
 *   Sheet 4 — Symbol counts (all detected symbols with per-room breakdown)
 *
 * Painters use Excel for owner submittals; CSV doesn't carry formatting
 * and most municipal bid portals require XLSX.
 */
export async function GET(
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
  const bid = await db.bidVersion.findFirst({
    where: { projectId },
    orderBy: { versionNumber: "desc" },
  });
  if (!bid) {
    return NextResponse.json(
      { error: "Generate a bid first." },
      { status: 400 },
    );
  }
  const lineItems = JSON.parse(bid.lineItems) as ExcelLineItem[];
  const symbols = await db.surface.findMany({
    where: { projectId, type: { startsWith: "symbol:" } },
  });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "PainterDesk";
  workbook.created = new Date();

  // ── Summary sheet ──────────────────────────────────────────────────
  const summary = workbook.addWorksheet("Summary");
  summary.columns = [
    { header: "Field", key: "field", width: 28 },
    { header: "Value", key: "value", width: 32 },
  ];
  summary.getRow(1).font = { bold: true };
  const summaryRows: Array<[string, string | number]> = [
    ["Project", project.name],
    ["Client", project.clientName ?? ""],
    ["Bid version", bid.versionNumber],
    ["Generated", bid.createdAt.toISOString().slice(0, 10)],
    ["", ""],
    ["Total material", bid.totalMaterial],
    ["Total labor", bid.totalLabor],
    ["Total overhead", bid.totalOverhead],
    ["Total markup", bid.totalMarkup],
    ["Grand total", bid.grandTotal],
    ["", ""],
    ["Measurement mode", project.measurementMode],
    ["Waste factor", project.wasteFactor],
    ["Markup", project.markup],
  ];
  for (const [field, value] of summaryRows) {
    summary.addRow({ field, value });
  }
  // Currency formatting on dollar rows.
  for (let r = 7; r <= 11; r++) {
    summary.getRow(r).getCell(2).numFmt = '"$"#,##0.00';
  }

  // ── Line items sheet ───────────────────────────────────────────────
  const lines = workbook.addWorksheet("Line items");
  lines.columns = [
    { header: "Room", key: "roomLabel", width: 24 },
    { header: "Type", key: "type", width: 12 },
    { header: "Paint", key: "paintType", width: 18 },
    { header: "Coats", key: "coats", width: 8 },
    { header: "Qty", key: "quantity", width: 10 },
    { header: "Unit", key: "unit", width: 6 },
    { header: "Prod rate", key: "productionRate", width: 10 },
    { header: "Labor hrs", key: "laborHours", width: 10 },
    { header: "Labor $", key: "laborCost", width: 12 },
    { header: "Gallons", key: "gallons", width: 10 },
    { header: "Material $", key: "materialCost", width: 12 },
  ];
  lines.getRow(1).font = { bold: true };
  for (const li of lineItems) {
    lines.addRow({
      roomLabel: li.roomLabel ?? "",
      type: li.type,
      paintType: li.paintType ?? "",
      coats: li.coats,
      quantity: li.quantity,
      unit: li.unit,
      productionRate: li.productionRate,
      laborHours: li.laborHours,
      laborCost: li.laborCost,
      gallons: li.gallons,
      materialCost: li.materialCost,
    });
  }
  lines.getColumn("laborCost").numFmt = '"$"#,##0.00';
  lines.getColumn("materialCost").numFmt = '"$"#,##0.00';
  lines.getColumn("laborHours").numFmt = '0.00';
  lines.getColumn("gallons").numFmt = '0.00';
  lines.getColumn("quantity").numFmt = '0.0';

  // ── Room schedule sheet ────────────────────────────────────────────
  const sched = workbook.addWorksheet("Room schedule");
  sched.columns = [
    { header: "Room", key: "roomLabel", width: 28 },
    { header: "Wall SF", key: "wallSqft", width: 12 },
    { header: "Wall LF", key: "wallLf", width: 12 },
    { header: "Ceiling SF", key: "ceilingSqft", width: 12 },
    { header: "Trim LF", key: "trimLf", width: 12 },
    { header: "Doors", key: "doors", width: 8 },
    { header: "Windows", key: "windows", width: 8 },
    { header: "Labor $", key: "laborCost", width: 12 },
    { header: "Material $", key: "materialCost", width: 12 },
    { header: "Total $", key: "totalCost", width: 12 },
  ];
  sched.getRow(1).font = { bold: true };
  const byRoom = new Map<
    string,
    {
      wallSqft: number;
      wallLf: number;
      ceilingSqft: number;
      trimLf: number;
      doors: number;
      windows: number;
      laborCost: number;
      materialCost: number;
    }
  >();
  for (const li of lineItems) {
    const k = li.roomLabel ?? "(no room)";
    const row = byRoom.get(k) ?? {
      wallSqft: 0,
      wallLf: 0,
      ceilingSqft: 0,
      trimLf: 0,
      doors: 0,
      windows: 0,
      laborCost: 0,
      materialCost: 0,
    };
    if (li.type === "wall") {
      row.wallSqft += li.quantity;
    } else if (li.type === "ceiling") {
      row.ceilingSqft += li.quantity;
    } else if (li.type === "trim") {
      row.trimLf += li.quantity;
    } else if (li.type === "door") {
      row.doors += li.quantity;
    } else if (li.type === "window") {
      row.windows += li.quantity;
    }
    row.laborCost += li.laborCost;
    row.materialCost += li.materialCost;
    byRoom.set(k, row);
  }
  for (const [roomLabel, r] of byRoom) {
    sched.addRow({
      roomLabel,
      wallSqft: r.wallSqft,
      wallLf: r.wallLf,
      ceilingSqft: r.ceilingSqft,
      trimLf: r.trimLf,
      doors: r.doors,
      windows: r.windows,
      laborCost: r.laborCost,
      materialCost: r.materialCost,
      totalCost: r.laborCost + r.materialCost,
    });
  }
  for (const col of ["laborCost", "materialCost", "totalCost"]) {
    sched.getColumn(col).numFmt = '"$"#,##0.00';
  }

  // ── Symbol counts sheet ────────────────────────────────────────────
  if (symbols.length > 0) {
    const sym = workbook.addWorksheet("Symbol counts");
    sym.columns = [
      { header: "Type", key: "type", width: 24 },
      { header: "Room", key: "roomLabel", width: 24 },
      { header: "Count", key: "count", width: 8 },
      { header: "Confidence", key: "confidence", width: 12 },
      { header: "Notes", key: "notes", width: 50 },
    ];
    sym.getRow(1).font = { bold: true };
    for (const s of symbols) {
      sym.addRow({
        type: s.type.replace(/^symbol:/, ""),
        roomLabel: s.roomLabel ?? "",
        count: s.count ?? 0,
        confidence: s.confidence,
        notes: s.notes ?? "",
      });
    }
    sym.getColumn("confidence").numFmt = "0.00";
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const filename = `${project.name.replace(/[^A-Za-z0-9-_]/g, "_")}-bid-v${bid.versionNumber}.xlsx`;
  return new NextResponse(buffer as ArrayBuffer, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
