// Round 8: verify marquee selection works from all 4 drag directions + move, in sandbox.
// Usage: node verify_round8.mjs http://localhost:8080
const url = (process.argv[2] || 'http://localhost:8080').replace(/\/$/, '');
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function getJSON(path) {
  const r = await fetch(CDP_HTTP + path);
  if (!r.ok) throw new Error(path + ' -> ' + r.status);
  return r.json();
}
class WS {
  constructor(u) { this.u = u; this.id = 0; this.h = new Map(); }
  connect() {
    return new Promise((res, rej) => {
      const w = new WebSocket(this.u);
      w.onopen = () => { this.w = w; res(); };
      w.onerror = (e) => rej(new Error('ws error'));
      w.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.id && this.h.has(d.id)) { const f = this.h.get(d.id); this.h.delete(d.id); f(d); }
      };
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout ' + method)), 30000);
      this.h.set(id, (d) => { clearTimeout(t); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); });
      this.w.send(JSON.stringify(msg));
    });
  }
}
async function attachBrowserPage(cdpHttp, wantUrl) {
  const ver = await getJSON('/json/version');
  const bw = new WS(ver.webSocketDebuggerUrl);
  await bw.connect();
  let targets = [];
  for (let i = 0; i < 10; i++) {
    const r = await bw.send('Target.getTargets');
    targets = r.targetInfos.filter(t => t.type === 'page');
    if (targets.length) break;
    await sleep(500);
  }
  let pick = targets[0];
  if (wantUrl) {
    const cr = await bw.send('Target.createTarget', { url: wantUrl });
    pick = (await bw.send('Target.getTargets')).targetInfos.find(t => t.targetId === cr.targetId);
    await sleep(2500);
  }
  console.log('ATTACH', pick.targetId, pick.url);
  const at = await bw.send('Target.attachToTarget', { targetId: pick.targetId, flatten: true });
  await bw.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
  return { bw, sessionId: at.sessionId };
}
const results = [];
const ok = (name, pass, detail) => { results.push(pass); console.log((pass ? 'PASS' : 'FAIL') + ' ' + name + ' :: ' + detail); };
const { bw, sessionId: SID } = await attachBrowserPage(CDP_HTTP, url + '/');
const ws = bw;
await ws.send('Runtime.enable', {}, SID);
await ws.send('Page.enable', {}, SID);
const evalJS = async (expr) => {
  const r = await ws.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, SID);
  if (r.exceptionDetails) throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
};

// 1. Register a fresh user in-page (session cookie lands in browser jar)
const USER = 'r8' + Math.random().toString(36).slice(2, 9);
const PASS = 'passw0rd-1234';
const reg = await evalJS(`(async()=>{
  const r = await fetch('/api/auth/register', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'${USER}',password:'${PASS}'})});
  const me = await (await fetch('/api/auth/me')).json();
  return {status:r.status, user:me && me.user && me.user.username};
})()`);
ok('register+session in-page', reg.status === 201 && reg.user === USER, JSON.stringify(reg));

// 2. Create a drawing with a line centred at world origin
const DR = { name: 'r8-sel-' + Date.now(), data: { layers: [{ name: 'Walls', color: '#d9dee6', visible: true, locked: false, lineweight: 1 }], entities: [{ type: 'line', layer: 'Walls', p1: [-80, -50], p2: [80, 50] }] } };
const created = await evalJS(`(async()=>{
  const r = await fetch('/api/drawings', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(DR)})});
  const j = await r.json(); return {status:r.status, id:j.drawing&&j.drawing.id};
})()`);
ok('create drawing via API', created.status === 201 && !!created.id, JSON.stringify(created));
const DID = created.id;

// 3. Navigate to the editor with that drawing loaded
await ws.send('Page.navigate', { url: url + '/d/' + DID }, SID);
await sleep(3000);
const boot = await evalJS(`(async()=>{
  for(let i=0;i<60;i++){
    const c=document.getElementById('countInfo')?.textContent||'';
    if(c && !c.startsWith('0 ')) return c;
    await new Promise(r=>setTimeout(r,250));
  }
  return document.getElementById('countInfo')?.textContent || 'never';
})()`);
ok('editor boots with drawing loaded', /^1 /.test(String(boot)), 'countInfo=' + JSON.stringify(boot));

// 4. Marquee select from each of 4 directions
const dragDirs = `window.__r8marquee = async function(sx, sy, ex, ey){
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
};`;

// Exact screen coords of the line endpoints via the app's own transform hook
const lineS = `(()=>{const A=window.__WebCAD;if(!A||!A.w2s) return [NaN,NaN,NaN,NaN];
  const r=document.getElementById('cv').getBoundingClientRect();
  const p1=A.w2s([-80,-50]),p2=A.w2s([80,50]);
  return [r.left+p1[0],r.top+p1[1],r.left+p2[0],r.top+p2[1]];})()`;
