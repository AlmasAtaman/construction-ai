/**
 * Day 2 verification probe — feeds the same raw segments the page
 * extractor emits into buildWallGraph and reports the cleanup result.
 *
 * Specifically watches:
 *   - Commercial page 9: parallel 45° hatch clusters (should be
 *     dropped by component pruning since hatch lines don't connect to
 *     the main wall network).
 *   - DP-BP page 10: identical strokes drawn 4x (should collapse via
 *     mergeCollinear and the half-edge edge-key dedup).
 *   - Commercial pages with clear architectural diagonals (15, 18):
 *     real 45°/-45° clusters should SURVIVE.
 *
 * Reports raw/cleaned segment counts, total length, and a small
 * sample of surviving edges per probed page.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildWallGraph,
  wallGraphSegments,
  wallGraphTotalLengthPt,
  type RawSegment,
} from "../src/lib/extract/wall-graph.js";

const DIAGONAL_WALL_MIN_PT = 50;

const TARGETS: Array<{ file: string; pages: number[] }> = [
  {
    file: "tests/fixtures/friend-commercial-plan.pdf",
    pages: [1, 9, 15, 18, 22, 31],
  },
  {
    file: "tests/fixtures/DP-BP-new-home-sample-drawings.pdf",
    pages: [10, 11, 16],
  },
];

interface MupdfMod {
  Document: { openDocument: (data: Uint8Array, mime: string) => MupdfDoc };
  Device: new (handlers: Record<string, unknown>) => unknown;
  Matrix: { identity: number[] };
}
interface MupdfDoc {
  loadPage: (i: number) => MupdfPage;
  countPages: () => number;
}
interface MupdfPage {
  getBounds: () => number[];
  run: (device: unknown, matrix: number[]) => void;
}
interface MupdfPath {
  walk: (h: Record<string, (...args: number[]) => void>) => void;
}

function txp(ctm: number[], x: number, y: number): [number, number] {
  return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
}

interface ScanOut {
  axial: RawSegment[];
  diagonal: RawSegment[];
}

async function scanPage(
  mupdf: MupdfMod,
  doc: MupdfDoc,
  pageIndex: number,
): Promise<{ width: number; height: number; scan: ScanOut }> {
  const page = doc.loadPage(pageIndex);
  const b = page.getBounds();
  const width = b[2] - b[0];
  const height = b[3] - b[1];
  const scan: ScanOut = { axial: [], diagonal: [] };
  function emit(x1: number, y1: number, x2: number, y2: number): void {
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const len = Math.hypot(dx, dy);
    if (len < 5) return;
    if (dy < 1.5 && dx > 1.5) {
      scan.axial.push({ x1, y1, x2, y2: y1 });
    } else if (dx < 1.5 && dy > 1.5) {
      scan.axial.push({ x1, y1, x2: x1, y2 });
    } else if (len >= 18 && len <= 45) {
      // door swing — drop
    } else if (len >= DIAGONAL_WALL_MIN_PT) {
      scan.diagonal.push({ x1, y1, x2, y2 });
    }
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
      curveTo: () => {
        /* ignore — door arcs not relevant here */
      },
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
  return { width, height, scan };
}

function angle(s: RawSegment): number {
  return Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
}

function topAngleHistogram(
  segs: RawSegment[],
  bucketDeg: number,
): Array<{ deg: number; count: number }> {
  const buckets = new Map<number, number>();
  for (const s of segs) {
    const a = ((Math.abs(angle(s)) * 180) / Math.PI) % 180;
    const bk = Math.round(a / bucketDeg) * bucketDeg;
    buckets.set(bk, (buckets.get(bk) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .map(([deg, count]) => ({ deg, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

async function probe(file: string, pages: number[]): Promise<void> {
  const buf = await readFile(path.join(process.cwd(), file));
  console.log(`\n=== ${file} ===`);
  const mupdf = (await import("mupdf")) as unknown as MupdfMod;
  const doc = mupdf.Document.openDocument(
    new Uint8Array(buf),
    "application/pdf",
  );
  for (const p of pages) {
    const { width, height, scan } = await scanPage(mupdf, doc, p - 1);
    const all: RawSegment[] = [...scan.axial, ...scan.diagonal];
    const t0 = Date.now();
    const graph = buildWallGraph(all);
    const ms = Date.now() - t0;
    const cleanedSegs = wallGraphSegments(graph);
    const totalPt = wallGraphTotalLengthPt(graph);
    const rawAxialAngles = topAngleHistogram(scan.axial, 5);
    const rawDiagAngles = topAngleHistogram(scan.diagonal, 5);
    const cleanedAngles = topAngleHistogram(cleanedSegs, 5);

    console.log(
      `\n  -- page ${p}  (${width.toFixed(0)}×${height.toFixed(0)}pt, ${ms}ms) --`,
    );
    console.log(
      `    raw: ${scan.axial.length} axial + ${scan.diagonal.length} diagonal = ${all.length} segments`,
    );
    console.log(
      `    cleaned: ${graph.vertices.length} vertices, ${graph.edges.length} edges, total ${totalPt.toFixed(0)} pt`,
    );
    console.log(
      `    raw axial angles: ${rawAxialAngles.map((a) => `${a.deg}°×${a.count}`).join(", ")}`,
    );
    console.log(
      `    raw diag angles:  ${rawDiagAngles.map((a) => `${a.deg}°×${a.count}`).join(", ")}`,
    );
    console.log(
      `    cleaned angles:   ${cleanedAngles.map((a) => `${a.deg}°×${a.count}`).join(", ")}`,
    );

    // Count surviving cleaned edges that are non-axial (>= 3° off
    // horizontal/vertical). This is the diagnostic for "did
    // architectural diagonals survive the cleanup?"
    const diagSurvivors = cleanedSegs.filter((s) => {
      const a = ((Math.abs(angle(s)) * 180) / Math.PI) % 180;
      const offH = Math.min(a, 180 - a);
      const offV = Math.abs(a - 90);
      return offH > 3 && offV > 3;
    });
    if (diagSurvivors.length > 0) {
      console.log(
        `    diagonal survivors: ${diagSurvivors.length} edges (sample below)`,
      );
      for (const s of diagSurvivors.slice(0, 6)) {
        const a = ((angle(s) * 180) / Math.PI).toFixed(1);
        const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1).toFixed(1);
        console.log(
          `      (${s.x1.toFixed(1)},${s.y1.toFixed(1)}) → (${s.x2.toFixed(1)},${s.y2.toFixed(1)})  len=${len} angle=${a}°`,
        );
      }
    } else {
      console.log(`    diagonal survivors: 0`);
    }
  }
}

for (const t of TARGETS) {
  await probe(t.file, t.pages);
}
