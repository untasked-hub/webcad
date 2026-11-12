import { spawn } from 'node:child_process';
const PORT = 9344; const BASE = 'http://localhost:8080';
const sleep = ms => new Promise(r => setTimeout(r, ms));
spawn('chrome-headless', ['--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--user-data-dir=/tmp/chrome_probe_tr2', '--window-size=1400,900', 'about:blank'], { detached: true, stdio: 'ignore' });
for (let i = 0; i < 20; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(500); } }
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find(t => t.type === 'page');
class Cdp { constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();} static async connect(url){const ws=new WebSocket(url); await new Promise((res,rej)=>{ws.onopen=res; ws.onerror=rej;}); const c=new Cdp(ws); ws.onmessage=(e)=>{const m=JSON.parse(e.data); if(m.id&&c.pending.has(m.id)){c.pending.get(m.id)(m);c.pending.delete(m.id);}}; return c;} send(method,params={}){const id=++this.id; return new Promise((res,rej)=>{this.pending.set(id,(m)=>m.error?rej(new Error(method+': '+JSON.stringify(m.error))):res(m.result)); this.ws.send(JSON.stringify({id,method,params}));});}}
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
await cdp.send('Page.navigate', { url: BASE + '?rnd=' + Date.now() });
await sleep(2500);
const q = async (ex) => { const r = await cdp.send('Runtime.evaluate', { expression: ex, returnByValue: true }); return r.exceptionDetails ? 'EX: ' + String(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)).slice(0,200) : JSON.stringify(r.result.result?.value); };
await q(`(() => { const s=window.__ak.state; s.doc.entities.length=0; s.doc.entities.push({type:'line',layer:'Walls',p1:[0,0],p2:[100,0],id:'a'},{type:'line',layer:'Walls',p1:[50,-10],p2:[50,10],id:'b'}); s.trimPick=null; s.trimHover=null; return 'ok'; })()`);
console.log('ray src:', await q(`rayIntersectSeg.toString()`));
console.log('trimGeom:', await q(`JSON.stringify(window.__ak.trimGeom(window.__ak.state.doc.entities[0], [30,0]))`));
console.log('manual lineEntIsects:', await q(`(()=>{ try { const o=[]; lineEntIsects([0,0],[100,0],window.__ak.state.doc.entities[1],o); return JSON.stringify(o); } catch(e){ return 'ERR '+e.message; } })()`));
process.exit(0);
