const fs = require('fs');
let src = fs.readFileSync('apps/WebCAD/public/app.js','utf8');
const grab = (name) => {
  const i = src.indexOf('function ' + name);
  if (i < 0) throw new Error('missing ' + name);
  let d = 0, j = src.indexOf('{', i);
  let start = i;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(start, k+1); }
  }
};
let code = '';
for (const n of ['dxfLine','exportDXF','parseDXF']) code += '\n' + grab(n) + '\n';
// Stubs matching the app environment: layers as objects, DXF y-flip convention,
// DOM helpers used by exportDXF, palette used by parseDXF.
code = `
const LAYER_COLORS = ['#e2e8f0','#f87171','#4ade80','#60a5fa','#fbbf24','#c084fc'];
const state = { doc: { layers: [{name:'0',visible:true},{name:'L1',visible:true}], entities } };
function download(name, data, mime) { globalThis.__dxf = data; }
function toast(msg) {}
function slug(s) { return String(s||'').replace(/[^a-zA-Z0-9_-]/g,'_'); }
` + code + `
exportDXF();
return { dxfText: globalThis.__dxf, parseDXF };`;
const entities = [
  {type:'line', p1:[0,0], p2:[100,50]},
  {type:'polyline', pts:[[0,0],[10,0],[10,10],[0,10]]},
  {type:'rect', p1:[5,5], p2:[25,20]},
  {type:'circle', c:[50,50], r:25},
  {type:'arc', c:[30,30], r:10, a0:30, a1:250},
  {type:'text', p:[12,34], size:8, text:'Hello'},
];
const fn = new Function('entities', code);
const { dxfText, parseDXF } = fn(entities);
if (!dxfText) { console.log('FAIL: no DXF produced', dxfText); process.exit(1); }
const back = parseDXF(dxfText);
const ents = back.entities;
console.log('imported', ents.length, 'entities; layers:', back.layers.map(l=>l.name).join(','));
let fails = 0;
const near = (a,b,t=1e-6)=>Math.abs(a-b)<t;
const hasLine = (x1,y1,x2,y2) => ents.some(e => e.type==='line' &&
  ((near(e.p1[0],x1,0.001)&&near(e.p1[1],y1,0.001)&&near(e.p2[0],x2,0.001)&&near(e.p2[1],y2,0.001)) ||
   (near(e.p1[0],x2,0.001)&&near(e.p1[1],y2,0.001)&&near(e.p2[0],x1,0.001)&&near(e.p2[1],y1,0.001))));
// line
if (!hasLine(0,0,100,50)) { fails++; console.log('LINE FAIL'); }
// polyline -> 3 segments
const pl = ents.filter(e => e.type==='line' && (near(e.p1[0],0)||near(e.p2[0],0)) &&
  ents.indexOf(e) > 0); // loose check below instead
const expectedPL = [[0,0],[10,0],[10,10],[0,10]];
for (let k=0;k<3;k++) {
  if (!hasLine(expectedPL[k][0],expectedPL[k][1],expectedPL[k+1][0],expectedPL[k+1][1])) { fails++; console.log('POLYLINE SEG FAIL', k); }
}
// rect -> 4 sides
const rp1=[5,5], rp2=[25,20];
const rpts=[[rp1[0],rp1[1]],[rp2[0],rp1[1]],[rp2[0],rp2[1]],[rp1[0],rp2[1]]];
for (let k=0;k<4;k++) {
  if (!hasLine(rpts[k][0],rpts[k][1],rpts[(k+1)%4][0],rpts[(k+1)%4][1])) { fails++; console.log('RECT SIDE FAIL', k); }
}
// circle
const circ = ents.find(e => e.type==='circle');
if (!circ || !near(circ.c[0],50,0.001) || !near(circ.c[1],50,0.001) || !near(circ.r,25,0.001)) { fails++; console.log('CIRCLE FAIL', circ); }
// arc: sweep 220deg preserved (a0/a1 may be re-normalized)
const arc = ents.find(e => e.type==='arc');
if (arc) {
  const sweep = ((arc.a1 - arc.a0) % 360 + 360) % 360;
  if (!near(arc.c[0],30,0.001) || !near(arc.c[1],30,0.001) || !near(arc.r,10,0.001) || !near(sweep,220,0.01)) { fails++; console.log('ARC FAIL', arc, sweep); }
} else { fails++; console.log('ARC MISSING'); }
// text
const txt = ents.find(e => e.type==='text');
if (!txt || txt.text !== 'Hello' || !near(txt.p[0],12,0.001) || !near(txt.p[1],34,0.001)) { fails++; console.log('TEXT FAIL', txt); }
console.log(fails===0 ? 'ROUNDTRIP PASS ('+ents.length+' entities)' : 'FAILURES: '+fails);
process.exit(fails===0 ? 0 : 1);
