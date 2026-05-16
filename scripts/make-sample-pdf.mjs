// Generate a minimal valid multi-page PDF for testing.
// No deps needed — writes raw PDF bytes.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function makePdf(pages) {
  const objects = [];
  const pageRefs = [];

  // Object 1: Catalog
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");

  // Object 2: Pages tree (placeholder, fill in after we know page refs)
  // We'll insert placeholder, then update.
  const pagesObjIndex = objects.length;
  objects.push(""); // placeholder

  // Font
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const fontObjNum = objects.length;

  // Per-page: content stream + page object
  for (let i = 0; i < pages.length; i++) {
    const text = pages[i];
    const contentStream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
    const content = `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`;
    objects.push(content);
    const contentObjNum = objects.length;

    const pageObj = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjNum} 0 R /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> >>`;
    objects.push(pageObj);
    pageRefs.push(objects.length);
  }

  // Now fill in the Pages object
  const kids = pageRefs.map((n) => `${n} 0 R`).join(" ");
  objects[pagesObjIndex] = `<< /Type /Pages /Kids [${kids}] /Count ${pageRefs.length} >>`;

  // Assemble PDF
  let pdf = "%PDF-1.4\n%\xff\xff\xff\xff\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const samplePlanPath = process.argv[2] || "tests/fixtures/sample-plan.pdf";
const sampleSpecsPath = process.argv[3] || "tests/fixtures/sample-specs.pdf";

mkdirSync(dirname(samplePlanPath), { recursive: true });
mkdirSync(dirname(sampleSpecsPath), { recursive: true });

writeFileSync(
  samplePlanPath,
  makePdf([
    "Sample Floor Plan - Page 1",
    "Sample Floor Plan - Page 2",
    "Sample Floor Plan - Page 3",
  ]),
);
writeFileSync(
  sampleSpecsPath,
  makePdf([
    "Sample Specifications - Section 09 90 00",
    "Sample Specifications - Page 2",
  ]),
);

console.log(`Wrote ${samplePlanPath} and ${sampleSpecsPath}`);
