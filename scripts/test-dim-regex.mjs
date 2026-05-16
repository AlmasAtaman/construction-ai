const QSINGLE = "[\\u0027\\u2018\\u2019\\u2032]";
const QDOUBLE = "[\\u0022\\u201C\\u201D\\u2033]";
const DIM_RE = new RegExp(
  `^(\\d{1,3})\\s*${QSINGLE}\\s*(\\d{1,2})?\\s*${QDOUBLE}?\\s*[xX\\u00D7]\\s*(\\d{1,3})\\s*${QSINGLE}\\s*(\\d{1,2})?\\s*${QDOUBLE}?$`,
);

console.log("regex:", DIM_RE.source);

const tests = [
  `18'11" × 5'5"`,
  `18'11" x 5'5"`,
  `12'7" × 14'10"`,
  `10'0" × 8'0"`,
  `4'11" × 4'11"`,
  // With unicode quotes:
  `18’1’1” × 5’5”`,
];

for (const t of tests) {
  const stripped = t.replace(/\s+/g, "");
  const m = DIM_RE.exec(stripped);
  console.log(
    JSON.stringify(t),
    "stripped:",
    JSON.stringify(stripped),
    "match:",
    m ? "OK " + m.slice(1).join(",") : "MISS",
  );
}
