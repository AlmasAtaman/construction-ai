/**
 * Probe: does the Roboflow hosted wall-segmentation model actually work on
 * OUR plans, and how good is it? Renders a page to JPEG, sends it to the
 * serverless instance-segmentation endpoint, prints what classes/polygons
 * come back, and overlays the detected WALL polygons on the page so we can
 * judge real accuracy (vendor benchmarks are on clean datasets; our
 * commercial sheet is the hard case).
 *
 * Run: npx tsx --env-file=.env.local scripts/probe-roboflow.mts [file] [page] [model/version]
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const FILE = process.argv[2] ?? "tests/fixtures/friend-commercial-plan.pdf";
const PAGE = parseInt(process.argv[3] ?? "5", 10);
const MODEL = process.argv[4] ?? "floor-plan-nnoub-bk4vn-czy3i/1";
const OUT = "/tmp/roboflow";
await mkdir(OUT, { recursive: true });

const apiKey = process.env.ROBOFLOW_API_KEY;
if (!apiKey) {
  console.error("ROBOFLOW_API_KEY missing — run with --env-file=.env.local");
  process.exit(1);
}

// --- render page to a moderate-size JPEG (longest edge ~1500px) ---
const buf = await readFile(path.join(process.cwd(), FILE));
const mupdf = (await import("mupdf")) as unknown as {
  Document: { openDocument: (b: Uint8Array, m: string) => unknown };
  Matrix: { identity: number[] };
  ColorSpace: { DeviceRGB: unknown };
};
const doc = mupdf.Document.openDocument(new Uint8Array(buf), "application/pdf") as {
  loadPage: (i: number) => unknown;
};
const page = doc.loadPage(PAGE - 1) as {
  getBounds: () => number[];
  toPixmap: (m: number[], cs: unknown) => { asPNG: () => Buffer };
};
const b = page.getBounds();
const Wpt = b[2] - b[0];
const Hpt = b[3] - b[1];
const scale = 1500 / Math.max(Wpt, Hpt);
const pix = page.toPixmap([scale, 0, 0, scale, 0, 0], mupdf.ColorSpace.DeviceRGB);
const pngBuf = Buffer.from(pix.asPNG());
const jpeg = await sharp(pngBuf).jpeg({ quality: 85 }).toBuffer();
const imgW = Math.round(Wpt * scale);
const imgH = Math.round(Hpt * scale);
console.log(`\n=== ${FILE} p${PAGE} → ${imgW}×${imgH}px to Roboflow model ${MODEL} ===`);

// --- call Roboflow serverless inference ---
const url = `https://serverless.roboflow.com/${MODEL}?api_key=${apiKey}`;
const t0 = Date.now();
const resp = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: jpeg.toString("base64"),
});
if (!resp.ok) {
  console.error(`HTTP ${resp.status}: ${await resp.text()}`);
  process.exit(1);
}
interface Pred {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  class: string;
  points?: { x: number; y: number }[];
}
const json = (await resp.json()) as {
  predictions?: Pred[];
  image?: { width: number; height: number };
};
const preds = json.predictions ?? [];
console.log(`response in ${((Date.now() - t0) / 1000).toFixed(1)}s; image ${json.image?.width}×${json.image?.height}; predictions: ${preds.length}`);
const byClass = new Map<string, number>();
for (const p of preds) byClass.set(p.class, (byClass.get(p.class) ?? 0) + 1);
console.log(`classes: ${[...byClass.entries()].map(([c, n]) => `${c}=${n}`).join(", ")}`);
const walls = preds.filter((p) => p.class.toLowerCase().includes("wall"));
console.log(`wall predictions: ${walls.length}; have polygons: ${walls.filter((w) => w.points && w.points.length > 2).length}`);

await writeFile(`${OUT}/p${PAGE}-raw.json`, JSON.stringify(json, null, 2));

// Roboflow returns coords in the dimensions of the image it processed.
const rW = json.image?.width ?? imgW;
const rH = json.image?.height ?? imgH;
const sx = imgW / rW;
const sy = imgH / rH;

const parts: string[] = [];
for (const p of preds) {
  const isWall = p.class.toLowerCase().includes("wall");
  const color = isWall ? "#e6194b" : "#3b82f6";
  if (p.points && p.points.length > 2) {
    const pts = p.points.map((q) => `${(q.x * sx).toFixed(1)},${(q.y * sy).toFixed(1)}`).join(" ");
    parts.push(`<polygon points="${pts}" fill="${color}" fill-opacity="${isWall ? 0.25 : 0.08}" stroke="${color}" stroke-width="2"/>`);
  } else {
    const x = (p.x - p.width / 2) * sx;
    const y = (p.y - p.height / 2) * sy;
    parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(p.width * sx).toFixed(1)}" height="${(p.height * sy).toFixed(1)}" fill="none" stroke="${color}" stroke-width="2"/>`);
  }
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${imgW}" height="${imgH}">${parts.join("")}</svg>`;
await sharp(jpeg).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).toFile(`${OUT}/p${PAGE}-overlay.png`);
console.log(`wrote ${OUT}/p${PAGE}-overlay.png and p${PAGE}-raw.json`);
