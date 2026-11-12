// minimal CDP check: setup register fetch, print raw evaluate response
const url = (process.argv[2] || 'http://localhost:8080').replace(/\/$/, '');
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ver = await (await fetch(CDP_HTTP + '/json/version')).json();
const w = new WebSocket(ver.webSocketDebuggerUrl); await new Promise(r => w.onopen = r);
let id = 0, h = {}; w.onmessage = m => { const d = JSON.parse(m.data); if (d.id && h[d.id]) { h[d.id](d); delete h[d.id]; } };
const send = (m, p = {}, s) => new Promise(res => { h[++id] = res; w.send(JSON.stringify({ id, method: m, params: p, sessionId: s })) });
const cr = await send('Target.createTarget', { url: 'about:blank' });
console.log('cr', JSON.stringify(cr).slice(0, 300));
const at = await send('Target.attachToTarget', { targetId: cr.result.targetId, flatten: true });
console.log('at', JSON.stringify(at).slice(0, 300));
const SID = at.result.sessionId;
await send('Runtime.enable', {}, SID); await send('Page.enable', {}, SID);
const r = await send('Page.navigate', { url: url + '/' }, SID); await sleep(2000);
console.log('nav', JSON.stringify(r).slice(0, 200));
const raw = await send('Runtime.evaluate', { expression: `(async()=>{const u='rc'+Math.random().toString(36).slice(2,8);const r=await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:'passw0rd-1234'})});const t=await r.text();return JSON.stringify({s:r.status,t:t.slice(0,200)});})()`, returnByValue: true, awaitPromise: true }, SID);
console.log('raw', JSON.stringify(raw).slice(0, 800));
