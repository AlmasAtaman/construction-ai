/** PROTOTYPE: seeded region-growing room separation on Beaver p5.
 * Walls (correct CAD layers) = barriers; room-label positions = seeds;
 * multi-source BFS assigns free space to nearest seed → per-room cells.
 * Validates against friend's Overstock 840 sqft / 93.3 lf. */
import fs from "fs";
import * as mupdf from "mupdf";
import { scanSegmentsByLayer } from "../src/lib/extract/layer-scan";
import { classifyLayers, WALL_ROLES } from "../src/lib/extract/layer-classify";

const PT_PER_FT = 18;
const GRID_PT = 3; // pt per pixel
const buf = fs.readFileSync("tests/fixtures/friend-commercial-plan.pdf");

// --- walls (construction view only: y 150-700) ---
const scan = await scanSegmentsByLayer(buf, 5);
const roles = Object.fromEntries(classifyLayers(Object.keys(scan.segmentsPerLayer)).map(c=>[c.name,c.role]));
const walls = scan.segments.filter(s => s.layer && WALL_ROLES.has(roles[s.layer]) && !s.diagonal
  && Math.min(s.y1,s.y2) > 150 && Math.max(s.y1,s.y2) < 700 && Math.min(s.x1,s.x2) > 150 && Math.max(s.x1,s.x2) < 1300);

// --- seeds (mupdf structured-text room labels in construction view) ---
const st = JSON.parse((mupdf as any).Document.openDocument(new Uint8Array(buf),"application/pdf").loadPage(4).toStructuredText().asJSON());
const ROOM = /^(WASHROOM|VESTIBULE|OVERSTOCK|SALES|SERVICE|ELECTRICAL)$/i;
const seeds: {t:string;x:number;y:number}[] = [];
for (const b of st.blocks ?? []) for (const l of b.lines ?? []) {
  const t=(l.text||"").trim(); const bb=l.bbox;
  const x=bb.x+bb.w/2, y=bb.y+bb.h/2;
  if (ROOM.test(t) && y>150 && y<700) {
    // merge WASHROOM+VESTIBULE into one washroom seed cluster; dedupe near-dups
    if (!seeds.some(s=>Math.abs(s.x-x)<40 && Math.abs(s.y-y)<40)) seeds.push({t,x,y});
  }
}
console.log("seeds:", seeds.map(s=>`${s.t}(${s.x|0},${s.y|0})`).join(" "));

// --- rasterize ---
const xs = walls.flatMap(s=>[s.x1,s.x2]), ys = walls.flatMap(s=>[s.y1,s.y2]);
const x0=Math.min(...xs)-10, y0=Math.min(...ys)-10, x1=Math.max(...xs)+10, y1=Math.max(...ys)+10;
const W=Math.ceil((x1-x0)/GRID_PT), H=Math.ceil((y1-y0)/GRID_PT);
const px=(x:number)=>Math.round((x-x0)/GRID_PT), py=(y:number)=>Math.round((y-y0)/GRID_PT);
const wall=new Uint8Array(W*H); // 1=barrier
function plot(c:number,r:number){ for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const a=c+dx,b=r+dy; if(a>=0&&a<W&&b>=0&&b<H)wall[b*W+a]=1;}}
for (const s of walls){ // Bresenham
  let c0=px(s.x1),r0=py(s.y1); const c1=px(s.x2),r1=py(s.y2);
  const dc=Math.abs(c1-c0),dr=Math.abs(r1-r0),sc=c0<c1?1:-1,sr=r0<r1?1:-1; let e=dc-dr;
  for(;;){ plot(c0,r0); if(c0===c1&&r0===r1)break; const e2=2*e; if(e2>-dr){e-=dr;c0+=sc;} if(e2<dc){e+=dc;r0+=sr;} }
}

// --- multi-source BFS (region = nearest seed through free space) ---
const owner=new Int16Array(W*H).fill(-1);
const q:number[]=[];
seeds.forEach((s,i)=>{ let c=px(s.x),r=py(s.y);
  // nudge off walls
  if(wall[r*W+c]){ outer: for(let R=1;R<8;R++)for(let dy=-R;dy<=R;dy++)for(let dx=-R;dx<=R;dx++){const a=c+dx,b=r+dy;if(a>=0&&a<W&&b>=0&&b<H&&!wall[b*W+a]){c=a;r=b;break outer;}} }
  owner[r*W+c]=i; q.push(r*W+c);
});
let head=0;
while(head<q.length){ const p=q[head++]; const r=(p/W)|0,c=p%W,o=owner[p];
  for(const [dc,dr] of [[1,0],[-1,0],[0,1],[0,-1]]){ const a=c+dc,b=r+dr; if(a<0||a>=W||b<0||b>=H)continue; const np=b*W+a; if(wall[np]||owner[np]!==-1)continue; owner[np]=o; q.push(np); }
}

// --- measure per-region: area + boundary perimeter touching walls ---
const FT2=(GRID_PT/PT_PER_FT)**2;
console.log("\nregion          area(sqft)  wall-perim(lf)");
seeds.forEach((s,i)=>{
  let area=0, wperim=0;
  for(let r=0;r<H;r++)for(let c=0;c<W;c++){ const p=r*W+c; if(owner[p]!==i)continue; area++;
    for(const [dc,dr] of [[1,0],[-1,0],[0,1],[0,-1]]){ const a=c+dc,b=r+dr; const wallEdge=(a<0||a>=W||b<0||b>=H)||wall[b*W+a]; if(wallEdge)wperim++; }
  }
  console.log(`  ${s.t.padEnd(12)} ${(area*FT2).toFixed(0).padStart(8)}  ${(wperim*GRID_PT/PT_PER_FT).toFixed(0).padStart(10)}`);
});
console.log("\nfriend: OVERSTOCK 840 sqft walls (=93.3 lf @9ft) ; SALES+SERVICE 1540.9 sqft (=171 lf)");

// --- visualize: colored region map over the plan ---
const COL = [[255,80,80],[80,160,255],[80,200,80],[255,180,40],[200,80,220],[40,200,200]];
const doc2=(mupdf as any).Document.openDocument(new Uint8Array(buf),"application/pdf");
const S=2;
const pix=doc2.loadPage(4).toPixmap((mupdf as any).Matrix.scale(S,S),(mupdf as any).ColorSpace.DeviceRGB,false,true);
fs.writeFileSync("/tmp/layers/proto-base.png", pix.asPNG());
fs.writeFileSync("/tmp/layers/proto-grid.json", JSON.stringify({
  W,H,x0,y0,GRID_PT,S, owner:Array.from(owner),
  seeds: seeds.map(s=>({t:s.t,x:s.x,y:s.y})),
}));
console.log("dumped grid for render");
