// Round-23 harness drift probe: click-select of an entity (sel=0 failure case).
// Uses the same Cdp class as verify_round23_live.mjs (works without sessionId).
// Goal: determine whether "click selects entity with HUD overlay present"
// (sel=0) is a real app bug or a harness artifact (event coordinates / tool state).
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
      let m;
      try { m = JSON.parse(e.data); } catch { return; }      // guard: skip non-JSON frames
      if (!m) return;
      if (m.id && c.pending.has(m.id)) { c.pending.get(m.id)(m); c.pending.delete(m.id); }
      // messages without id (events, sessionId-less) are intentionally ignored
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

  await evalJs(`(() => {
    const s = window.__ak.state;
    s.doc.entities.length = 0;
    s.doc.entities.push({ id: 'r0', type: 'line', layer: '0', p1: [0, 0], p2: [40, 0] });
    s.view = { x: 0, y: 0, zoom: 1 };
    s.sel = new Set(); s.pending = []; s.drag = null; s.undo.length = 0;
    return document.querySelector('[data-tool="select"]').click();
  })()`);

  // Scenario A: replicate round23_live exactly — mousedown+mouseup at entity point (10,0)
  const l0 = await sOf([10, 0]);
  await mouse('mousemove', l0[0], l0[1]);
  await mouse('mousedown', l0[0], l0[1]); await mouse('mouseup', l0[0], l0[1]);
  await sleep(80);
  const selA = await evalJs(`window.__ak.state.sel.size`);
  const toolA = await evalJs(`window.__ak.state.tool`);
  console.log('A (replicate round23): sel=' + selA + ' tool=' + toolA);

  // Scenario B: inspect what happens inside handler — dump state after the click
  const diag = await evalJs(`(() => {
    const s = window.__ak.state;
    return JSON.stringify({ tool: s.tool, pending: s.pending.length, drag: !!s.drag, sel: [...s.sel] });
  })()`);
  console.log('diag after A:', diag);

  // Scenario C: pickAt sanity — does the app's own hit-test find the line?
  const pick = await evalJs(`(() => {
    const s = window.__ak.state;
    // call pickAt directly if exposed, else replicate: click exactly on entity center
    const wp = window.__WebCAD.s2w ? JSON.stringify(window.__WebCAD.s2w) : 'n/a';
    return 's2w:' + wp;
  })()`);
  console.log('coord helpers:', pick);

  // Scenario D: mouseup-only after mousedown on empty space then click on entity
  await evalJs(`window.__ak.state.sel = new Set()`);
  const l1 = await sOf([20, 0]);
  await mouse('mousedown', l1[0], l1[1]); await mouse('mouseup', l1[0], l1[1]);
  await sleep(80);
  const selD = await evalJs(`window.__ak.state.sel.size`);
  console.log('D (click at 20,0): sel=' + selD);

  // Scenario E: dump drag state right after mousedown on entity (like probe_move does)
  await evalJs(`window.__ak.state.sel = new Set(); window.__ak.state.drag = null`);
  const l2 = await sOf([20, 0]);
  await mouse('mousedown', l2[0], l2[1]);
  await sleep(150);
  const dragE = await evalJs(`JSON.stringify({ drag: window.__ak.state.drag, sel: [...window.__ak.state.sel] })`);
  console.log('E after mousedown on entity:', dragE);
  await mouse('mouseup', l2[0], l2[1]);
  await sleep(80);

  // Scenario F: cancelable:true events (probe_move used cancelable)
  await evalJs(`window.__ak.state.sel = new Set(); window.__ak.state.drag = null`);
  const l3 = await sOf([20, 0]);
  await evalJs(`(() => {
    const cv = document.getElementById('cv');
    const r = cv.getBoundingClientRect();
    cv.dispatchEvent(new MouseEvent('mousedown', { clientX: r.left + ${l3[0]}, clientY: r.top + ${l3[1]}, button: 0, bubbles: true, cancelable: true }));
    cv.dispatchEvent(new MouseEvent('mouseup', { clientX: r.left + ${l3[0]}, clientY: r.top + ${l3[1]}, button: 0, bubbles: true, cancelable: true }));
    return 1;
  })()`);
  await sleep(120);
  const selF = await evalJs(`window.__ak.state.sel.size`);
  console.log('F cancelable click: sel=' + selF);

  // Scenario G: does the click handler even see the coordinates? add a one-shot listener
  const heard = await evalJs(`(() => {
    const cv = document.getElementById('cv');
    let got = [];
    const fn = (e) => got.push(e.type + '@' + Math.round(e.clientX) + ',' + Math.round(e.clientY));
    cv.addEventListener('mousedown', fn, true);
    cv.addEventListener('mouseup', fn, true);
    const l4 = window.__WebCAD.w2s([20, 0]);
    const r = cv.getBoundingClientRect();
    cv.dispatchEvent(new MouseEvent('mousedown', { clientX: r.left + l4[0], clientY: r.top + l4[1], button: 0, bubbles: true }));
    cv.dispatchEvent(new MouseEvent('mouseup', { clientX: r.left + l4[0], clientY: r.top + l4[1], button: 0, bubbles: true }));
    cv.removeEventListener('mousedown', fn, true); cv.removeEventListener('mouseup', fn, true);
    return JSON.stringify(got);
  })()`);
  console.log('G events heard:', heard);

  // Scenario H: use CDP Input.dispatchMouseEvent (real trusted browser input, no synthetic)
  await evalJs(`window.__ak.state.sel = new Set(); window.__ak.state.drag = null`);
  const l5 = await evalJs(`(() => { const c = document.getElementById('cv'); const r = c.getBoundingClientRect(); const p = window.__WebCAD.w2s([20,0]); return JSON.stringify([r.left + p[0], r.top + p[1], p]); })()`).then(JSON.parse);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: l5[0], y: l5[1], button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: l5[0], y: l5[1], button: 'left', clickCount: 1 });
  await sleep(150);
  const selH = await evalJs(`window.__ak.state.sel.size`);
  console.log('H CDP real input click at screen(' + l5[0] + ',' + l5[1] + ') wp=' + JSON.stringify(l5[2]) + ': sel=' + selH);

  const verdict = (selA === 1 || selD === 1 || selF === 1 || selH === 1)
    ? 'HARNESS ARTIFACT: click-select works (at least one scenario selects)'
    : 'APP ISSUE candidate: no scenario selected; inspect hit-test/coords';
  console.log('\nVERDICT:', verdict);
  process.exit(0);
}
main().catch(e => { console.log('FATAL', e.message); process.exit(1); });
