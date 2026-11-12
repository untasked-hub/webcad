// Round-42 live verify: command bar dispatcher (real DOM via CDP on local server).
// 1. sign up; 2. LINE command creates a line entity; 3. RECTANGLE; 4. CIRCLE;
// 5. MOVE by @dx,dy moves selection; 6. OFFSET entity index dist creates parallel line; 7. history log populated.
// Entities live at state.doc.entities (fields: p1/p2 for lines, type names line/rect/circle).
import { spawn } from 'node:child_process';

const PORT = 9347;
const BASE = 'http://localhost:8080';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = v => (JSON.stringify(v) ?? 'null');
const S = v => (typeof v === 'string' ? JSON.stringify(v.slice(0, 160)) : String(v));

async function getWsUrl() {
  try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) return true; } catch {}
  spawn('chrome-headless', ['--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--user-data-dir=/tmp/chrome_ak43_' + Date.now() + '', '--window-size=1400,900', 'about:blank'], { detached: true, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) return true; } catch {}
    await sleep(500);
  }
  return false;
}
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new Cdp(ws);
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && c.pending.has(m.id)) { c.pending.get(m.id)(m); c.pending.delete(m.id); } };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, (m) => m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}
let cdp = null;
let pass = 0, fail = 0;
function pass1(name, ok, detail = '') { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); }
async function evalJs(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('evalJs: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result ? r.result.value : undefined;
}

async function main() {
  if (!(await getWsUrl())) { console.log('FAIL setup: no debug port'); process.exit(1); }
  let pageWs = null;
  for (let i = 0; i < 20; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const page = targets.find(t => t.type === 'page');
    if (page) { pageWs = page.webSocketDebuggerUrl; break; }
    await sleep(500);
  }
  cdp = await Cdp.connect(pageWs);
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', {cacheDisabled:true});
  await cdp.send('Page.navigate', { url: BASE + '?rnd43=' + Date.now() });
  await sleep(2500);

  pass1('health.js loaded', await evalJs(`typeof window.AutoKadHealth === 'object' && typeof window.AutoKadHealth.analyze === 'function'`));
  pass1('Health button present', await evalJs(`!!document.getElementById('btnHealth')`));

  await evalJs(`(function(){const s=window.__ak.state;
    s.doc.layers=[{name:'0',color:'#d9dee7',visible:true,locked:false,lineweight:1},{name:'Walls',color:'#7fd1ff',visible:true,locked:false,lineweight:2},{name:'Spare',color:'#aaa',visible:true,locked:false,lineweight:1}];
    s.doc.entities=[
      {id:'h1',type:'line',layer:'Walls',p1:[0,0],p2:[100,0]},
      {id:'h2',type:'line',layer:'Walls',p1:[100,0],p2:[0,0]},
      {id:'h3',type:'line',layer:'Walls',p1:[50,50],p2:[50,50]},
      {id:'h4',type:'rect',layer:'Walls',p1:[0,0],p2:[100,80]},
      {id:'h5',type:'circle',layer:'0',c:[9000,9000],r:10}];
    s.doc.currentLayer='Walls'; s.sel=new Set(); return 1;})()`);
  const before = await evalJs(`JSON.stringify(window.__ak.state.doc.entities)`);

  await evalJs(`document.getElementById('btnHealth').click()`);
  await sleep(400);
  pass1('modal opens', await evalJs(`document.getElementById('healthModal').classList.contains('show')`));
  const rows = await evalJs(`Array.from(document.querySelectorAll('#healthIssues .health-issue')).map(r=>r.textContent)`);
  pass1('duplicate flagged', rows.some(t => /identical line/.test(t)), J(rows));
  pass1('zero-length flagged', rows.some(t => /Zero-length line/.test(t)));
  pass1('isolated circle flagged', rows.some(t => /sits away/.test(t)));
  pass1('empty layer flagged', rows.some(t => /"Spare" has no objects/.test(t)));
  const sumTxt = await evalJs(`document.getElementById('healthSummary').textContent`);
  pass1('summary shows counts', /5\s*objects/.test(sumTxt), S(sumTxt));

  // click duplicate row -> selects h1,h2
  await evalJs(`Array.from(document.querySelectorAll('#healthIssues .health-issue')).find(r=>/identical/.test(r.textContent)).click()`);
  await sleep(300);
  const sel = await evalJs(`JSON.stringify([...window.__ak.state.sel].sort())`);
  pass1('clicking issue selects its objects', sel === '["h1","h2"]', sel);

  const rep = await evalJs(`JSON.stringify(window.__ak.healthReport())`);
  const r = JSON.parse(rep);
  pass1('JSON report format', r.format === 'AutoKadHealth' && r.version === 1 && r.report.summary.entities === 5, S(rep));
  const after = await evalJs(`JSON.stringify(window.__ak.state.doc.entities)`);
  pass1('analysis does not modify drawing', before === after);

  // clean drawing
  await evalJs(`(function(){const s=window.__ak.state; s.doc.layers=[{name:'0',color:'#ddd',visible:true,locked:false,lineweight:1}]; s.doc.entities=[{id:'c1',type:'line',layer:'0',p1:[0,0],p2:[10,0]},{id:'c2',type:'circle',layer:'0',c:[0,0],r:5}]; return 1;})()`);
  await evalJs(`document.getElementById('healthRerun').click()`);
  await sleep(300);
  const cleanTxt = await evalJs(`document.getElementById('healthSummary').textContent`);
  pass1('clean drawing reports no issues', /No issues found/.test(cleanTxt), S(cleanTxt));

  await evalJs(`document.getElementById('healthClose').click()`);
  await sleep(200);
  pass1('modal closes', !(await evalJs(`document.getElementById('healthModal').classList.contains('show')`)));

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.log('FAIL fatal ' + e.message); process.exit(1); });
