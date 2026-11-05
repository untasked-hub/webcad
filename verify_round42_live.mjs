// Round-42 live verify: command bar dispatcher (real DOM via CDP on local server).
// 1. sign up; 2. LINE command creates a line entity; 3. RECTANGLE; 4. CIRCLE;
// 5. MOVE by @dx,dy moves selection; 6. OFFSET entity index dist creates parallel line; 7. history log populated.
// Entities live at state.doc.entities (fields: p1/p2 for lines, type names line/rect/circle).
import { spawn } from 'node:child_process';

const PORT = 9346;
const BASE = 'http://localhost:8080';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = v => (JSON.stringify(v) ?? 'null');
const S = v => (typeof v === 'string' ? JSON.stringify(v.slice(0, 160)) : String(v));

async function getWsUrl() {
  try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) return true; } catch {}
  spawn('chrome-headless', ['--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--user-data-dir=/tmp/chrome_ak42_' + Date.now() + '', '--window-size=1400,900', 'about:blank'], { detached: true, stdio: 'ignore' });
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
async function runCmd(text) {
  await evalJs(`document.getElementById('cmdInput').value = ${JSON.stringify(text)}`);
  await evalJs(`document.getElementById('cmdInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await sleep(400);
}
const getEnts = () => evalJs(`JSON.stringify((window.__ak.state.doc?.entities)||[])`).then(s => JSON.parse(s || '[]'));

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
  await cdp.send('Network.setBypassServiceWorker', {bypass:true});
  await cdp.send('Page.navigate', { url: BASE + '?rnd42=' + Date.now() });
  await sleep(2500);

  const user = 'r42' + Date.now().toString().slice(-6);
  await evalJs(`window.__ak.openAuth('register')`);
  await sleep(300);
  await evalJs(`document.getElementById('authUser').value='${user}';document.getElementById('authPass').value='secret123';1`);
  await evalJs(`window.__ak.submitAuth()`);
  await sleep(1800);
  const who = await evalJs(`window.__ak.currentUser`);
  pass1('signup+session', !!who, J(who));

  // Deterministic fresh drawing: previous preview tests may have persisted hidden/locked layers.
  await evalJs(`window.__ak.state.doc.entities = []; window.__ak.state.doc.layers = [{name:'0', color:'#d9dee7', locked:false, visible:true, lineweight:1}]; window.__ak.state.doc.currentLayer = '0'; window.__ak.state.sel = new Set(); window.__ak.state.undo = []; window.__ak.state.redo = []; 1`);
  const baseN = (await getEnts()).length;

  // LINE command: two points (absolute + relative)
  await runCmd('line 2000,2000 @100,0');
  await runCmd('@0,80');
  let ents = await getEnts();
  const lines = ents.filter(e => e.type === 'line' && (e.p1?.[0] >= 2000));
  const line1 = lines[0];
  pass1('LINE command creates line', !!line1 && line1.p1[0] === 2000 && line1.p1[1] === 2000, J(line1 && line1.p1));

  // RECTANGLE
  await runCmd('rectangle 300,100 @120,80');
  ents = await getEnts();
  const rect = ents.find(e => e.type === 'rect' || e.type === 'rectangle' || (e.type === 'polyline' && e.closed));
  pass1('RECTANGLE command creates rect', !!rect, J(rect));

  // CIRCLE
  await runCmd('circle 500,300 50');
  ents = await getEnts();
  const circ = ents.find(e => e.type === 'circle');
  pass1('CIRCLE command creates circle', !!circ, J(circ));

  // MOVE: select line1 then move by @10,20
  if (!line1) { pass1('MOVE moves line by delta', false, 'no line to select'); }
  else {
    await evalJs(`window.__ak.state.sel = new Set(['${line1.id}']); 1`);
    await runCmd('move @10,20');
    ents = await getEnts();
    const moved = ents.find(e => e.id === line1.id);
    pass1('MOVE moves line by delta', !!moved && moved.p1[0] === line1.p1[0] + 10 && moved.p1[1] === line1.p1[1] + 20 && moved.p2[0] === line1.p2[0] + 10 && moved.p2[1] === line1.p2[1] + 20, J(moved && moved.p1));
    const beforeCopy = ents.length;
    await runCmd('copy @-20,10');
    ents = await getEnts();
    const copy = ents[ents.length - 1];
    pass1('COPY keeps original and translates clone', ents.length === beforeCopy + 1 && copy.id !== line1.id && copy.p1[0] === moved.p1[0] - 20 && copy.p1[1] === moved.p1[1] + 10 && ents.find(e => e.id === line1.id).p1[0] === moved.p1[0]);
    await evalJs(`window.__ak.state.doc.layers[0].locked = true; 1`);
    await runCmd('move @10,10');
    const locked = (await getEnts()).find(e => e.id === copy.id);
    pass1('MOVE respects locked layer', locked.p1[0] === copy.p1[0] && locked.p1[1] === copy.p1[1]);
    await evalJs(`window.__ak.state.doc.layers[0].locked = false; 1`);
  }

  // OFFSET: offset line index of line1 by 20
  if (!line1) { pass1('OFFSET adds entity', false, 'no line'); }
  else {
    const idx = ents.findIndex(e => e.id === line1.id) + 1;
    const nBefore = ents.length;
    await runCmd(`offset ${idx} 20`);
    ents = await getEnts();
    const src = ents.find(e => e.id === line1.id), off = ents[ents.length - 1];
    pass1('OFFSET adds exact parallel line', ents.length === nBefore + 1 && off.p1[0] === src.p1[0] && off.p1[1] === src.p1[1] + 20 && off.p2[1] === src.p2[1] + 20);
    const ci = ents.findIndex(e => e.id === circ.id) + 1;
    await runCmd(`offset ${ci} 15`);
    ents = await getEnts();
    pass1('OFFSET circle changes radius exactly', ents.at(-1).r === 65);
    const validN = ents.length;
    for (const cmd of ['offset 1x 5', 'offset 1.2 5', 'circle 0,0 0', 'line 1,1 1,1', 'line! 0,0 1,1']) await runCmd(cmd);
    pass1('invalid numeric and command forms rejected', (await getEnts()).length === validN);
  }

  // History log populated
  const hist = await evalJs(`document.getElementById('cmdHistory').textContent`);
  pass1('history log populated', typeof hist === 'string' && /LINE|Moved|Offset/i.test(hist) && hist.length > 10, S(hist));

  // Unknown command message
  await runCmd('filletall 1 2');
  const hist2 = await evalJs(`document.getElementById('cmdHistory').textContent`);
  pass1('unknown command reported', typeof hist2 === 'string' && /unknown/i.test(hist2), S(hist2 && hist2.slice(-120)));

  console.log(pass === 0 ? 'NO CHECKS' : (fail === 0 ? `ALL ${pass} LIVE CHECKS PASSED` : fail + ' live failures'));
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.log('FAIL harness: ' + (e && e.message)); process.exit(1); });
