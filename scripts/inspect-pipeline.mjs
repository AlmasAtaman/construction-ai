import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pdfPath = path.resolve(
  __dirname,
  "../tests/fixtures/benchmark-plan.pdf",
);
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const data = readFileSync(pdfPath);
const doc = await pdfjs.getDocument({
  data: new Uint8Array(data),
  useWorkerFetch: false,
  isEvalSupported: false,
  useSystemFonts: true,
}).promise;
const page = await doc.getPage(1);
const viewport = page.getViewport({ scale: 1 });
const content = await page.getTextContent();

const fragments = [];
for (const item of content.items) {
  const s = item.str?.trim();
  if (!s) continue;
  const tx = item.transform[4];
  const ty = item.transform[5];
  const h = item.height ?? Math.abs(item.transform[3] ?? 10);
  const cx = tx + (item.width ?? 0) / 2;
  const cy = viewport.height - (ty + h / 2);
  fragments.push({
    text: s,
    xNorm: cx / viewport.width,
    yNorm: cy / viewport.height,
    fontSizePt: Math.abs(item.transform[3] ?? 10),
  });
}

const QSINGLE = "[\\u0027\\u2018\\u2019\\u2032]";
const QDOUBLE = "[\\u0022\\u201C\\u201D\\u2033]";
const DIM_RE = new RegExp(
  `^(\\d{1,3})\\s*${QSINGLE}\\s*(\\d{1,2})?\\s*${QDOUBLE}?\\s*[xX\\u00D7]\\s*(\\d{1,3})\\s*${QSINGLE}\\s*(\\d{1,2})?\\s*${QDOUBLE}?$`,
);
const SIMPLE_RE = /^(\d{1,3}(?:\.\d+)?)\s*[xX×]\s*(\d{1,3}(?:\.\d+)?)$/;

const dims = [];
for (const f of fragments) {
  const txt = f.text.replace(/\s+/g, "");
  const m = DIM_RE.exec(txt);
  if (m) {
    const w = parseInt(m[1], 10) + (parseInt(m[2] ?? "0", 10) || 0) / 12;
    const h = parseInt(m[3], 10) + (parseInt(m[4] ?? "0", 10) || 0) / 12;
    if (w > 0 && h > 0 && w < 200 && h < 200) {
      dims.push({ f, w, h, source: "DIM_RE" });
      continue;
    }
  }
  const m2 = SIMPLE_RE.exec(txt);
  if (m2) {
    dims.push({
      f,
      w: parseFloat(m2[1]),
      h: parseFloat(m2[2]),
      source: "SIMPLE_RE",
    });
  }
}

console.log("--- DIM MATCHES ---");
for (const d of dims) {
  console.log(
    `  (${d.f.xNorm.toFixed(3)}, ${d.f.yNorm.toFixed(3)}) ${d.source}: ${JSON.stringify(d.f.text)} → ${d.w} × ${d.h}`,
  );
}

console.log("\n--- TABLE ROWS ---");
const rowHeight = 0.012;
for (const d of dims) {
  const left = fragments.filter(
    (g) =>
      g !== d.f &&
      Math.abs(g.yNorm - d.f.yNorm) < rowHeight &&
      g.xNorm < d.f.xNorm &&
      !DIM_RE.test(g.text.trim()) &&
      !SIMPLE_RE.test(g.text.trim()),
  );
  left.sort((a, b) => b.xNorm - a.xNorm);
  const label = left[0]?.text?.trim() ?? "(no label)";
  console.log(
    `  Y=${d.f.yNorm.toFixed(3)} dim=${d.w}×${d.h}  closest-left=${JSON.stringify(label)} (n=${left.length})`,
  );
}
