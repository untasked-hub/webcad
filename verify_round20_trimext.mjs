// Round-20 pre-build verify: Trim & Extend.
// 1. toolbar buttons exist and activate trim/extend tools
// 2. prompts correct for trim/extend
// 3. trimGeom pure: line [0,0]-[100,0], boundary vertical line x=50; pick near x=30 -> cut at 50, keep left side
// 4. trim other side: pick near x=70 -> cut at 50
// 5. no-boundary fallback: nearest crossing entity works (state.trimPick=null)
// 6. no crossing -> null
// 7. applyExtend pure: line [0,0]-[40,0], boundary x=100 -> newEnd [100,0]
// 8. extend wrong direction (boundary behind) -> null
// 9. extend polyline (2-pt) endpoint works
// 10. applyTrim result shape: remove=hit, add is line kept-end->cut
// 11. mousedown flow: trim first click sets boundary, second click trims (undo-able)
// 12. mousedown extend flow extends via UI
// 13. circle boundary: extend ray to circle hit point
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 9342;
const BASE = 'http://localhost:8080';
fs.mkdirSync('/tmp/cdp_out20', { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getWsUrl() {
  let up = false;
  try { up = !!(await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch {}
  if (!up) {
    spawn('chrome-headless', ['--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--user-data-dir=/tmp/chrome_ak20', '--window-size=1400,900', 'about:blank'], { detached: true, stdio: 'ignore' });
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

// seed a doc and return entity ids; takes [[type, ...args], ...]
function seed(ents) {
  return evalJs(`(() => {
    const s = window.__ak.state;
    s.doc.entities.length = 0;
    const mk = (o, i) => { o.id = 'e' + i; s.doc.entities.push(o); };
    const spec = ${JSON.stringify(ents)};
    spec.forEach((sp, i) => {
      const [type, a, b, c] = sp;
      if (type === 'line') mk({ type: 'line', layer: 'Walls', p1: a, p2: b }, i);
      else if (type === 'rect') mk({ type: 'rect', layer: 'Walls', p1: a, p2: b }, i);
      else if (type === 'circle') mk({ type: 'circle', layer: '0', c: a, r: b }, i);
      else if (type === 'polyline') mk({ type: 'polyline', layer: 'Walls', pts: a }, i);
      else if (type === 'arc') mk({ type: 'arc', layer: 'Walls', c: a, r: b, a0: c[0], a1: c[1] }, i);
    });
    s.sel = new Set();
    s.trimPick = null;
    s.trimHover = null;
    return JSON.stringify(s.doc.entities.map(e => e.id));
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
  await cdp.send('Page.navigate', { url: BASE + '?rnd=' + Date.now() });
  await sleep(2500);

  // ---------- UI ----------
  const ui = JSON.parse(await evalJs(`JSON.stringify((() => {
    const b = document.querySelector('[data-tool="trim"]');
    const e = document.querySelector('[data-tool="extend"]');
    return { trimBtn: b ? 'ok' : 'missing', extendBtn: e ? 'ok' : 'missing', tool: window.__ak.state.tool };
  })())`));
  pass('trim/extend buttons exist', ui.trimBtn !== 'missing' && ui.extendBtn !== 'missing', JSON.stringify(ui));
  await evalJs(`document.querySelector('[data-tool="trim"]').click()`);
  pass('trim button activates trim tool', (await evalJs(`window.__ak.state.tool`)) === 'trim');
  pass('trim prompt set', ((await evalJs(`document.getElementById('prompt').textContent`)) || '').toLowerCase().includes('boundary'));
  await evalJs(`document.querySelector('[data-tool="extend"]').click()`);
  pass('extend button activates extend tool', (await evalJs(`window.__ak.state.tool`)) === 'extend');

  // ---------- pure geometry: trim ----------
  await seed([['line', [0, 0], [100, 0]], ['line', [50, -10], [50, 10]]]);
  await evalJs(`window.__ak.state.trimPick = null`);

  const r1 = JSON.parse(await evalJs(`JSON.stringify(window.__ak.trimGeom(window.__ak.state.doc.entities[0], [30, 0]))`));
  pass('trimGeom left side cut at x=50', r1 && Math.abs(r1.cut[0] - 50) < 1e-6 && Math.abs(r1.cut[1]) < 1e-6, JSON.stringify(r1));

  const r2 = JSON.parse(await evalJs(`JSON.stringify(window.__ak.applyTrim(window.__ak.state.doc.entities[0], [70, 0]))`));
  pass('applyTrim right side keeps right run', r2 && Math.abs(r2.cut[0] - 50) < 1e-6 &&
    Math.abs(r2.keptEnd[0] - 100) < 1e-6, JSON.stringify(r2));

  const r3 = JSON.parse(await evalJs(`JSON.stringify(window.__ak.trimGeom(window.__ak.state.doc.entities[0], [30, 0]))`));
  pass('trimGeom with no boundary set uses nearest crossing', r3 && Math.abs(r3.cut[0] - 50) < 1e-6, JSON.stringify(r3));

  // set an explicit boundary: trimPick = boundary entity
  const r4 = JSON.parse(await evalJs(`JSON.stringify((() => {
    window.__ak.state.trimPick = window.__ak.state.doc.entities[1];
    const g = window.__ak.trimGeom(window.__ak.state.doc.entities[0], [70, 0]);
    window.__ak.state.trimPick = null;
    return g;
  })())`));
  pass('trimGeom with explicit boundary', r4 && Math.abs(r4.cut[0] - 50) < 1e-6, JSON.stringify(r4));

  // no crossing case: horizontal boundary parallel to target
  await seed([['line', [0, 0], [100, 0]], ['line', [0, 500], [100, 500]]]);
  const r5 = await evalJs(`JSON.stringify(window.__ak.trimGeom(window.__ak.state.doc.entities[0], [30, 0]))`);
  pass('trimGeom no crossing -> null', r5 === 'null', r5);

  // ---------- pure geometry: extend ----------
  await seed([['line', [0, 0], [40, 0]], ['line', [100, -10], [100, 10]]]);
  const e1 = JSON.parse(await evalJs(`JSON.stringify(window.__ak.extendGeom(window.__ak.state.doc.entities[0], [40, 0]))`));
  pass('extendGeom stretches to x=100', e1 && Math.abs(e1.newEnd[0] - 100) < 1e-6 && Math.abs(e1.newEnd[1]) < 1e-6, JSON.stringify(e1));

  const e2 = JSON.parse(await evalJs(`JSON.stringify(window.__ak.applyExtend(window.__ak.state.doc.entities[0], [40, 0]))`));
  pass('applyExtend mutates endpoint to boundary', e2 && Math.abs(window.__ak.state.doc.entities[0].p2[0] - 100) < 1e-6);

  // wrong direction: boundary behind the moving end
  await seed([['line', [0, 0], [40, 0]], ['line', [-100, -10], [-100, 10]]]);
  const e3 = await evalJs(`JSON.stringify(window.__ak.extendGeom(window.__ak.state.doc.entities[0], [40, 0]))`);
  pass('extendGeom boundary behind -> null', e3 === 'null', e3);

  // 2-point polyline target
  await seed([['polyline', [[0, 0], [40, 0]], null], ['line', [100, -10], [100, 10]]]);
  const e4 = JSON.parse(await evalJs(`JSON.stringify(window.__ak.applyExtend(window.__ak.state.doc.entities[0], [40, 0]))`));
  pass('applyExtend polyline endpoint', e4 && Math.abs(window.__ak.state.doc.entities[0].pts[1][0] - 100) < 1e-6);

  // circle boundary
  await seed([['line', [0, 0], [30, 0]], ['circle', [100, 0], 20]]);
  const e5 = JSON.parse(await evalJs(`JSON.stringify(window.__ak.extendGeom(window.__ak.state.doc.entities[0], [30, 0]))`));
  pass('extendGeom to circle boundary at x=80', e5 && Math.abs(e5.newEnd[0] - 80) < 1e-6, JSON.stringify(e5));

  // ---------- UI flow: mousedown trim + extend ----------
  // seed with known world geometry and synthesize canvas mousedown events
  await seed([['line', [0, 0], [100, 0]], ['line', [50, -10], [50, 10]]]);
  await evalJs(`window.__ak.state.sel = new Set()`);
  const vp = JSON.parse(await evalJs(`JSON.stringify((() => {
    const cv = document.getElementById('cv');
    const w = (p) => { const s = window.__WebCAD.w2s(p); return [s[0], s[1]]; };
    const toClient = (wp) => { const [sx, sy] = w(wp); return [Math.round(sx), Math.round(sy)]; };
    return { trim: toClient([30, 0]), boundary: toClient([50, 5]), extend: toClient([70, 0]), rect: { w: cv.width, h: cv.height } };
  })())`));
  function click(x, y, opts = '') {
    return evalJs(`(() => {
      const cv = document.getElementById('cv');
      const r = cv.getBoundingClientRect();
      const ev = new MouseEvent('mousedown', { clientX: r.left + (${x}), clientY: r.top + (${y}), button: 0, bubbles: true, ${opts} });
      cv.dispatchEvent(ev);
      const up = new MouseEvent('mouseup', { clientX: r.left + (${x}), clientY: r.top + (${y}), button: 0, bubbles: true });
      cv.dispatchEvent(up);
      return true;
    })()`);
  }
  // trim flow: activate tool, click boundary, click target
  await evalJs(`document.querySelector('[data-tool="trim"]').click()`);
  await click(vp.trim[0], vp.trim[1]);  // first click sets boundary (target line picked)
  const st1 = await evalJs(`JSON.stringify({ pick: !!window.__ak.state.trimPick, tool: window.__ak.state.tool })`);
  pass('trim first click sets boundary pick', JSON.parse(st1).pick === true, st1);

  // now click the boundary again to clear (fallback) then trim the other line side
  await click(vp.trim[0], vp.trim[1]);
  const cleared = JSON.parse(await evalJs(`JSON.stringify({ pick: window.__ak.state.trimPick === null })`));
  pass('trim clicking boundary clears pick', cleared.pick === true);

  // set boundary via direct click on boundary line, then trim target
  await seed([['line', [0, 0], [100, 0]], ['line', [50, -10], [50, 10]]]);
  await evalJs(`document.querySelector('[data-tool="trim"]').click()`);
  await click(vp.boundary[0], vp.boundary[1]);
  const st2 = JSON.parse(await evalJs(`JSON.stringify({ pick: !!window.__ak.state.trimPick, id: window.__ak.state.trimPick && window.__ak.state.trimPick.id, ids: window.__ak.state.doc.entities.map(e=>e.id) })`));
  pass('trim boundary pick is the vertical line', st2.pick && st2.id === st2.ids[1], st2);
  await click(vp.trim[0], vp.trim[1]);
  const after = JSON.parse(await evalJs(`JSON.stringify(window.__ak.state.doc.entities.filter(e=>e.type==='line').map(e=>[e.p1[0], e.p1[1], e.p2[0], e.p2[1]]))`));
  const trimmed = after.some(l => Math.abs(l[2] - 50) < 1 && Math.abs(l[3]) < 1) && !after.some(l => Math.abs(l[2] - 100) < 1);
  pass('trim UI: target line cut at boundary', trimmed, JSON.stringify(after));

  // extend UI flow
  await seed([['line', [0, 0], [40, 0]], ['line', [100, -10], [100, 10]]]);
  await evalJs(`document.querySelector('[data-tool="extend"]').click()`);
  const ec = JSON.parse(await evalJs(`JSON.stringify((() => { const s = window.__WebCAD.w2s([40,0]); return [Math.round(s[0]), Math.round(s[1])]; })())`));
  await click(ec[0], ec[1]);
  const extAfter = JSON.parse(await evalJs(`JSON.stringify(window.__ak.state.doc.entities[0])`));
  pass('extend UI: endpoint moved to x=100', Math.abs(extAfter.p2[0] - 100) < 1, JSON.stringify(extAfter));

  // ---------- summary ----------
  const fails = results.filter(r => !r.ok).length;
  console.log(`\\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
}

main().catch(e => { console.log('FAIL exception: ' + e.message); process.exit(1); });
