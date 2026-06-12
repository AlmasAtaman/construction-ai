import fs from "fs";
import * as mupdf from "mupdf";

async function probe(pdfPath: string, pageIdx: number, layerRe: RegExp, ptPerFt: number) {
  const doc = (mupdf as any).Document.openDocument(new Uint8Array(fs.readFileSync(pdfPath)), "application/pdf");
  const page = doc.loadPage(pageIdx);
  const stack: string[] = [];
  const stats = new Map<string, {fillLf: number, strokeLf: number, fillSegs: number, strokeSegs: number}>();
  let cx=0, cy=0, sx=0, sy=0;
  const tx=(c:number[],x:number,y:number)=>[c[0]*x+c[2]*y+c[4], c[1]*x+c[3]*y+c[5]] as [number,number];
  let mode: "fill"|"stroke" = "fill";
  const emit=(x1:number,y1:number,x2:number,y2:number)=>{
    const dx=Math.abs(x2-x1), dy=Math.abs(y2-y1), l=Math.hypot(dx,dy);
    if(l<5) return;
    if(!((dy<1.5&&dx>1.5)||(dx<1.5&&dy>1.5)||l>=50)) return;
    const layer = stack[stack.length-1] ?? "(none)";
    if (!layerRe.test(layer)) return;
    const s = stats.get(layer) ?? {fillLf:0, strokeLf:0, fillSegs:0, strokeSegs:0};
    if (mode==="fill") {s.fillLf += l/ptPerFt; s.fillSegs++;} else {s.strokeLf += l/ptPerFt; s.strokeSegs++;}
    stats.set(layer, s);
  };
  const collect=(p:any,ctm:number[])=>p.walk({
    moveTo:(x:number,y:number)=>{[cx,cy]=tx(ctm,x,y);sx=cx;sy=cy;},
    lineTo:(x:number,y:number)=>{const[nx,ny]=tx(ctm,x,y);emit(cx,cy,nx,ny);cx=nx;cy=ny;},
    curveTo:(_a:any,_b:any,_c:any,_d:any,ex:number,ey:number)=>{[cx,cy]=tx(ctm,ex,ey);},
    closePath:()=>{emit(cx,cy,sx,sy);cx=sx;cy=sy;},
  });
  page.run(new (mupdf as any).Device({
    beginLayer:(n:string)=>stack.push(n),
    endLayer:()=>stack.pop(),
    fillPath:(p:any,_:any,c:number[])=>{mode="fill";collect(p,c);},
    strokePath:(p:any,_:any,c:number[])=>{mode="stroke";collect(p,c);},
  }), (mupdf as any).Matrix.identity);
  for (const [layer, s] of stats) {
    console.log(`  ${layer}: fill ${s.fillSegs} segs/${s.fillLf.toFixed(0)} lf · stroke ${s.strokeSegs} segs/${s.strokeLf.toFixed(0)} lf`);
  }
}
console.log("DP-BP p10 wall layers:");
await probe("tests/fixtures/DP-BP-new-home-sample-drawings.pdf", 9, /Wall Standard/, 13.5);
console.log("Beaver Tails p5 wall layers:");
await probe("tests/fixtures/friend-commercial-plan.pdf", 4, /H?WALL/, 18);
