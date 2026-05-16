import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pdfPath = path.resolve(
  __dirname,
  "../tests/fixtures/commercial-bench.pdf",
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

const ANNOTATION_NOT_ROOM =
  /^(column|columns|glass roof|roof|north|south|east|west|legend|notes?|key|symbols?|scale|true north|grid|datum|align|typ\.?|sim\.?|do not enter|exit|entry|elev\.?|fdn\.?|f\.d\.?|sect\.?|sect|stair|stairs|hold|hatch)$/i;
const TITLE_BLOCK_KEYWORD =
  /^(stamp|consultant|consultants?|architect|engineer|drawn|checked|approved|reviewed|sheet|drawing|project number|building number|location|issue date|revision|revisions?|description|date|date:|of record|finish plan general notes|general notes|no work|no work this area|finish plan|reflected ceiling plan|abbreviations?|room finish legend|abbreviation|construction documents?|prebid|addendum|revision set|first floor|second floor|third floor|saint cloud|st cloud|st\. cloud|key plan)$/i;
const DATE_PATTERN =
  /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}$/i;
const SHEET_CODE = /^(a|af|s|m|e|p|c|l|t)[a-z]?\d{2,4}[a-z]?$/i;
const MATERIAL_CODE =
  /^(p|pt|cpt|vct|wsf|cg|act|gwb|cmu|wb|gyp|hm|wd|mtl|sst|alm|gl)\s*-?\s*\d+([\s/-]?\d+)?$/i;
const SHORT_CODE = /^[A-Z]{1,2}$/;

const survivors = [];
for (const item of content.items) {
  const s = item.str?.trim();
  if (!s) continue;
  if (s.length < 2 || s.length > 40) continue;
  if (/^[\d'"\-.,×x\s]+$/.test(s)) continue;
  if (/^\d+$/.test(s)) continue;
  if (ANNOTATION_NOT_ROOM.test(s)) continue;
  if (MATERIAL_CODE.test(s)) continue;
  if (SHORT_CODE.test(s)) continue;
  if (TITLE_BLOCK_KEYWORD.test(s)) continue;
  if (DATE_PATTERN.test(s)) continue;
  if (SHEET_CODE.test(s)) continue;
  if (!/[A-Za-z]{2,}/.test(s)) continue;
  const tx = item.transform[4];
  const ty = item.transform[5];
  const h = item.height ?? 10;
  const cx = tx + (item.width ?? 0) / 2;
  const cy = viewport.height - (ty + h / 2);
  const xn = cx / viewport.width;
  const yn = cy / viewport.height;
  if (yn < 0.04 || yn > 0.97 || xn < 0.02 || xn > 0.98) continue;
  survivors.push({ s, xn, yn, fontPt: Math.abs(item.transform[3] ?? 10) });
}

// Sort by font size desc to see what would be sampled first.
survivors.sort((a, b) => b.fontPt - a.fontPt);
console.log(`${survivors.length} labels survived. Top 50 by font size:`);
for (const s of survivors.slice(0, 50)) {
  console.log(
    `  ${s.fontPt.toFixed(1)}pt  (${s.xn.toFixed(2)}, ${s.yn.toFixed(2)})  ${JSON.stringify(s.s)}`,
  );
}
