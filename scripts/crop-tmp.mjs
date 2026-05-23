import sharp from "sharp";
const src = process.argv[2];
const out = process.argv[3];
// fractional box: left, top, width, height
const L = parseFloat(process.argv[4] ?? "0");
const T = parseFloat(process.argv[5] ?? "0");
const W = parseFloat(process.argv[6] ?? "0.42");
const H = parseFloat(process.argv[7] ?? "1");
const meta = await sharp(src).metadata();
const box = {
  left: Math.round(meta.width * L),
  top: Math.round(meta.height * T),
  width: Math.round(meta.width * W),
  height: Math.round(meta.height * H),
};
await sharp(src).extract(box).toFile(out);
console.log("cropped", src, "->", out, JSON.stringify(box));
