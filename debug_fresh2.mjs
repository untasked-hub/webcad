// Debug: register user, create drawing, navigate to editor, reload, marquee with mid-drag state dumps.
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

const USER='db'+Math.random().toString(36).slice(2,9);
await bw.send('Page.navigate',{url},SID); await sleep(2500);
const reg = await ev(`(async()=>{
  const r=await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'${USER}',password:'pw12345678'})});
  return r.status;
})()`);
const DR={name:'dbg',data:{layers:[{name:'Walls',color:'#d9dee6',visible:true,locked:false,lineweight:1}],entities:[{type:'line',layer:'Walls',p1:[-80,-50],p2:[80,50]}]}};
const created=await ev(`(async()=>{const r=await fetch('/api/drawings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(DR)})});const j=await r.json();return j.drawing.id;})()`);
console.log('REG',reg,'DID',created);
await bw.send('Page.navigate',{url:url+'/d/'+created},SID); await sleep(3000);
// NOW RELOAD the same editor page (the fresh-load regression)
await bw.send('Page.navigate',{url:url+'/d/'+created},SID); await sleep(3500);
const pre = await ev(`(async()=>{
  for(let i=0;i<40;i++){const c=document.getElementById('countInfo')?.textContent||'';if(c&&!c.startsWith('0 '))break;await new Promise(r=>setTimeout(r,250));}
  return {count:document.getElementById('countInfo')?.textContent};
})()`);
console.log('PRE',JSON.stringify(pre));
await ev(`window.__r8marquee = async function(sx,sy,ex,ey){
  const c=document.getElementById('cv');
  const sel=document.querySelector('.tool[data-tool="select"]');
  sel.click(); await new Promise(r=>setTimeout(r,120));
  const A=window.__WebCAD;
  const ev=(t,x,y)=>c.dispatchEvent(new MouseEvent(t,{clientX:x,clientY:y,button:0,bubbles:true,cancelable:true}));
  const snap=()=>({tool:A.state.tool,drag:A.state.drag?{mode:A.state.drag.mode,ents:(A.state.drag.ents||[]).length}:null});
  ev('mousedown',sx,sy); await new Promise(r=>setTimeout(r,80));
  const s1=snap();
  ev('mousemove',(sx+ex)/2,(sy+ey)/2); await new Promise(r=>setTimeout(r,80));
  const s2=snap();
  ev('mousemove',ex,ey); await new Promise(r=>setTimeout(r,80));
  ev('mouseup',ex,ey); await new Promise(r=>setTimeout(r,200));
  return {selInfo:document.getElementById('selInfo').textContent, s1, s2, selLen:(A.state.sel||[]).length};
};`);
const a = await ev(`(()=>{const A=window.__WebCAD;const r=document.getElementById('cv').getBoundingClientRect();
  const p1=A.w2s([-80,-50]),p2=A.w2s([80,50]);
  return [r.left+p1[0],r.top+p1[1],r.left+p2[0],r.top+p2[1],r.left,r.top,r.width,r.height];})()`);
console.log('GEO',JSON.stringify(a));
// window drag first
const w1=await ev(`window.__r8marquee(${a[0]-40},${a[1]+40},${a[2]+40},${a[3]-40})`);
console.log('WINDOW',JSON.stringify(w1));
const c1=await ev(`window.__r8marquee(${a[2]+40},${a[3]-40},${a[0]-40},${a[1]+40})`);
console.log('CROSS',JSON.stringify(c1));
process.exit(0);