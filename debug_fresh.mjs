// Debug fresh-load crossing marquee: reload page, report state before/after drag.
const url = 'http://localhost:8080';
const CDP_HTTP = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function getJSON(p){const r=await fetch(CDP_HTTP+p);return r.json();}
class WS{constructor(u){this.u=u;this.id=0;this.h=new Map();}
connect(){return new Promise((res,rej)=>{const w=new WebSocket(this.u);w.onopen=()=>{this.w=w;res();};w.onerror=()=>rej(new Error('ws'));w.onmessage=m=>{const d=JSON.parse(m.data);if(d.id&&this.h.has(d.id)){const f=this.h.get(d.id);this.h.delete(d.id);f(d);}};});}
send(method,params={},sessionId){const id=++this.id;const msg={id,method,params};if(sessionId)msg.sessionId=sessionId;return new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('timeout '+method)),30000);this.h.set(id,d=>{clearTimeout(t);d.error?rej(new Error(JSON.stringify(d.error))):res(d.result);});this.w.send(JSON.stringify(msg));});}}
const ver=await getJSON('/json/version');
const bw=new WS(ver.webSocketDebuggerUrl);await bw.connect();
let targets=(await bw.send('Target.getTargets')).targetInfos.filter(t=>t.type==='page');
const pick=targets[0];
console.log('ATTACH',pick.targetId,pick.url);
const SID=(await bw.send('Target.attachToTarget',{targetId:pick.targetId,flatten:true})).sessionId;
await bw.send('Runtime.enable',{},SID);
await bw.send('Page.enable',{},SID);
const ev=async(e)=>{const r=await bw.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true},SID);if(r.exceptionDetails)throw new Error('EXC '+(r.exceptionDetails.exception?.description||r.exceptionDetails.text));return r.result?.value;};

// reload current editor page
await bw.send('Page.navigate',{url},SID);
await sleep(3000);
const pre = await ev(`(async()=>{
  for(let i=0;i<40;i++){const c=document.getElementById('countInfo')?.textContent||'';if(c && !c.startsWith('0 '))break;await new Promise(r=>setTimeout(r,250));}
  const A=window.__WebCAD;
  return {count:document.getElementById('countInfo')?.textContent, hasA:!!A, hasW2s:!!(A&&A.w2s), tool:A&&A.state&&A.state.tool, ents:A&&A.state&&A.state.doc&&A.state.doc.entities&&A.state.doc.entities.length, sel:A&&A.state&&A.state.sel&&A.state.sel.length};
})()`);
console.log('PRE', JSON.stringify(pre));

// define marquee like verify, then run crossing drag with diagnostics
await ev(`window.__r8marquee = async function(sx, sy, ex, ey){
  const c=document.getElementById('cv');
  const sel=document.querySelector('.tool[data-tool="select"]');
  sel.click();
  await new Promise(r=>setTimeout(r,120));
  const ev=(t,x,y)=>c.dispatchEvent(new MouseEvent(t,{clientX:x,clientY:y,button:0,bubbles:true,cancelable:true}));
  ev('mousedown',sx,sy); await new Promise(r=>setTimeout(r,80));
  ev('mousemove',(sx+ex)/2,(sy+ey)/2); await new Promise(r=>setTimeout(r,80));
  ev('mousemove',ex,ey); await new Promise(r=>setTimeout(r,80));
  ev('mouseup',ex,ey); await new Promise(r=>setTimeout(r,200));
  return document.getElementById('selInfo').textContent;
};`);
const mid = await ev(`(()=>{const A=window.__WebCAD;const r=document.getElementById('cv').getBoundingClientRect();
  const p1=A.w2s([-80,-50]),p2=A.w2s([80,50]);
  return [r.left+p1[0],r.top+p1[1],r.left+p2[0],r.top+p2[1], r.width, r.height];})()`);
console.log('LINE SCREEN', JSON.stringify(mid));
const res = await ev(`(async()=>{
  const A=window.__WebCAD;const r=document.getElementById('cv').getBoundingClientRect();
  const p1=A.w2s([-80,-50]),p2=A.w2s([80,50]);
  const a=[r.left+p1[0],r.top+p1[1],r.left+p2[0],r.top+p2[1]];
  const sel = await window.__r8marquee(a[2]+40,a[3]-40,a[0]-40,a[1]+40);
  return {sel, tool:A.state.tool, selArr:(A.state.sel||[]).length, drag:A.state.drag?{mode:A.state.drag.mode}:null, zoom:A.state.view&&A.state.view.zoom};
})()`);
console.log('RESULT', JSON.stringify(res));
process.exit(0);