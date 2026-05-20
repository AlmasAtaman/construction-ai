/**
 * Day 5 visual check — render the commercial wall plan (page 5) with
 * the auto-trace polylines overlaid, so we can confirm with our eyes:
 *   - which segments were captured
 *   - whether the wall-graph put vertices at junctions
 *   - whether the auto-trace walks runs sensibly
 *   - what happens at the east-end casework / any angled feature
 *
 * Overlays cleaned wall edges (faint gray), auto-trace polylines (each
 * a distinct color), and graph vertices (small red dots). Writes a
 * full-page PNG and an east-end crop.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  buildWallGraph,
  wallGraphSegments,
  type RawSegment,
} from "../src/lib/extract/wall-graph.js";
import {
  autoTraceWalls,
  filterStrayPolylines,
  type TracedPolyline,
} from "../src/lib/extract/wall-autotrace.js";

const DIAGONAL_WALL_MIN_PT = 50;
const OUT = "/tmp/friend-candidates";
await mkdir(OUT, { recursive: true });

interface MupdfPath {
  walk: (h: Record<string, (...args: number[]) => void>) => void;
}

function txp(ctm: number[], x: number, y: number): [number, number] {
  return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
}

const PALETTE = [
  "#e6194b",
  "#3cb44b",
  "#4363d8",
  "#f58231",
  "#911eb4",
  "#46f0f0",
  "#f032e6",
  "#bcf60c",
  "#fabebe",
  "#008080",
  "#9a6324",
  "#800000",
  "#808000",
  "#000075",
];

async function main(): Promise<void> {
  const file = process.argv[2] ?? "tests/fixtures/friend-commercial-plan.pdf";
  const page1 = parseInt(process.argv[3] ?? "5", 10);
  const scale = parseFloat(process.argv[4] ?? "2");

  const buf = await readFile(path.join(process.cwd(), file));
  const mupdf = (await import("mupdf")) as unknown as {
    Document: { openDocument: (b: Uint8Array, m: string) => unknown };
    Device: new (h: Record<string, unknown>) => unknown;
    Matrix: { identity: number[] };
  };
  const doc = mupdf.Document.openDocument(
    new Uint8Array(buf),
    "application/pdf",
  ) as { loadPage: (i: number) => unknown };
  const page = doc.loadPage(page1 - 1) as {
    getBounds: () => number[];
    run: (d: unknown, m: number[]) => void;
    toPixmap: (m: number[], cs: unknown) => { asPNG: () => Buffer; getWidth: () => number; getHeight: () => number };
  };
  const bounds = page.getBounds();
  const pageWidthPt = bounds[2] - bounds[0];
  const pageHeightPt = bounds[3] - bounds[1];

  // Extract walls (same emit logic as page-extract).
  const axial: RawSegment[] = [];
  const diagonal: RawSegment[] = [];
  function emit(x1: number, y1: number, x2: number, y2: number): void {
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const len = Math.hypot(dx, dy);
    if (len < 5) return;
    if (dy < 1.5 && dx > 1.5) axial.push({ x1, y1, x2, y2: y1 });
    else if (dx < 1.5 && dy > 1.5) axial.push({ x1, y1, x2: x1, y2 });
    else if (len >= 18 && len <= 45) {
      /* door swing */
    } else if (len >= DIAGONAL_WALL_MIN_PT) diagonal.push({ x1, y1, x2, y2 });
  }
  function collect(p: MupdfPath, ctm: number[]): void {
    let cx = 0,
      cy = 0,
      sx = 0,
      sy = 0;
    p.walk({
      moveTo: (x: number, y: number) => {
        [cx, cy] = txp(ctm, x, y);
        sx = cx;
        sy = cy;
      },
      lineTo: (x: number, y: number) => {
        const [nx, ny] = txp(ctm, x, y);
        emit(cx, cy, nx, ny);
        cx = nx;
        cy = ny;
      },
      curveTo: () => {},
      closePath: () => {
        emit(cx, cy, sx, sy);
        cx = sx;
        cy = sy;
      },
    });
  }
  const device = new mupdf.Device({
    fillPath: (p: MupdfPath, _: unknown, ctm: number[]) => collect(p, ctm),
    strokePath: (p: MupdfPath, _: unknown, ctm: number[]) => collect(p, ctm),
  });
  page.run(device, mupdf.Matrix.identity);

  const raw: RawSegment[] = [...axial, ...diagonal];
  const graph = buildWallGraph(raw);
  const cleaned = wallGraphSegments(graph);
  const allPolylines = autoTraceWalls(graph);
  const { kept, dropped, planRegion } = filterStrayPolylines(graph, allPolylines);

  console.log(`page ${page1}: ${pageWidthPt.toFixed(0)}×${pageHeightPt.toFixed(0)}pt`);
  console.log(`  raw ${raw.length} (${axial.length} axial + ${diagonal.length} diag)`);
  console.log(`  cleaned ${cleaned.length} edges, ${graph.vertices.length} vertices`);
  console.log(`  auto-trace ${allPolylines.length} polylines (before filter)`);
  console.log(`  stray filter: kept ${kept.length}, dropped ${dropped.length}`);
  const totalBefore = allPolylines.reduce((s, p) => s + p.lengthPt, 0);
  const totalAfter = kept.reduce((s, p) => s + p.lengthPt, 0);
  console.log(
    `  total length: ${totalBefore.toFixed(0)} pt before → ${totalAfter.toFixed(0)} pt after`,
  );

  // Render the page.
  const pix = page.toPixmap(
    [scale, 0, 0, scale, 0, 0],
    (mupdf as unknown as { ColorSpace: { DeviceRGB: unknown } }).ColorSpace
      .DeviceRGB,
  );
  const W = pix.getWidth();
  const H = pix.getHeight();
  const pngBuf = pix.asPNG();

  // PDF pt (y-up) → image px (y-down). The page renders right-side up,
  // so a PDF y maps to image (H - y*scale)... but mupdf's pixmap is
  // already in device space at this matrix, meaning PDF (0,0) is the
  // image's bottom-left. Convert with the y-flip.
  const px = (x: number) => x * scale;
  const py = (y: number) => H - y * scale;

  function svgFor(polys: TracedPolyline[], showRegion: boolean): string {
    const parts: string[] = [];
    for (const s of cleaned) {
      parts.push(
        `<line x1="${px(s.x1).toFixed(1)}" y1="${py(s.y1).toFixed(1)}" x2="${px(s.x2).toFixed(1)}" y2="${py(s.y2).toFixed(1)}" stroke="#999" stroke-width="1" opacity="0.4"/>`,
      );
    }
    if (showRegion) {
      const rx = px(planRegion.x0);
      const ry = py(planRegion.y1); // y1 is top in pt → smaller image-y
      const rw = (planRegion.x1 - planRegion.x0) * scale;
      const rh = (planRegion.y1 - planRegion.y0) * scale;
      parts.push(
        `<rect x="${rx.toFixed(1)}" y="${ry.toFixed(1)}" width="${rw.toFixed(1)}" height="${rh.toFixed(1)}" fill="none" stroke="#0a0" stroke-width="2" stroke-dasharray="8 6" opacity="0.7"/>`,
      );
    }
    polys.forEach((pl, i) => {
      const color = PALETTE[i % PALETTE.length];
      const pts = pl.points
        .map((p) => `${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`)
        .join(" ");
      parts.push(
        `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="3" opacity="0.85"/>`,
      );
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join("")}</svg>`;
  }

  // BEFORE — all polylines + plan region box.
  await sharp(pngBuf)
    .composite([{ input: Buffer.from(svgFor(allPolylines, true)), top: 0, left: 0 }])
    .toFile(`${OUT}/autotrace-p${page1}-before.png`);
  // AFTER — kept polylines only.
  await sharp(pngBuf)
    .composite([{ input: Buffer.from(svgFor(kept, false)), top: 0, left: 0 }])
    .toFile(`${OUT}/autotrace-p${page1}-after.png`);
  console.log(`  wrote autotrace-p${page1}-{before,after}.png (${W}×${H})`);
}

await main();
