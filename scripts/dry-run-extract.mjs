// Dry-run page-extract over both fixtures and print a per-page report.
// READ-ONLY (no DB writes, no rendering).

import { readFile } from "node:fs/promises";
import path from "node:path";
// Compile-on-demand .ts via tsx — run this with `npx tsx --tsconfig …`
// Importer below works because tsx is registered via the CLI shim.
const { extractPage } = await import("../src/lib/extract/page-extract.ts");

const FILES = [
  "tests/fixtures/benchmark-plan.pdf",
  "tests/fixtures/LOFT-Collection-OCT-16.pdf",
];

const root = process.cwd();

for (const file of FILES) {
  const buf = await readFile(path.join(root, file));
  // Get page count first.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  const pageCount = doc.numPages;

  console.log(`\n=== ${file} === pages=${pageCount}`);

  let okPages = 0;
  let skippedPages = 0;
  const byStrategy = { table: 0, vector: 0, none: 0 };
  const bySkipReason = { no_text_layer: 0, non_floor_plan: 0, low_geometry: 0 };

  for (let p = 1; p <= pageCount; p++) {
    const r = await extractPage(buf, p);
    if (r.status === "ok") okPages++;
    else skippedPages++;
    byStrategy[r.strategy]++;
    if (r.reason) bySkipReason[r.reason]++;

    const tracedCount = r.rooms.filter((x) => x.derivation === "traced").length;
    const sizedCount = r.rooms.filter((x) => x.derivation === "sized-from-dimensions").length;
    const tableOnlyCount = r.rooms.filter((x) => x.derivation === "table-only").length;
    const d = r.diagnostics;
    const skipTag = r.status === "skipped" ? `SKIP[${r.reason}]` : `OK[${r.strategy}]`;
    console.log(
      `  p${p.toString().padStart(2)}: ${skipTag.padEnd(22)} ` +
      `rooms=${r.rooms.length.toString().padStart(2)} ` +
      `(traced=${tracedCount} sized=${sizedCount} table-only=${tableOnlyCount}) ` +
      `[text=${d.textFragmentCount} ops=${d.vectorPathOpCount} walls=${d.wallSegmentCount} faces=${d.planarFaceCount} ptPerFt=${d.ptPerFt?.toFixed(2) ?? "—"}] ${d.elapsedMs}ms`,
    );
    if (r.rooms.length > 0 && r.rooms.length <= 14) {
      for (const room of r.rooms) {
        const poly = room.polygonNorm;
        let summary = "no-marker";
        if (poly.length >= 3) {
          let xMin = 1, yMin = 1, xMax = 0, yMax = 0;
          for (const pt of poly) {
            if (pt.x < xMin) xMin = pt.x;
            if (pt.y < yMin) yMin = pt.y;
            if (pt.x > xMax) xMax = pt.x;
            if (pt.y > yMax) yMax = pt.y;
          }
          summary = `box=[${xMin.toFixed(2)},${yMin.toFixed(2)}→${xMax.toFixed(2)},${yMax.toFixed(2)}]`;
        }
        const sz = room.widthFt && room.heightFt
          ? ` ${room.widthFt}'×${room.heightFt}'`
          : "";
        console.log(
          `       · "${room.label}"${sz} [${room.derivation}] ${summary}`,
        );
      }
    }
  }

  console.log(
    `  summary: ok=${okPages} skipped=${skippedPages}  ` +
    `strategies={table:${byStrategy.table}, vector:${byStrategy.vector}, none:${byStrategy.none}}  ` +
    `skip-reasons=${JSON.stringify(bySkipReason)}`,
  );
}
