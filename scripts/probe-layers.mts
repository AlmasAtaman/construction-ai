/**
 * Probe: does layer-filtered (OCG) vector scanning give clean wall takeoff
 * on the Beaver Tails commercial plan (friend-commercial-plan.pdf p5)?
 *
 * Compares: all layers (current pipeline input) vs wall layers only.
 */
import fs from "fs";
import * as mupdf from "mupdf";
import { buildWallGraph } from "../src/lib/extract/wall-graph";
import {
  autoTraceWalls,
  filterStrayPolylines,
} from "../src/lib/extract/wall-autotrace";

const PDF = "tests/fixtures/friend-commercial-plan.pdf";
const PAGE = 5;
const PT_PER_FOOT = 18;

type Seg = { x1: number; y1: number; x2: number; y2: number };

function scan(layerPred: ((name: string) => boolean) | null) {
  const doc = (mupdf as any).Document.openDocument(
    new Uint8Array(fs.readFileSync(PDF)),
    "application/pdf",
  );
  const n = doc.countLayers();
  for (let i = 0; i < n; i++)
    doc.setLayerVisible(i, layerPred ? layerPred(doc.getLayerName(i)) : true);
  const page = doc.loadPage(PAGE - 1);
  const walls: Seg[] = [];
  const diag: Seg[] = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  const tx = (ctm: number[], x: number, y: number): [number, number] => [
    ctm[0] * x + ctm[2] * y + ctm[4],
    ctm[1] * x + ctm[3] * y + ctm[5],
  ];
  function emit(x1: number, y1: number, x2: number, y2: number) {
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const len = Math.hypot(dx, dy);
    if (len < 5) return;
    if (dy < 1.5 && dx > 1.5) walls.push({ x1, y1, x2, y2: y1 });
    else if (dx < 1.5 && dy > 1.5) walls.push({ x1, y1, x2: x1, y2 });
    else if (len >= 50) diag.push({ x1, y1, x2, y2 });
  }
  function collect(p: any, ctm: number[]) {
    p.walk({
      moveTo: (x: number, y: number) => {
        [cx, cy] = tx(ctm, x, y);
        sx = cx;
        sy = cy;
      },
      lineTo: (x: number, y: number) => {
        const [nx, ny] = tx(ctm, x, y);
        emit(cx, cy, nx, ny);
        cx = nx;
        cy = ny;
      },
      curveTo: (_a: number, _b: number, _c: number, _d: number, ex: number, ey: number) => {
        [cx, cy] = tx(ctm, ex, ey);
      },
      closePath: () => {
        emit(cx, cy, sx, sy);
        cx = sx;
        cy = sy;
      },
    });
  }
  const device = new (mupdf as any).Device({
    fillPath: (p: any, _: any, ctm: number[]) => collect(p, ctm),
    strokePath: (p: any, _: any, ctm: number[]) => collect(p, ctm),
  });
  page.run(device, (mupdf as any).Matrix.identity);
  return { walls, diag };
}

function plen(polys: any[]): number {
  let t = 0;
  for (const p of polys)
    for (let i = 1; i < p.points.length; i++)
      t += Math.hypot(
        p.points[i].x - p.points[i - 1].x,
        p.points[i].y - p.points[i - 1].y,
      );
  return t / PT_PER_FOOT;
}

function measure(walls: Seg[], diag: Seg[]) {
  let raw = 0;
  for (const s of [...walls, ...diag]) raw += Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
  const graph = buildWallGraph([...walls, ...diag] as any);
  let graphLen = 0;
  for (const e of graph.edges)
    graphLen += Math.hypot(
      graph.vertices[e.p1].x - graph.vertices[e.p2].x,
      graph.vertices[e.p1].y - graph.vertices[e.p2].y,
    );
  const polysAll = autoTraceWalls(graph, { minPolylineLengthPt: PT_PER_FOOT });
  const res = filterStrayPolylines(graph, polysAll);
  return {
    rawLf: raw / PT_PER_FOOT,
    graphLf: graphLen / PT_PER_FOOT,
    tracedAll: polysAll.length,
    tracedAllLf: plen(polysAll),
    kept: res.kept.length,
    keptLf: plen(res.kept),
    droppedLf: plen(res.dropped),
  };
}

const cases: Array<[string, ((n: string) => boolean) | null]> = [
  ["ALL LAYERS (current pipeline)", null],
  ["FP-N-WALL + FP-N-HWALL (new walls)", (n) => /FP-N-H?WALL/.test(n)],
  ["FP new + existing walls", (n) => /FP-[NE]-H?WALL/.test(n)],
];

for (const [label, pred] of cases) {
  const { walls, diag } = scan(pred);
  const m = measure(walls, diag);
  console.log(
    `${label}\n  segments: ${walls.length + diag.length}  raw: ${m.rawLf.toFixed(0)} lf  graph: ${m.graphLf.toFixed(0)} lf\n  traced(prefilter): ${m.tracedAll} polys / ${m.tracedAllLf.toFixed(0)} lf  kept: ${m.kept} polys / ${m.keptLf.toFixed(0)} lf  dropped: ${m.droppedLf.toFixed(0)} lf\n`,
  );
}

// Per-component breakdown for new+existing walls, no stray filter:
{
  const { walls, diag } = scan((n) => /FP-[NE]-H?WALL/.test(n));
  const graph = buildWallGraph([...walls, ...diag] as any);
  // union-find components over edges
  const parent = graph.vertices.map((_: any, i: number) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const e of graph.edges) { const a = find(e.p1), b = find(e.p2); if (a !== b) parent[a] = b; }
  const comp: Record<number, { lf: number; y0: number; y1: number; x0: number; x1: number }> = {};
  for (const e of graph.edges) {
    const r = find(e.p1);
    const v1 = graph.vertices[e.p1], v2 = graph.vertices[e.p2];
    comp[r] ??= { lf: 0, y0: Infinity, y1: -Infinity, x0: Infinity, x1: -Infinity };
    comp[r].lf += Math.hypot(v1.x - v2.x, v1.y - v2.y) / PT_PER_FOOT;
    comp[r].y0 = Math.min(comp[r].y0, v1.y, v2.y); comp[r].y1 = Math.max(comp[r].y1, v1.y, v2.y);
    comp[r].x0 = Math.min(comp[r].x0, v1.x, v2.x); comp[r].x1 = Math.max(comp[r].x1, v1.x, v2.x);
  }
  const list = Object.values(comp).sort((a, b) => b.lf - a.lf);
  console.log("components (new+existing walls):");
  for (const c of list.slice(0, 12))
    console.log(`  lf=${c.lf.toFixed(0)}  y=[${c.y0.toFixed(0)}..${c.y1.toFixed(0)}]  x=[${c.x0.toFixed(0)}..${c.x1.toFixed(0)}]`);
  const mid = 1296; // page is 2592pt wide? print page height bands instead
  console.log("total:", list.reduce((s, c) => s + c.lf, 0).toFixed(0), "lf");
}