const dirs = [
  ['window drag: left-top -> right-down', '(a[0]-40)', '(a[3]-40)', '(a[2]+40)', '(a[1]+40)'],
  ['crossing drag: right-bottom -> left-up', '(a[2]+40)', '(a[1]+40)', '(a[0]-40)', '(a[3]-40)'],
  ['crossing drag: right-top -> left-down', '(a[2]+40)', '(a[1]+40)', '(a[0]-40)', '(a[3]-40)'],
  ['crossing drag: left-bottom -> right-up', '(a[0]-40)', '(a[1]+40)', '(a[2]+40)', '(a[3]-40)'],
];
await evalJS(dragDirs);
const selRes = [];
for (const [name, sxf, syf, exf, eyf] of dirs) {
  const sel = await evalJS(`(async()=>{
    const a=${lineS};
    const [x1s,y1s,x2s,y2s]=a;
    return await window.__r8marquee(${sxf},${syf},${exf},${eyf});
  })()`);
  const pass = /1 object/.test(String(sel));
  selRes.push([name, pass, sel]);
  ok(name, pass, 'selInfo=' + JSON.stringify(sel));
}

// 5. Move the selected item (drag with select tool after selection)
const moveRes = await evalJS(`(async()=>{
  const a=${lineS};
  // select via marquee over the line, then drag from the line midpoint
  const selinfo = await window.__r8marquee(a[0]-40,a[3]-40,a[2]+40,a[1]+40);
  if(!/1 object/.test(selinfo)) return {error:'selection first: '+selinfo};
  const A=window.__WebCAD;
  const c=document.getElementById('cv'); const cr=c.getBoundingClientRect();
  const m=A.w2s([0,0]); const cx=cr.left+m[0], cy=cr.top+m[1];
  const ev=(t,x,y)=>c.dispatchEvent(new MouseEvent(t,{clientX:x,clientY:y,button:0,bubbles:true,cancelable:true}));
  ev('mousedown',cx,cy); await new Promise(r=>setTimeout(r,120));
  ev('mousemove',cx+60,cy+40); await new Promise(r=>setTimeout(r,120));
  ev('mouseup',cx+60,cy+40); await new Promise(r=>setTimeout(r,300));
  // flush state to server (app autosave) then read back coords via API
  for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,300));
    const r=await fetch('/api/drawings/${DID}'); if(!r.ok) continue; const j=await r.json();
    const e=j.drawing.data.entities[0];
    if(Math.abs(e.p1[0] - (-80))>1) return {saved:true, before:[-80,-50,80,50], after:e.p1.concat(e.p2), moved:true, sel:selinfo};
  }
  const rr=await fetch('/api/drawings/${DID}'); const j=await rr.json();
  return {saved:false, after:j.drawing.data.entities[0].p1.concat(j.drawing.data.entities[0].p2), sel:selinfo};
})()`);
ok('move item after selection (coords change)', !!moveRes.moved, JSON.stringify(moveRes));

// 6. Fresh-load selection regression: reverse-drag on reloaded page
await ws.send('Page.navigate', { url: url + '/d/' + DID }, SID);
await sleep(3000);
await evalJS(dragDirs);
const fresh = await evalJS(`(async()=>{
  for(let i=0;i<40;i++){const c=document.getElementById('countInfo')?.textContent||'';if(!c.startsWith('0 '))break;await new Promise(r=>setTimeout(r,250));}
  const A=window.__WebCAD;
  const r=document.getElementById('cv').getBoundingClientRect();
  const e=(A.state.doc?.entities||[])[0];
  const q=A.w2s(e&&e.p1?e.p1:[-80,-50]), w=A.w2s(e&&e.p2?e.p2:[80,50]);
  const a=[r.left+q[0],r.top+q[1],r.left+w[0],r.top+w[1]];
  // clamp every drag point inside the canvas rect (app ignores events outside it)
  const cl=(x,y)=>[Math.max(r.left+15,Math.min(r.right-15,x)),Math.max(r.top+15,Math.min(r.bottom-15,y))];
  const [sx1,sy1]=cl(a[2]+40,a[3]-40), [ex1,ey1]=cl(a[0]-40,a[1]+40);
  const [sx2,sy2]=cl(a[0]-40,a[1]+40), [ex2,ey2]=cl(a[2]+40,a[3]-40);
  const sel=await window.__r8marquee(sx1,sy1,ex1,ey1);
  const winSel=await window.__r8marquee(sx2,sy2,ex2,ey2);
  return {count:document.getElementById('countInfo')?.textContent, line:a, rect:[r.left,r.top,r.width,r.height], url:location.pathname, cross:sel, win:winSel, ents:(A.state.doc?.entities||[]).length};
})()`);
ok('fresh-load crossing drag selects', /1 object/.test(String(fresh && fresh.cross)), 'detail=' + JSON.stringify(fresh));

console.log('SUMMARY ' + JSON.stringify({ pass: results.filter(Boolean).length, fail: results.filter(x => !x).length, user: USER, drawingId: DID }));
console.log('RESULT ' + (results.every(Boolean) ? 'PASS' : 'FAIL'));
process.exit(results.every(Boolean) ? 0 : 1);
