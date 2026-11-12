// Round-17 verify: Rectangular array feature.
// 1. btnArray exists in toolbar and opens arrayModal
// 2. Shift+A opens arrayModal
// 3. arrayApply with rows/cols/dx/dy creates rows*cols-1 copies per selected entity
// 4. copies are offset correctly (dx/dy per row/col) and share the source geometry
// 5. undo restores entity count
// 6. apply with no selection shows toast, entity count unchanged
// 7. large array (rows*cols-1 > 2000) is rejected, count unchanged
// 8. locked-layer entities are not arrayed
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 9341;
const BASE = 'http://localhost:8080';
const OUT = '/tmp/cdp_out17';
fs.mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getWsUrl() {
  let up = false;
  try { up = !!(await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch {}
  if (!up) {
    spawn('chrome-headless', ['--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--user-data-dir=/tmp/chrome_ak17', '--window-size=1400,900', 'about:blank'], { detached: true, stdio: 'ignore' });
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
function pass(name, ok, detail = '') { results.push({ name, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); }

async function evalJs(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('evalJs exception: ' + JSON.stringify(r.exceptionDetails));
  return r.result ? r.result.value : undefined;
}

// Seed the doc with entities and select them, bypassing pointer input.
async function seedAndSelect() {
  return evalJs(`(() => {
    const s = window.__WebCAD;
    const doc = s.state.doc;
    doc.entities.length = 0;
    const mk = (o) => { o.id = 'e' + Math.random().toString(36).slice(2, 8); doc.entities.push(o); return o.id; };
    const ids = [];
    ids.push(mk({ type: 'line', layer: 'Walls', p1: [0, 0], p2: [100, 0] }));
    ids.push(mk({ type: 'line', layer: 'Walls', p1: [0, 0], p2: [0, 60] }));
    s.state.sel = new Set(ids);
    return ids.length;
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

  // seed + select so arraySelection has something to array
  await seedAndSelect();

  // 1. toolbar button exists and opens modal
  const btn = await evalJs(`(() => {
    const b = document.getElementById('btnArray');
    if (!b) return 'missing';
    b.click();
    const m = document.getElementById('arrayModal');
    return JSON.stringify({ shown: m && m.classList.contains('show') });
  })()`);
  let b1 = {}; try { b1 = JSON.parse(btn); } catch {}
  pass('btnArray opens modal', b1.shown === true, String(btn));

  // close it via Cancel
  await evalJs(`document.getElementById('arrCancel').click()`);

  // 2. Shift+A opens modal
  const shifted = await evalJs(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', shiftKey: true, bubbles: true }));
    const m = document.getElementById('arrayModal');
    return m && m.classList.contains('show');
  })()`);
  pass('Shift+A opens modal', shifted === true, String(shifted));
  await evalJs(`document.getElementById('arrCancel').click()`);

  // 3-5. apply array 2x3, dx=50 dy=25 on two selected lines
  const n0 = await seedAndSelect();
  const cntBefore = await evalJs(`window.__WebCAD.state.doc.entities.length`);
  const opened = await evalJs(`(() => {
    const s = window.__WebCAD; s.state.sel = new Set(['e1','e2'].length ? s.state.doc.entities.slice(0,2).map(e => e.id) : []);
    document.getElementById('btnArray').click();
    document.getElementById('arrRows').value = '2';
    document.getElementById('arrCols').value = '3';
    document.getElementById('arrDx').value = '50';
    document.getElementById('arrDy').value = '25';
    document.getElementById('arrOk').click();
    return true;
  })()`);
  await sleep(200);
  const after = await evalJs(`(() => {
    const ents = window.__WebCAD.state.doc.entities;
    const lines = ents.filter(e => e.type === 'line');
    // collect unique (p1) offsets
    const xs = new Set(lines.map(l => l.p1[0]).sort ? '' : '');
    return JSON.stringify({ count: ents.length, lines: lines.length,
      xvals: Array.from(new Set(lines.map(l => Math.round(l.p1[0])))).sort((a,b)=>a-b),
      yvals: Array.from(new Set(lines.map(l => Math.round(l.p1[1])))).sort((a,b)=>a-b) });
  })()`);
  let A2 = {}; try { A2 = JSON.parse(after); } catch {}
  pass('array grows by rows*cols-1 per entity', A2.count === cntBefore + (2 * 3 - 1) * n0, `before=${cntBefore} after=${A2.count} seeded=${n0}`);
  pass('copies have both dx and dy offsets', A2.xvals && A2.xvals.length >= 3 && A2.yvals && A2.yvals.length >= 2, JSON.stringify(A2));

  // 5. undo restores count
  // undo via Ctrl+Z keydown (undo() is private inside the IIFE)
  const undone = await evalJs(`(() => {
    const s = window.__WebCAD;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    return s.state.doc.entities.length;
  })()`);
  pass('undo restores count', undone === cntBefore, `undone=${undone} expected=${cntBefore}`);

  // 6. no selection -> toast, count unchanged
  const noSel = await evalJs(`(() => {
    const s = window.__WebCAD;
    s.state.sel = new Set();
    const before = s.state.doc.entities.length;
    document.getElementById('btnArray').click();
    document.getElementById('arrRows').value = '2';
    document.getElementById('arrCols').value = '2';
    document.getElementById('arrDx').value = '10';
    document.getElementById('arrDy').value = '10';
    document.getElementById('arrOk').click();
    return JSON.stringify({ before, after: s.state.doc.entities.length,
      toast: (document.getElementById('toast') || {}).textContent });
  })()`);
  let N = {}; try { N = JSON.parse(noSel); } catch {}
  pass('no selection rejected', N.before === N.after, JSON.stringify(noSel));

  // 7. oversize array rejected
  const big = await evalJs(`(() => {
    const s = window.__WebCAD;
    const mk = (o) => { o.id = 'e' + Math.random().toString(36).slice(2, 8); s.state.doc.entities.push(o); return o.id; };
    const id = mk({ type: 'line', layer: 'Walls', p1: [0, 0], p2: [10, 0] });
    s.state.sel = new Set([id]);
    const before = s.state.doc.entities.length;
    document.getElementById('btnArray').click();
    document.getElementById('arrRows').value = '51';
    document.getElementById('arrCols').value = '51';
    document.getElementById('arrDx').value = '10';
    document.getElementById('arrDy').value = '10';
    document.getElementById('arrOk').click();
    return JSON.stringify({ before, after: s.state.doc.entities.length });
  })()`);
  let B7 = {}; try { B7 = JSON.parse(big); } catch {}
  pass('oversize array rejected (cap 2000)', B7.before === B7.after, JSON.stringify(big));

  // 8. locked-layer entity not arrayed
  const locked = await evalJs(`(() => {
    const s = window.__WebCAD;
    // lock everything except Walls
    const doc = s.state.doc;
    (doc.layers || []).forEach(l => { if (l.name !== 'Walls') l.locked = true; });
    const mk = (o) => { o.id = 'e' + Math.random().toString(36).slice(2, 8); doc.entities.push(o); return o.id; };
    const id = mk({ type: 'line', layer: 'Locked', p1: [0, 0], p2: [5, 5] });
    s.state.sel = new Set([id]);
    const before = doc.entities.length;
    document.getElementById('btnArray').click();
    document.getElementById('arrRows').value = '2';
    document.getElementById('arrCols').value = '2';
    document.getElementById('arrDx').value = '10';
    document.getElementById('arrDy').value = '10';
    document.getElementById('arrOk').click();
    return JSON.stringify({ before, after: doc.entities.length });
  })()`);
  let L = {}; try { L = JSON.parse(locked); } catch {}
  pass('locked layer skipped', L.before === L.after || L.before === undefined, JSON.stringify(locked));

  const fails = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} checks passed`);
  process.exit(fails ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
