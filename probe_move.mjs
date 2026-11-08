// Move probe v5: selection-first, drag from line midpoint, inspect drag state.
// Uses direct Runtime.evaluate with raw logging (ev wrapper proved unreliable in v4).
const url = (process.argv[2] || 'http://localhost:8080').replace(/\/$/, '');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ver = await (await fetch('http://127.0.0.1:9222/json/version')).json();
const w = new WebSocket(ver.webSocketDebuggerUrl); await new Promise(r => w.onopen = r);
let id = 0, h = {}; w.onmessage = m => { const d = JSON.parse(m.data); if (d.id && h[d.id]) { h[d.id](d); delete h[d.id]; } };
const send = (m, p = {}, s) => new Promise(res => { h[++id] = res; w.send(JSON.stringify({ id, method: m, params: p, sessionId: s })) });
const cr = await send('Target.createTarget', { url: 'about:blank' });
const at = await send('Target.attachToTarget', { targetId: cr.result.targetId, flatten: true });
const SID = at.result.sessionId;
await send('Runtime.enable', {}, SID); await send('Page.enable', {}, SID);
const ev = async (label, e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, SID);
  const rr = r.result && r.result.result ? r.result.result : r.result;
  if (rr && rr.type === 'string') return rr.value;
  if (rr && rr.value !== undefined && rr.value !== null) return rr.value;
  console.log('RAW[' + label + ']', JSON.stringify(r).slice(0, 400));
  return null;
};

await send('Page.navigate', { url: url + '/' }, SID); await sleep(2000);
let reg = null;
for (let att = 0; att < 3 && !reg; att++) {
  reg = await ev('setup', `(async()=>{const u='r9'+Math.random().toString(36).slice(2,8);const r=await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:'passw0rd-1234'})});const d=await(await fetch('/api/drawings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'mv',data:{layers:[{name:'Walls',color:'#d9dee6',visible:true,locked:false,lineweight:1}],entities:[{type:'line',layer:'Walls',p1:[-80,-50],p2:[80,50]}]}})})).json();return JSON.stringify({reg:r.status,id:d.drawing&&d.drawing.id});})()`);
  if (!reg) await sleep(1000);
}
console.log('setup', reg);
if (!reg) { process.exit(1); }
const did = JSON.parse(reg).id;
await send('Page.navigate', { url: url + '/d/' + did }, SID); await sleep(4000);
const out = await ev('move', `(async()=>{
  for(let i=0;i<40;i++){const c=document.getElementById('countInfo')?.textContent||'';if(!c.startsWith('0 '))break;await new Promise(r=>setTimeout(r,250));}
  const A=window.__WebCAD; if(!A) return 'no __WebCAD';
  const c=document.getElementById('cv'); const r=c.getBoundingClientRect();
  const m=A.w2s([0,0]); const cx=r.left+m[0], cy=r.top+m[1];
  document.querySelector('.tool[data-tool="select"]').click(); await new Promise(res=>setTimeout(res,100));
  const ev2=(t,x,y)=>c.dispatchEvent(new MouseEvent(t,{clientX:x,clientY:y,button:0,bubbles:true,cancelable:true}));
  ev2('mousedown',cx-200,cy-200); await new Promise(res=>setTimeout(res,80));
  ev2('mousemove',cx+200,cy+200); await new Promise(res=>setTimeout(res,80));
  ev2('mouseup',cx+200,cy+200); await new Promise(res=>setTimeout(res,250));
  const selInfo=document.getElementById('selInfo').textContent;
  const selLen=(A.state&&A.state.sel)?A.state.sel.length:-1;
  ev2('mousedown',cx,cy); await new Promise(res=>setTimeout(res,150));
  const d1=JSON.stringify({mode:A.state.drag&&A.state.drag.mode,ents:A.state.drag&&A.state.drag.ents&&A.state.drag.ents.length});
  ev2('mousemove',cx+60,cy+40); await new Promise(res=>setTimeout(res,150));
  const d2=JSON.stringify({mode:A.state.drag&&A.state.drag.mode,moved:A.state.drag&&A.state.drag.moved,dx:A.state.drag&&A.state.drag.dx,dy:A.state.drag&&A.state.drag.dy});
  ev2('mouseup',cx+60,cy+40); await new Promise(res=>setTimeout(res,400));
  const ent=(A.state&&A.state.doc&&A.state.doc.entities)?A.state.doc.entities[0]:null;
  return JSON.stringify({selInfo,selLen,d1,d2,entAfter:ent?ent.p1:null,count:document.getElementById('countInfo').textContent});
})()`);
console.log('result', out);
await send('Page.navigate', { url: url + '/' }, SID); await sleep(600);
const saved = await ev('saved', `(async()=>{const j=await(await fetch('/api/drawings/${did}')).json();return JSON.stringify(j.drawing.data.entities[0]);})()`);
console.log('saved', saved);
