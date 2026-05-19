import { readFile, writeFile } from "node:fs/promises";
import { pdf } from "pdf-to-img";
const buf = await readFile("tests/fixtures/benchmark-plan.pdf");
const doc = await pdf(buf, { scale: 1.5 });
let i = 0;
for await (const png of doc) {
  i++;
  await writeFile(`/tmp/bench-p${i}.png`, png);
}
console.log("done", i);
