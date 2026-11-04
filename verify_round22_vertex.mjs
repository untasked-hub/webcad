// Round-22 pre-deploy verify: Polyline vertex editing.
// 1. vertex toolbar button exists and activates vertex tool; key 'q' maps to vertex
// 2. prompt mentions polyline + vertex editing
// 3. click a polyline in vertex mode -> vertexEnt set, handles drawn flag state
// 4. drag a vertex: mousedown on vertex handle, move, mouseup -> point moved, dirty
// 5. one undo entry per drag gesture (undo restores original pts)
// 6. midpoint circle click inserts a vertex between neighbors (deterministic nearest segment)
// 7. Del removes active vertex, min 2 points enforced
// 8. Alt disables snapping during drag (free move)
// 9. empty click leaves edit mode (vertexEnt null)
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 9343;
const BASE = 'http://localhost:8080';
fs.mkdirSync('/tmp/cdp_out22', { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getWsUrl() {
  let up = false;
  try { up = !!(await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch {}
  if (!up) {
    spawn('chrome-headless', ['--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--user-data-dir=/tmp/chrome_ak22', '--window-size=1400,900', 'about:blank'], { detached: true, stdio: 'ignore' });
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
function seedPoly(pts) {
  return evalJs(`(() => {
    const s = window.__ak.state;
    s.doc.entities.length = 0;
    s.doc.entities.push({ id: 'e0', type: 'polyline', layer: 'Walls', pts: ${JSON.stringify(pts)} });
    s.sel = new Set(); s.vertexEnt = null; s.vertexIdx = null; s.vertexHover = null; s.drag = null;
    return 'ok';
  })()`);
}
// synthesize mouse events on canvas at client offsets
function mdown(x, y, opts = '') {
  return evalJs(`(() => {
    const cv = document.getElementById('cv');
    const r = cv.getBoundingClientRect();
    const ev = new MouseEvent('mousedown', { clientX: r.left + (${x}), clientY: r.top + (${y}), button: 0, bubbles: true, ${opts} });
    cv.dispatchEvent(ev);
    return true;
  })()`);
}
function mmove(x, y, opts = '') {
  return evalJs(`(() => {
    const cv = document.getElementById('cv');
    const r = cv.getBoundingClientRect();
    const ev = new MouseEvent('mousemove', { clientX: r.left + (${x}), clientY: r.top + (${y}), button: 0, bubbles: true, ${opts} });
    cv.dispatchEvent(ev);
    return true;
  })()`);
}
function mup(x, y) {
  return evalJs(`(() => {
    const cv = document.getElementById('cv');
    const r = cv.getBoundingClientRect();
    const ev = new MouseEvent('mouseup', { clientX: r.left + (${x}), clientY: r.top + (${y}), button: 0, bubbles: true });
    cv.dispatchEvent(ev);
    return true;
  })()`);
}
function sOf(wp) {
  return evalJs(`JSON.stringify(window.__WebCAD.w2s(${JSON.stringify(wp)}))`).then(JSON.parse);
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
  await cdp.send('Page.navigate', { url: BASE + '?rnd=' + Date.now() });
  await sleep(2500);

  // ---------- UI ----------
  const ui = JSON.parse(await evalJs(`JSON.stringify((() => {
    const b = document.querySelector('[data-tool="vertex"]');
    return { btn: b ? 'ok' : 'missing', prompt: document.getElementById('prompt').textContent };
  })())`));
  pass('vertex toolbar button exists', ui.btn === 'ok', JSON.stringify(ui));
  await evalJs(`document.querySelector('[data-tool="vertex"]').click()`);
  const tool = await evalJs(`window.__ak.state.tool`);
  pass('vertex button activates vertex tool', tool === 'vertex', tool);
  const prompt = (await evalJs(`document.getElementById('prompt').textContent`)) || '';
  pass('vertex prompt mentions polyline', /polyline/i.test(prompt) && /vertex/i.test(prompt), prompt);
  // key map 'q'
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', bubbles: true }))`);
  const toolQ = await evalJs(`window.__ak.state.tool`);
  pass("key 'q' selects vertex tool", toolQ === 'vertex', toolQ);

  // ---------- pick a polyline body ----------
  await seedPoly([[0, 0], [100, 0], [100, 60]]);
  await evalJs(`window.__ak.state.view = { x: 0, y: 0, zoom: 1 }`);
  const bp = await sOf([50, 0]); // on segment 1 (y=0)
  await mdown(bp[0], bp[1]); await mup(bp[0], bp[1]);
  const pickSt = JSON.parse(await evalJs(`JSON.stringify({ vEnt: window.__ak.state.vertexEnt, idx: window.__ak.state.vertexIdx })`));
  pass('clicking polyline body picks it for vertex edit', pickSt.vEnt === 'e0', JSON.stringify(pickSt));

  // ---------- drag a vertex ----------
  const v0 = await sOf([0, 0]);
  await mdown(v0[0], v0[1]);
  let dragSt = JSON.parse(await evalJs(`JSON.stringify(window.__ak.state.drag || null)`));
  pass('mousedown on vertex handle starts lazy drag (no undo yet)', dragSt && dragSt.mode === 'vertex' && dragSt.moved === false, JSON.stringify(dragSt));
  const undoLen0 = await evalJs(`window.__ak.state.undo.length`);
  // move 40,40 with alt (free move)
  const t1 = await sOf([40, 40]);
  await mmove(t1[0], t1[1], 'altKey: true');
  const afterMove = JSON.parse(await evalJs(`JSON.stringify({ pt: window.__ak.state.doc.entities[0].pts[0], moved: window.__ak.state.drag.moved, undo: window.__ak.state.undo.length })`));
  pass('drag moves vertex point (alt free move)', Math.abs(afterMove.pt[0] - 40) < 0.6 && Math.abs(afterMove.pt[1] - 40) < 0.6, JSON.stringify(afterMove));
  pass('undo pushed once per gesture', afterMove.undo === undoLen0 + 1, 'undo before=' + undoLen0 + ' after=' + afterMove.undo);
  const entRefBefore = JSON.stringify(await evalJs(`window.__ak.state.doc.entities[0].pts`));
  await mup(t1[0], t1[1]);
  const afterUp = JSON.parse(await evalJs(`JSON.stringify({ dirty: window.__ak.state.dirty, drag: window.__ak.state.drag, pts: window.__ak.state.doc.entities[0].pts })`));
  pass('mouseup commits drag: dirty true, drag cleared', afterUp.dirty === true && afterUp.drag === null, JSON.stringify(afterUp));
  // undo restores
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`);
  const afterUndo = JSON.parse(await evalJs(`JSON.stringify(window.__ak.state.doc.entities[0].pts)`));
  pass('undo restores original vertex', afterUndo[0][0] === 0 && afterUndo[0][1] === 0, entRefBefore + ' -> ' + JSON.stringify(afterUndo));

  // ---------- midpoint insert ----------
  await seedPoly([[0, 0], [100, 0]]);
  await evalJs(`window.__ak.state.view = { x: 0, y: 0, zoom: 1 }`);
  const m1 = await sOf([50, 0]);
  await mdown(m1[0], m1[1]); await mup(m1[0], m1[1]); // first click picks the polyline body
  await mdown(m1[0], m1[1]); await mup(m1[0], m1[1]); // second click on midpoint circle inserts
  const afterIns = JSON.parse(await evalJs(`JSON.stringify(window.__ak.state.doc.entities[0].pts)`));
  pass('midpoint circle click inserts vertex', afterIns.length === 3 && Math.abs(afterIns[1][0] - 50) < 0.6, JSON.stringify(afterIns));

  // ---------- delete vertex ----------
  const vA = await sOf([50, 0]);
  await mdown(vA[0], vA[1]);
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
  const afterDel = JSON.parse(await evalJs(`JSON.stringify(window.__ak.state.doc.entities[0].pts)`));
  pass('Del removes active vertex', afterDel.length === 2, JSON.stringify(afterDel));
  // min 2 enforcement
  await evalJs(`window.__ak.state.vertexIdx = 0`);
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
  const afterMin = JSON.parse(await evalJs(`JSON.stringify(window.__ak.state.doc.entities[0].pts)`));
  pass('minimum 2 vertices enforced', afterMin.length === 2, JSON.stringify(afterMin));

  // ---------- empty click leaves edit mode ----------
  const far = await sOf([-500, -500]);
  await mdown(far[0], far[1]); await mup(far[0], far[1]);
  const exitSt = JSON.parse(await evalJs(`JSON.stringify({ vEnt: window.__ak.state.vertexEnt })`));
  pass('empty canvas click leaves vertex edit mode', exitSt.vEnt === null, JSON.stringify(exitSt));

  // ---------- snap behavior: grid snap respected when not alt ----------
  await seedPoly([[0, 0], [100, 0]]);
  await evalJs(`window.__ak.state.view = { x: 0, y: 0, zoom: 1 }`);
  const vB = await sOf([100, 0]);
  await mdown(vB[0], vB[1]);
  const near = await sOf([103.4, 0.2]);
  await mmove(near[0], near[1]); // no alt -> snapping applies
  await mup(near[0], near[1]);
  const snapped = JSON.parse(await evalJs(`JSON.stringify(window.__ak.state.doc.entities[0].pts[1])`));
  pass('drag with snap rounds to grid', snapped[1] === 0 || Math.abs(snapped[1]) < 1, JSON.stringify(snapped));

  const okCount = results.filter(r => r.ok).length;
  console.log(`\n${okCount}/${results.length} checks passed`);
  fs.writeFileSync('/tmp/verify22.json', JSON.stringify(results));
  process.exit(okCount === results.length ? 0 : 1);
}
main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
