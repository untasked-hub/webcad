// Round-18 pre-build verify: Polar array feature.
// 1. btnArrayPolar exists and opens polarModal
// 2. Shift+P opens polarModal
// 3. full-circle default (blank angle) with count=6 creates 5 rotated copies of a line about selection bbox center
// 4. explicit angle step (count=4, step=90) creates 3 copies
// 5. undo restores count
// 6. no selection -> toast, count unchanged
// 7. count<2 or step=0 rejected
// 8. locked-layer entities skipped
// 9. large array rejected (cap 2000)
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 9342;
const BASE = 'http://localhost:8080';
fs.mkdirSync('/tmp/cdp_out18', { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getWsUrl() {
  let up = false;
  try { up = !!(await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch {}
  if (!up) {
    spawn('chrome-headless', ['--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--user-data-dir=/tmp/chrome_ak18', '--window-size=1400,900', 'about:blank'], { detached: true, stdio: 'ignore' });
  }
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      if (j.webSocketDebuggerUrl) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new Cdp(ws); c.ws = ws;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.pending.has(m.id)) { c.pending.get(m.id)(m); c.pending.delete(m.id); }
    };
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
const results = [];
function pass(name, ok, detail = '') { results.push({ name, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); }

async function evalJs(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('evalJs exception: ' + JSON.stringify(r.exceptionDetails));
  return r.result ? r.result.value : undefined;
}

async function seedOneLine() {
  return evalJs(`(() => {
    const s = window.__WebCAD;
    const doc = s.state.doc;
    doc.entities.length = 0;
    const id = 'e' + Math.random().toString(36).slice(2, 8);
    doc.entities.push({ id, type: 'line', layer: 'Walls', p1: [0, 0], p2: [100, 0] });
    s.state.sel = new Set([id]);
    return doc.entities.length;
  })()`);
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
  if (!pageWs) { console.log('FAIL setup: no page target'); process.exit(1); }
  cdp = await Cdp.connect(pageWs);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: BASE });
  await sleep(2500);

  // 1. toolbar button opens modal (needs a selection first)
  await seedOneLine();
  const btn = await evalJs(`(() => {
    const b = document.getElementById('btnArrayPolar');
    if (!b) return 'missing';
    b.click();
    return JSON.stringify({ shown: document.getElementById('polarModal').classList.contains('show') });
  })()`);
  let B = {}; try { B = JSON.parse(btn); } catch {}
  pass('btnArrayPolar opens polarModal', B.shown === true, String(btn));
  await evalJs(`document.getElementById('polCancel').click()`);

  // 2. Shift+P opens modal
  const shifted = await evalJs(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', shiftKey: true, bubbles: true }));
    return document.getElementById('polarModal').classList.contains('show');
  })()`);
  pass('Shift+P opens polarModal', shifted === true, String(shifted));
  await evalJs(`document.getElementById('polCancel').click()`);

  // 3. full-circle default: count 6, blank angle -> 5 copies rotated 60 deg about bbox center (50, 0)
  await seedOneLine();
  const cntBefore = await evalJs(`window.__WebCAD.state.doc.entities.length`);
  await evalJs(`(() => {
    document.getElementById('btnArrayPolar').click();
    document.getElementById('polCount').value = '6';
    document.getElementById('polAngle').value = '';
    document.getElementById('polOk').click();
    return true;
  })()`);
  await sleep(200);
  const geo = await evalJs(`(() => {
    const lines = window.__WebCAD.state.doc.entities.filter(e => e.type === 'line');
    return JSON.stringify({ n: lines.length, angles: lines.map(l => Math.round(Math.atan2(l.p1[1] - 0, l.p1[0] - 50) * 180 / Math.PI)) });
  })()`);
  let G = {}; try { G = JSON.parse(geo); } catch {}
  pass('full-circle default adds 5 copies', G.n === 6, JSON.stringify(geo));
  // atan2 maps 180deg to 180 (not -180); normalise to a signed 180-wrap set
  const norm = a => a === 180 ? -180 : a;
  const expected = [-180, -120, -60, 0, 60, 120];
  pass('copies at 60-degree steps about bbox center', G.angles && [...G.angles].map(norm).sort((a, b) => a - b).join(',') === expected.join(','), JSON.stringify(geo));

  // 4. undo restores count
  const undone = await evalJs(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    return window.__WebCAD.state.doc.entities.length;
  })()`);
  pass('undo restores count', undone === cntBefore, `undone=${undone} expected=${cntBefore}`);

  // 5. explicit step: count=4, step=90
  await seedOneLine();
  const before4 = await evalJs(`window.__WebCAD.state.doc.entities.length`);
  await evalJs(`(() => {
    document.getElementById('btnArrayPolar').click();
    document.getElementById('polCount').value = '4';
    document.getElementById('polAngle').value = '90';
    document.getElementById('polOk').click();
    return true;
  })()`);
  const after4 = await evalJs(`window.__WebCAD.state.doc.entities.length`);
  pass('count=4 step=90 adds 3 copies', after4 === before4 + 3, `before=${before4} after=${after4}`);
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));`);

  // 6. no selection -> toast, count unchanged
  await evalJs(`window.__WebCAD.state.sel = new Set();`);
  const noSel = await evalJs(`(() => {
    const s = window.__WebCAD;
    const before = s.state.doc.entities.length;
    document.getElementById('btnArrayPolar').click();
    const shown = document.getElementById('polarModal').classList.contains('show');
    return JSON.stringify({ before, after: s.state.doc.entities.length, shown, toast: document.getElementById('toast').textContent });
  })()`);
  let N = {}; try { N = JSON.parse(noSel); } catch {}
  pass('no selection rejected (toast, no modal)', N.before === N.after && N.shown === false && /Select/.test(N.toast || ''), JSON.stringify(noSel));

  // 7. invalid inputs rejected
  await seedOneLine();
  const bad = await evalJs(`(() => {
    const s = window.__WebCAD;
    const results = [];
    const before = s.state.doc.entities.length;
    document.getElementById('btnArrayPolar').click();
    document.getElementById('polCount').value = '1';
    document.getElementById('polAngle').value = '';
    document.getElementById('polOk').click();
    results.push({ t1: document.getElementById('toast').textContent, after: s.state.doc.entities.length });
    document.getElementById('btnArrayPolar').click();
    document.getElementById('polCount').value = '5';
    document.getElementById('polAngle').value = '0';
    document.getElementById('polOk').click();
    results.push({ t2: document.getElementById('toast').textContent, after2: s.state.doc.entities.length });
    return JSON.stringify({ before, r: results });
  })()`);
  let BAD = {}; try { BAD = JSON.parse(bad); } catch {}
  const unchanged = BAD.before === BAD.r?.[0]?.after && BAD.before === BAD.r?.[1]?.after2;
  pass('count=1 and step=0 rejected with toast', unchanged && /at least 2/.test(BAD.r?.[0]?.t1 || '') && /non-zero/.test(BAD.r?.[1]?.t2 || ''), JSON.stringify(bad));

  // 8. locked layer skipped
  const locked = await evalJs(`(() => {
    const s = window.__WebCAD;
    const doc = s.state.doc;
    (doc.layers || []).forEach(l => { if (l.name !== 'Walls') l.locked = true; });
    const id = 'e' + Math.random().toString(36).slice(2, 8);
    doc.entities.push({ id, type: 'line', layer: 'Nope', p1: [0, 0], p2: [5, 5] });
    if (!doc.entities.some(e => e.layer === 'Nope' && false)) {} // noop
    (doc.layers || []).forEach(l => { if (l.name === 'Nope') l.locked = true; });
    s.state.sel = new Set(doc.entities.map(e => e.id));
    const before = doc.entities.length;
    document.getElementById('btnArrayPolar').click();
    document.getElementById('polCount').value = '3';
    document.getElementById('polAngle').value = '';
    document.getElementById('polOk').click();
    return JSON.stringify({ before, after: doc.entities.length });
  })()`);
  let L = {}; try { L = JSON.parse(locked); } catch {}
  // only the Walls entity is arrayable: (3-1) copies x 1 entity = +2
  pass('locked-layer entity skipped', L.before !== undefined && L.after === L.before + 2, JSON.stringify(locked));

  // 9. oversize rejected
  const big = await evalJs(`(() => {
    const s = window.__WebCAD;
    s.state.doc.entities.length = 0;
    const id = 'e' + Math.random().toString(36).slice(2, 8);
    s.state.doc.entities.push({ id, type: 'line', layer: 'Walls', p1: [0, 0], p2: [10, 0] });
    s.state.sel = new Set([id]);
    const before = s.state.doc.entities.length;
    document.getElementById('btnArrayPolar').click();
    document.getElementById('polCount').value = '2002';
    document.getElementById('polAngle').value = '';
    document.getElementById('polOk').click();
    return JSON.stringify({ before, after: s.state.doc.entities.length, toast: document.getElementById('toast').textContent });
  })()`);
  let BG = {}; try { BG = JSON.parse(big); } catch {}
  pass('oversize polar array rejected (cap 2000)', BG.before === BG.after, JSON.stringify(big));

  const fails = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} checks passed`);
  process.exit(fails ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
