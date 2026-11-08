// Round-23 live HUD verification (real DOM + real mouse events via CDP).
// Checks:
// 1. HUD overlay is pointer-events:none (computed style) and does not steal canvas clicks
// 2. drawing a line: after first click the measure row appears and L/A/Δ track the cursor
//    - L equals distance from last pending point (within rounding), A in 0..360, Δ = dx,dy
// 3. move mode: row shows grab-point delta from drag base, not absolute position
// 4. readout is display-only: doc model & undo length unchanged by hovering
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 9344;
const BASE = 'http://localhost:8080';
fs.mkdirSync('/tmp/cdp_out23', { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getWsUrl() {
  try {
    const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    if (j.webSocketDebuggerUrl) return true;
  } catch {}
  spawn('chrome-headless', ['--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--user-data-dir=/tmp/chrome_ak23b', '--window-size=1400,900', 'about:blank'], { detached: true, stdio: 'ignore' });
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
    const c = new Cdp(ws);
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
  if (r.exceptionDetails) throw new Error('evalJs: ' + JSON.stringify(r.exceptionDetails));
  return r.result ? r.result.value : undefined;
}
function mouse(type, x, y, opts = '') {
  return evalJs(`(() => {
    const cv = document.getElementById('cv');
    const r = cv.getBoundingClientRect();
    cv.dispatchEvent(new MouseEvent('${type}', { clientX: r.left + (${x}), clientY: r.top + (${y}), button: 0, bubbles: true, ${opts} }));
    return true;
  })()`);
}
function sOf(wp) { return evalJs(`JSON.stringify(window.__WebCAD.w2s(${JSON.stringify(wp)}))`).then(JSON.parse); }
const hud = () => evalJs(`JSON.stringify((() => {
  const row = document.getElementById('hud-measure');
  return {
    shown: !!row && getComputedStyle(row).display !== 'none',
    L: document.getElementById('hl').textContent,
    A: document.getElementById('ha').textContent,
    D: document.getElementById('hd').textContent,
    pe: getComputedStyle(document.getElementById('hud')).pointerEvents
  };
})())`).then(JSON.parse);

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
  await cdp.send('Page.navigate', { url: BASE + '?rnd=' + Date.now() });
  await sleep(2500);

  // no login needed for a local blank doc; make sure a doc exists
  await evalJs(`(() => { const s = window.__ak.state; s.doc.entities.length = 0; s.sel = new Set(); s.pending = []; s.drag = null; s.undo.length = 0; return 1; })()`);

  const h0 = await hud();
  pass('HUD overlay pointer-events:none (computed)', h0.pe === 'none', h0.pe);

  // ---- draw a line: first click sets anchor, HUD appears and tracks cursor ----
  await evalJs(`document.querySelector('[data-tool="line"]').click()`);
  await evalJs(`window.__ak.state.view = { x: 0, y: 0, zoom: 1 }`);
  const a = await sOf([0, 0]);
  await mouse('mousemove', a[0], a[1]);
  await mouse('mousedown', a[0], a[1]); await mouse('mouseup', a[0], a[1]);
  const pend = await evalJs(`window.__ak.state.pending.length`);
  pass('line tool has one pending point after first click', pend === 1, 'pending=' + pend);

  const b = await sOf([100, 0]);
  await mouse('mousemove', b[0], b[1]);
  await sleep(120); // let rAF flush
  const h1 = await hud();
  pass('measure row shown while drawing', h1.shown === true, JSON.stringify(h1));
  const L1 = parseFloat(h1.L), A1 = parseFloat(h1.A), D1 = (h1.D || '').split(',').map(s => parseFloat(s));
  pass('L shows 100 for horizontal 100-unit segment', Math.abs(L1 - 100) < 0.6, 'L=' + h1.L);
  pass('A shows 0° for +x direction', Math.abs(A1) < 0.6 || Math.abs(A1 - 360) < 0.6, 'A=' + h1.A);
  pass('Δ shows dx,dy = 100, 0', D1.length === 2 && Math.abs(D1[0] - 100) < 0.6 && Math.abs(D1[1]) < 0.6, h1.D);

  // vertical second leg: angle 90
  const c = await sOf([0, 60]);
  await mouse('mousemove', c[0], c[1]);
  await sleep(120);
  const h2 = await hud();
  const A2 = parseFloat(h2.A);
  pass('A updates to 90° for +y direction', Math.abs(A2 - 90) < 0.6, h2.A);
  pass('L updates to 60 on the new cursor position', Math.abs(parseFloat(h2.L) - 60) < 0.6, h2.L);

  // escape out of the draw
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(60);
  await evalJs(`document.querySelector('[data-tool="select"]').click()`);
  await mouse('mousemove', c[0], c[1]);
  await sleep(120);
  const h3 = await hud();
  pass('measure row hidden when nothing pending / not dragging', h3.shown === false, JSON.stringify(h3));

  // ---- move mode: delta from grab point ----
  await evalJs(`(() => {
    const s = window.__ak.state;
    s.doc.entities.length = 0;
    s.doc.entities.push({ id: 'r0', type: 'line', layer: '0', p1: [0, 0], p2: [40, 0] });
    s.view = { x: 0, y: 0, zoom: 1 };
    s.sel = new Set(['r0']);
    s.undo.length = 0;
    document.querySelector('[data-tool="move"]').click();
    return 1;
  })()`);
  const g1 = await sOf([20, 0]); // grab on the line body
  await mouse('mousemove', g1[0], g1[1]);
  await mouse('mousedown', g1[0], g1[1]);
  const dragOk = await evalJs(`!!(window.__ak.state.drag && window.__ak.state.drag.mode==='move')`);
  pass('move drag started from grab point', dragOk === true, 'drag=' + dragOk);
  const undoBefore = await evalJs(`window.__ak.state.undo.length`);
  const g2 = await sOf([60, 20]);
  await mouse('mousemove', g2[0], g2[1]);
  await sleep(120);
  const h4 = await hud();
  const D4 = (h4.D || '').split(',').map(s => parseFloat(s));
  pass('move mode shows row', h4.shown === true, JSON.stringify(h4));
  pass('move Δ is grab-relative (40,20) not absolute (60,20)', D4.length === 2 && Math.abs(D4[0] - 40) < 1.5 && Math.abs(D4[1] - 20) < 1.5, h4.D);
  const undoAfter = await evalJs(`window.__ak.state.undo.length`);
  pass('hover does not push undo entries', undoAfter === undoBefore, undoBefore + ' -> ' + undoAfter);
  await mouse('mouseup', g2[0], g2[1]);
  await sleep(80);
  const h5 = await hud();
  pass('row hidden after mouseup', h5.shown === false, JSON.stringify(h5));

  // ---- canvas clicks still land while overlay visible (pointer-events none) ----
  await evalJs(`document.querySelector('[data-tool="select"]').click()`);
  const l0 = await sOf([10, 0]);
  await mouse('mousedown', l0[0], l0[1]); await mouse('mouseup', l0[0], l0[1]);
  const selCount = await evalJs(`window.__ak.state.sel.size`);
  pass('click selects entity with HUD overlay present', selCount === 1, 'sel=' + selCount);

  const fails = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - fails} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
main().catch(e => { console.log('FATAL', e.message); process.exit(1); });
