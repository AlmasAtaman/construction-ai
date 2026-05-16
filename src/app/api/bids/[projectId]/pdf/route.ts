import { NextResponse } from "next/server";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";
import React from "react";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 10, fontFamily: "Helvetica" },
  header: { fontSize: 18, marginBottom: 8, fontWeight: 700 },
  subheader: { fontSize: 10, color: "#666", marginBottom: 16 },
  sectionTitle: { fontSize: 12, marginTop: 12, marginBottom: 6, fontWeight: 700 },
  row: { flexDirection: "row" },
  cell: { padding: 4 },
  headerRow: { backgroundColor: "#f0f0f0", borderBottom: "1pt solid #999" },
  itemRow: { borderBottom: "0.5pt solid #ddd" },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  grandTotal: {
    marginTop: 8,
    paddingTop: 6,
    borderTop: "1pt solid #000",
    fontSize: 14,
    fontWeight: 700,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  scopeBlock: { marginTop: 24, fontSize: 9, color: "#444" },
});

interface BidPdfProps {
  projectName: string;
  clientName: string | null;
  versionNumber: number;
  generatedAt: string;
  lineItems: {
    type: string;
    roomLabel: string | null;
    paintType: string | null;
    coats: number;
    quantity: number;
    unit: string;
    materialCost: number;
    laborCost: number;
  }[];
  totalMaterial: number;
  totalLabor: number;
  totalOverhead: number;
  totalMarkup: number;
  grandTotal: number;
  scopeNotes: string;
}

function fmt(v: number): string {
  return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function BidPdf(props: BidPdfProps) {
  return React.createElement(
    Document,
    null,
    React.createElement(
      Page,
      { size: "LETTER", style: styles.page },
      React.createElement(Text, { style: styles.header }, "Painting Proposal"),
      React.createElement(
        Text,
        { style: styles.subheader },
        `Project: ${props.projectName}${props.clientName ? ` — ${props.clientName}` : ""} • Version ${props.versionNumber} • ${props.generatedAt}`,
      ),

      React.createElement(Text, { style: styles.sectionTitle }, "Line items"),
      React.createElement(
        View,
        { style: [styles.row, styles.headerRow] },
        React.createElement(Text, { style: [styles.cell, { width: "20%" }] }, "Room"),
        React.createElement(Text, { style: [styles.cell, { width: "12%" }] }, "Type"),
        React.createElement(Text, { style: [styles.cell, { width: "22%" }] }, "Paint"),
        React.createElement(Text, { style: [styles.cell, { width: "8%", textAlign: "right" }] }, "Coats"),
        React.createElement(Text, { style: [styles.cell, { width: "12%", textAlign: "right" }] }, "Qty"),
        React.createElement(Text, { style: [styles.cell, { width: "13%", textAlign: "right" }] }, "Material"),
        React.createElement(Text, { style: [styles.cell, { width: "13%", textAlign: "right" }] }, "Labor"),
      ),
      ...props.lineItems.map((li, i) =>
        React.createElement(
          View,
          { key: i, style: [styles.row, styles.itemRow] },
          React.createElement(Text, { style: [styles.cell, { width: "20%" }] }, li.roomLabel ?? "—"),
          React.createElement(Text, { style: [styles.cell, { width: "12%" }] }, li.type),
          React.createElement(Text, { style: [styles.cell, { width: "22%" }] }, li.paintType ?? "—"),
          React.createElement(Text, { style: [styles.cell, { width: "8%", textAlign: "right" }] }, String(li.coats)),
          React.createElement(Text, { style: [styles.cell, { width: "12%", textAlign: "right" }] }, `${Math.round(li.quantity)} ${li.unit}`),
          React.createElement(Text, { style: [styles.cell, { width: "13%", textAlign: "right" }] }, fmt(li.materialCost)),
          React.createElement(Text, { style: [styles.cell, { width: "13%", textAlign: "right" }] }, fmt(li.laborCost)),
        ),
      ),

      React.createElement(Text, { style: styles.sectionTitle }, "Summary"),
      React.createElement(
        View,
        { style: styles.totalRow },
        React.createElement(Text, null, "Materials"),
        React.createElement(Text, null, fmt(props.totalMaterial)),
      ),
      React.createElement(
        View,
        { style: styles.totalRow },
        React.createElement(Text, null, "Labor"),
        React.createElement(Text, null, fmt(props.totalLabor)),
      ),
      React.createElement(
        View,
        { style: styles.totalRow },
        React.createElement(Text, null, "Overhead"),
        React.createElement(Text, null, fmt(props.totalOverhead)),
      ),
      React.createElement(
        View,
        { style: styles.totalRow },
        React.createElement(Text, null, "Markup"),
        React.createElement(Text, null, fmt(props.totalMarkup)),
      ),
      React.createElement(
        View,
        { style: styles.grandTotal },
        React.createElement(Text, null, "Grand Total"),
        React.createElement(Text, null, fmt(props.grandTotal)),
      ),

      React.createElement(
        Text,
        { style: styles.scopeBlock },
        props.scopeNotes,
      ),
    ),
  );
}

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
      { error: "No bid yet. Click Generate Bid first." },
      { status: 404 },
    );
  }

  const lineItems = JSON.parse(bid.lineItems);

  const scope = `Scope of work — Painting and surface preparation per PCA standards. All work performed by licensed commercial painting crews. Exclusions per P23 unless otherwise noted in the line items above.`;

  const buffer = await renderToBuffer(
    BidPdf({
      projectName: project.name,
      clientName: project.clientName,
      versionNumber: bid.versionNumber,
      generatedAt: bid.createdAt.toLocaleDateString("en-US"),
      lineItems,
      totalMaterial: bid.totalMaterial,
      totalLabor: bid.totalLabor,
      totalOverhead: bid.totalOverhead,
      totalMarkup: bid.totalMarkup,
      grandTotal: bid.grandTotal,
      scopeNotes: scope,
    }),
  );

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${project.name.replace(/[^a-zA-Z0-9._-]/g, "_")}-bid-v${bid.versionNumber}.pdf"`,
    },
  });
}
