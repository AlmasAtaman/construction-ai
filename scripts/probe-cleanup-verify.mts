/**
 * Day 3 cleanup verification — focused counters for the two
 * specific concerns flagged in the Day 2 report:
 *
 *   - friend-commercial-plan.pdf page 9: parallel 45° hatch clusters
 *     (24 raw segments at 40-50° on Day 1's probe). Cleanup should
 *     drop most/all of them.
 *
 *   - DP-BP-new-home-sample-drawings.pdf page 10: identical strokes
 *     drawn 4×. Cleanup should collapse duplicates 1:1.
 *
 * Also samples the architectural-diagonal page (commercial p15) so we
 * know real angled walls aren't being thrown out with the hatch.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildWallGraph,
  wallGraphSegments,
  type RawSegment,
} from "../src/lib/extract/wall-graph.js";

const DIAGONAL_WALL_MIN_PT = 50;

interface MupdfPath {
  walk: (h: Record<string, (...args: number[]) => void>) => void;
}

function txp(ctm: number[], x: number, y: number): [number, number] {
  return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
}

async function scanPage(
  mupdf: {
    Document: { openDocument: (b: Uint8Array, m: string) => unknown };
    Device: new (h: Record<string, unknown>) => unknown;
    Matrix: { identity: number[] };
  },
  doc: { loadPage: (i: number) => unknown },
  pageIndex: number,
): Promise<RawSegment[]> {
  const page = doc.loadPage(pageIndex) as {
    getBounds: () => number[];
    run: (d: unknown, m: number[]) => void;
  };
  const segs: RawSegment[] = [];
  function emit(x1: number, y1: number, x2: number, y2: number): void {
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const len = Math.hypot(dx, dy);
    if (len < 5) return;
    if (dy < 1.5 && dx > 1.5) segs.push({ x1, y1, x2, y2: y1 });
    else if (dx < 1.5 && dy > 1.5) segs.push({ x1, y1, x2: x1, y2 });
    else if (len >= 18 && len <= 45) {
      /* door swing — drop */
    } else if (len >= DIAGONAL_WALL_MIN_PT) segs.push({ x1, y1, x2, y2 });
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
        /* ignore */
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
  return segs;
}

function inAngleBand(s: RawSegment, lo: number, hi: number): boolean {
  const a = (Math.atan2(s.y2 - s.y1, s.x2 - s.x1) * 180) / Math.PI;
  const aMod = ((a % 180) + 180) % 180;
  return (
    (aMod >= lo && aMod <= hi) ||
    (180 - aMod >= lo && 180 - aMod <= hi)
  );
}

function countAt45ish(segs: RawSegment[]): number {
  return segs.filter((s) => inAngleBand(s, 40, 50)).length;
}

function duplicateRatio(segs: RawSegment[]): {
  total: number;
  unique: number;
  ratio: number;
} {
  const seen = new Map<string, number>();
  for (const s of segs) {
    const k =
      `${s.x1.toFixed(1)}|${s.y1.toFixed(1)}|` +
      `${s.x2.toFixed(1)}|${s.y2.toFixed(1)}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const total = segs.length;
  const unique = seen.size;
  return { total, unique, ratio: unique > 0 ? total / unique : 0 };
}

async function main(): Promise<void> {
  const mupdf = (await import("mupdf")) as unknown as {
    Document: { openDocument: (b: Uint8Array, m: string) => unknown };
    Device: new (h: Record<string, unknown>) => unknown;
    Matrix: { identity: number[] };
  };

  const reports: Array<{ file: string; page: number }> = [
    { file: "tests/fixtures/friend-commercial-plan.pdf", page: 9 },
    { file: "tests/fixtures/friend-commercial-plan.pdf", page: 15 },
    { file: "tests/fixtures/friend-commercial-plan.pdf", page: 18 },
    {
      file: "tests/fixtures/DP-BP-new-home-sample-drawings.pdf",
      page: 10,
    },
  ];

  for (const r of reports) {
    const buf = await readFile(path.join(process.cwd(), r.file));
    const doc = mupdf.Document.openDocument(
      new Uint8Array(buf),
      "application/pdf",
    ) as { loadPage: (i: number) => unknown };
    const raw = await scanPage(mupdf, doc, r.page - 1);
    const graph = buildWallGraph(raw);
    const cleaned = wallGraphSegments(graph);
    const rawDup = duplicateRatio(raw);
    const rawHatch = countAt45ish(raw);
    const cleanedHatch = countAt45ish(cleaned);
    console.log(`\n=== ${r.file} page ${r.page} ===`);
    console.log(
      `  raw segments: ${rawDup.total} total, ${rawDup.unique} unique (${rawDup.ratio.toFixed(2)}× duplication)`,
    );
    console.log(
      `  cleaned edges: ${cleaned.length} (vertices: ${graph.vertices.length})`,
    );
    console.log(
      `  ~45° band: raw ${rawHatch} → cleaned ${cleanedHatch}` +
        ` (${rawHatch > 0 ? Math.round((1 - cleanedHatch / rawHatch) * 100) : 0}% removed)`,
    );
  }
}

await main();
