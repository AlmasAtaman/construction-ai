/**
 * Step-3 bench. Runs the scale-aware measurement engine against the
 * three primary fixtures and prints, per page:
 *   - what scale was established + by which method
 *   - the per-room widthFt / heightFt / areaSqft / perimeterFt
 *   - the architect's printed table value where present, for an
 *     honest side-by-side accuracy view
 *
 * Run from repo root:
 *   npx tsx scripts/bench-scale-engine.mts
 *
 * Read-only. Does not touch the DB or write anywhere.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractPage } from "../src/lib/extract/page-extract.js";

const FIXTURES: {
  path: string;
  pages: number[] | "all";
  userScale?: { ptPerFoot: number; label: string };
  note?: string;
}[] = [
  {
    path: "tests/fixtures/benchmark-plan.pdf",
    pages: [1, 2, 3],
    note: "Residential, dim-table only, no scale notation.",
  },
  {
    path: "tests/fixtures/DP-BP-new-home-sample-drawings.pdf",
    pages: [9, 10, 11],
    note: "Real architectural blueprint, Main Floor Plan around page 10 (scale 3/16\"=1'-0\").",
  },
  {
    path: "tests/fixtures/commercial-bench.pdf",
    pages: [1, 3, 4, 5],
    note: "Commercial, has scale notation AND a graphic scale bar (4', 8', 16') — exercises both detectors.",
  },
  {
    path: "tests/fixtures/LOFT-Collection-OCT-16.pdf",
    pages: [3, 4, 5, 12, 24],
    note: "Marketing brochure: dense vector floor plan, NO scale, NO table — engine must emit `scale-needed`.",
  },
  {
    path: "tests/fixtures/LOFT-Collection-OCT-16.pdf",
    pages: [3, 4, 12],
    userScale: { ptPerFoot: 9, label: "1/8\" = 1'-0\" (simulated user calibration)" },
    note: "LOFT re-run with a hypothetical user scale (9 pt/ft = 1/8\":1') — verifies scale-needed → scale-measured plumbing.",
  },
];

function fmt(v: number | null | undefined, suffix = ""): string {
  if (v == null || !Number.isFinite(v)) return "  —  ";
  return `${v.toFixed(1)}${suffix}`;
}

function pct(a: number | null | undefined, b: number | null | undefined): string {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || b === 0) {
    return "    —";
  }
  const diff = ((a - b) / b) * 100;
  const sign = diff >= 0 ? "+" : "";
  return `${sign}${diff.toFixed(1)}%`;
}

async function benchOne(fixture: {
  path: string;
  pages: number[] | "all";
  userScale?: { ptPerFoot: number; label: string };
  note?: string;
}) {
  const buf = await readFile(path.join(process.cwd(), fixture.path));
  console.log(`\n================================================================`);
  console.log(`FIXTURE  ${fixture.path}`);
  if (fixture.note) console.log(`         ${fixture.note}`);
  if (fixture.userScale)
    console.log(
      `         USER SCALE: ${fixture.userScale.label} (${fixture.userScale.ptPerFoot} pt/ft)`,
    );
  console.log(`================================================================`);

  // Determine page list.
  let pageList: number[];
  if (fixture.pages === "all") {
    // Read page count via pdfjs.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise;
    pageList = Array.from({ length: doc.numPages }, (_, i) => i + 1);
  } else {
    pageList = fixture.pages;
  }

  for (const p of pageList) {
    try {
      const t0 = Date.now();
      const r = await extractPage(buf, p, {
        userScale: fixture.userScale ?? null,
      });
      const ms = Date.now() - t0;
      console.log(`\n--- page ${p} (${ms} ms) ---`);
      console.log(`  status:    ${r.status}${r.reason ? "  reason=" + r.reason : ""}`);
      console.log(`  strategy:  ${r.strategy}`);
      if (r.establishedScale) {
        console.log(
          `  SCALE:     ${r.establishedScale.label}   (method=${r.establishedScale.method}, ${r.establishedScale.ptPerFoot.toFixed(2)} pt/ft, conf=${(r.establishedScale.confidence * 100).toFixed(0)}%)`,
        );
        if (r.establishedScale.note) {
          console.log(`             ${r.establishedScale.note}`);
        }
      } else {
        console.log(
          `  SCALE:     <not established — scale-needed surfaces will be emitted>`,
        );
      }
      console.log(
        `  diagnostics: walls=${r.diagnostics.wallSegmentCount} faces=${r.diagnostics.planarFaceCount} dimRows=${r.diagnostics.dimRowCount} labels=${r.diagnostics.roomLikeLabelCount}`,
      );
      if (r.rooms.length === 0) {
        console.log(`  rooms:     (none)`);
        continue;
      }
      console.log(
        `  ${"room".padEnd(28)} ${"derivation".padEnd(22)} ${"W ft".padEnd(7)} ${"H ft".padEnd(7)} ${"area sqft".padEnd(11)} ${"perim ft".padEnd(10)} table-cmp`,
      );
      for (const room of r.rooms) {
        const tableAreaSqft =
          room.tableAreaSqft ??
          (room.tableWidthFt != null && room.tableHeightFt != null
            ? room.tableWidthFt * room.tableHeightFt
            : null);
        const cmp = tableAreaSqft != null && room.areaSqft != null
          ? `area Δ ${pct(room.areaSqft, tableAreaSqft)}`
          : tableAreaSqft != null
            ? `table=${tableAreaSqft.toFixed(1)} sqft`
            : "";
        console.log(
          `  ${(room.label || "(unlabeled)").padEnd(28).slice(0, 28)} ` +
            `${room.derivation.padEnd(22)} ` +
            `${fmt(room.widthFt).padEnd(7)} ${fmt(room.heightFt).padEnd(7)} ` +
            `${fmt(room.areaSqft).padEnd(11)} ${fmt(room.perimeterFt).padEnd(10)} ${cmp}`,
        );
        if (room.measurementWarning) {
          console.log(`    ⚠ ${room.measurementWarning}`);
        }
      }
    } catch (e) {
      console.error(
        `  page ${p}: extract failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
}

for (const f of FIXTURES) {
  try {
    await benchOne(f);
  } catch (e) {
    console.error(`fixture ${f.path}: ${e instanceof Error ? e.stack : e}`);
  }
}
