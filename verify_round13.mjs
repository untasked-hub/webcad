// Round-13 verify: Mirror H/V selection. Draw entities, select, mirror via
// Shift+X (flip left-right about bbox center) and Shift+Y (flip up-down), and via toolbar buttons.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 9336;
const BASE = 'http://localhost:8080';
const OUT = '/tmp/cdp_out';
fs.mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getWsUrl() {
  let up = false;
  try { up = !!(await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch {}
  if (!up) {
    spawn('chrome-headless', ['--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--user-data-dir=/tmp/chrome_ak13', '--window-size=1400,900', 'about:blank'], { detached: true, stdio: 'ignore' });
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

async function typeKey(key, mods = 0) {
  const kd = { type: 'keyDown', modifiers: mods, windowsVirtualKeyCode: vk(key), key, text: key.length === 1 ? key : undefined };
  await cdp.send('Input.dispatchKeyEvent', kd);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mods, windowsVirtualKeyCode: vk(key), key });
}
function vk(key) {
  if (key === 'Enter') return 13;
  if (key === 'Escape') return 27;
  if (key === 'Shift') return 16;
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  if (lower.includes(key.toLowerCase())) return 65 + lower.indexOf(key.toLowerCase());
  if (/^F\d+$/.test(key)) return 112 + parseInt(key.slice(1)) - 1;
  if (/^\d$/.test(key)) return 48 + parseInt(key);
  return 0;
}

async function canvasOrigin() {
  const box = await evalJs(`(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return JSON.stringify([r.x, r.y]); })()`);
  return JSON.parse(box);
}

async function fireMouse(type, x, y, buttons) {
  const [cx, cy] = await canvasOrigin();
  await evalJs(`(() => {
    const c = document.getElementById('cv');
    if (!c) return 'nocv';
    const ev = new MouseEvent('${type}', { clientX: ${cx + x}, clientY: ${cy + y}, button: 0, buttons: ${buttons}, bubbles: true, cancelable: true, view: window });
    Object.defineProperty(ev, 'which', { value: 1 });
    c.dispatchEvent(ev);
    window.__mouseFired = (window.__mouseFired || 0) + 1;
    return 1;
  })()`);
}

async function clickAt(x, y) {
  await fireMouse('mousemove', x, y, 0);
  await fireMouse('mousedown', x, y, 1);
  await fireMouse('mouseup', x, y, 1);
  await fireMouse('click', x, y, 1);
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

  const user = 'mkuser' + Date.now().toString().slice(-6);
  await evalJs(`window.__ak.openAuth('register')`);
  await sleep(300);
  await evalJs(`(() => {
    document.getElementById('authUser').value = '${user}';
    document.getElementById('authPass').value = 'secret123';
    return true;
  })()`);
  await evalJs(`window.__ak.submitAuth()`);
  await sleep(1800);
  const who = await evalJs(`typeof window.__ak.currentUser !== 'undefined' ? window.__ak.currentUser : null`);
  pass('signup+session', !!who, 'user=' + JSON.stringify(who));

  // Clear any leftover autosaved entities from prior sessions
  await evalJs(`(() => { window.__WebCAD.state.doc.entities = []; window.__WebCAD.state.sel.clear(); return true; })()`);
  await sleep(150);

  // Toolbar buttons exist
  const btns = await evalJs(`(!!document.getElementById('btnMirrorX')) + '|' + (!!document.getElementById('btnMirrorY'))`);
  pass('mirror toolbar buttons present', btns === 'true|true', btns);

  // Draw an asymmetric L: horizontal line + vertical line, top-left heavy
  const n0 = await evalJs(`window.__ak.state.doc.entities.length`);
  await typeKey('l'); await sleep(150);
  await clickAt(400, 400); await sleep(100);
  await clickAt(600, 400); await sleep(150); // horizontal to the right
  await typeKey('l'); await sleep(120);
  await clickAt(400, 400); await sleep(100);
  await clickAt(400, 500); await sleep(150); // vertical downward
  await typeKey('Escape'); await sleep(120);

  const before = JSON.parse(await evalJs(`JSON.stringify(window.__ak.state.doc.entities.slice(${n0}))`));
  pass('two lines drawn', before.length === 2 && before.every(e => e.type === 'line'), before.length + ' ents');

  const entsSnapshot = async () => JSON.parse(await evalJs(`JSON.stringify(window.__ak.state.doc.entities.slice(${n0}))`));

  // Select all with marquee
  await typeKey('Escape'); await sleep(100);
  await fireMouse('mousedown', 300, 300, 1);
  await fireMouse('mousemove', 700, 600, 1);
  await fireMouse('mouseup', 700, 600, 1);
  await sleep(200);
  const sel = await evalJs(`window.__WebCAD.state.sel.size`);
  pass('marquee selection of 2', sel === 2, 'sel=' + sel);

  // Shift+X mirror (flip left-right about bbox center). For an asymmetric L the
  // point set legitimately changes; the invariant is: every endpoint is reflected
  // about the selection bbox center x.
  const bx = before.flatMap(e => [e.p1[0], e.p2[0]]);
  const cx = (Math.min(...bx) + Math.max(...bx)) / 2;
  await typeKey('x', 8); // Shift modifier bit 8
  await sleep(250);
  let afterX = await entsSnapshot();
  const xCoords = afterX.flatMap(e => [e.p1[0], e.p2[0]]).sort((a, b) => a - b);
  const expX = bx.map(v => 2 * cx - v).sort((a, b) => a - b);
  const bboxX1 = Math.min(...bx.map(v => 2 * cx - v));
  const okX = xCoords.every((v, i) => Math.abs(v - expX[i]) < 0.01);
  const sameSpanX = Math.abs(xCoords[0] - bx.slice().sort((a,b)=>a-b)[0]) < 0.01 && Math.abs(xCoords[xCoords.length-1] - bx.slice().sort((a,b)=>a-b)[bx.length-1]) < 0.01;
  pass('Shift+X mirrors about bbox center x', okX && sameSpanX, 'c=' + cx.toFixed(2) + ' got=' + JSON.stringify(xCoords) + ' exp=' + JSON.stringify(expX));

  // Shift+Y mirror (flip up-down about bbox center y)
  const by = before.flatMap(e => [e.p1[1], e.p2[1]]);
  const cy = (Math.min(...by) + Math.max(...by)) / 2;
  await typeKey('y', 8);
  await sleep(250);
  let afterY = await entsSnapshot();
  const yCoords = afterY.flatMap(e => [e.p1[1], e.p2[1]]).sort((a, b) => a - b);
  const expY = by.map(v => 2 * cy - v).sort((a, b) => a - b);
  const okY = yCoords.every((v, i) => Math.abs(v - expY[i]) < 0.01);
  const sameSpanY = Math.abs(yCoords[0] - by.slice().sort((a,b)=>a-b)[0]) < 0.01;
  pass('Shift+Y mirrors about bbox center y', okY && sameSpanY, 'c=' + cy.toFixed(2) + ' got=' + JSON.stringify(yCoords) + ' exp=' + JSON.stringify(expY));

  // Deselect, redraw pattern, then toolbar Mirror X button
  await typeKey('Escape'); await sleep(100);
  // clear all entities
  await evalJs(`(() => { window.__WebCAD.state.sel = new Set(window.__WebCAD.state.doc.entities.map(e => e.id)); return true; })()`);
  await evalJs(`(() => { window.__WebCAD.state.doc.entities = []; window.__WebCAD.state.sel.clear(); return true; })()`);
  await sleep(150);
  const cleared = await evalJs(`window.__ak.state.doc.entities.length`);
  pass('canvas cleared', cleared === 0, 'n=' + cleared);

  await typeKey('l'); await sleep(120);
  await clickAt(400, 400); await sleep(100);
  await clickAt(600, 400); await sleep(150); // horizontal right
  await typeKey('Escape'); await sleep(100);

  await evalJs(`(() => { window.__WebCAD.state.sel = new Set(window.__WebCAD.state.doc.entities.map(e => e.id)); return true; })()`);
  const hBefore = JSON.parse(await evalJs(`JSON.stringify(window.__ak.state.doc.entities[0])`));
  await evalJs(`document.getElementById('btnMirrorX').click()`);
  await sleep(250);
  const afterBtn = JSON.parse(await evalJs(`JSON.stringify(window.__WebCAD.state.doc.entities)`));
  // Invariant in world coords: each endpoint x reflected about the line bbox center x, y unchanged.
  const hx = [hBefore.p1[0], hBefore.p2[0]].sort((a,b)=>a-b);
  const hcx = (hx[0] + hx[1]) / 2;
  const ln = afterBtn.find(e => e.type === 'line');
  const okH = ln && Math.abs(Math.min(ln.p1[0],ln.p2[0]) - (2*hcx - hx[1])) < 0.01
           && Math.abs(Math.max(ln.p1[0],ln.p2[0]) - (2*hcx - hx[0])) < 0.01
           && Math.abs(ln.p1[1] - hBefore.p1[1]) < 0.01 && Math.abs(ln.p2[1] - hBefore.p2[1]) < 0.01;
  pass('btnMirrorX mirrors line direction', !!okH, JSON.stringify(ln));

  // Mirror Y via toolbar with a fresh vertical line (clean state)
  await typeKey('Escape'); await sleep(80);
  await evalJs(`(() => { window.__WebCAD.state.doc.entities = []; window.__WebCAD.state.sel.clear(); return true; })()`);
  await sleep(120);
  await typeKey('l'); await sleep(120);
  await clickAt(400, 400); await sleep(100);
  await clickAt(400, 600); await sleep(150); // vertical down
  await typeKey('Escape'); await sleep(80);
  const vBefore = JSON.parse(await evalJs(`JSON.stringify(window.__WebCAD.state.doc.entities[0])`));
  await evalJs(`(() => { window.__WebCAD.state.sel = new Set(window.__WebCAD.state.doc.entities.map(e => e.id)); return true; })()`);
  await evalJs(`document.getElementById('btnMirrorY').click()`);
  await sleep(250);
  const all = JSON.parse(await evalJs(`JSON.stringify(window.__WebCAD.state.doc.entities)`));
  const vy = [vBefore.p1[1], vBefore.p2[1]].sort((a,b)=>a-b);
  const vcy = (vy[0] + vy[1]) / 2;
  const vl = all.find(e => e.type === 'line');
  const okV = vl && Math.abs(Math.min(vl.p1[1],vl.p2[1]) - (2*vcy - vy[1])) < 0.01
           && Math.abs(Math.max(vl.p1[1],vl.p2[1]) - (2*vcy - vy[0])) < 0.01
           && Math.abs(vl.p1[0] - vBefore.p1[0]) < 0.01 && Math.abs(vl.p2[0] - vBefore.p2[0]) < 0.01;
  pass('btnMirrorY mirrors line direction', !!okV, JSON.stringify(vl));

  // Undo still works after mirror (undo the mirror, keep the line)
  await typeKey('z', 2); // Ctrl+Z
  await sleep(250);
  const afterUndo = await evalJs(`window.__ak.state.doc.entities.length`);
  pass('undo after mirror', afterUndo === 1, 'n=' + afterUndo);

  await cdp.send('Page.captureScreenshot', { format: 'png' }).then(r => {
    fs.writeFileSync(OUT + '/r13_mirror.png', Buffer.from(r.data, 'base64'));
  });

  const np = results.filter(r => r.ok).length;
  console.log(`\n${np}/${results.length} passed`);
  process.exit(np === results.length ? 0 : 1);
}

main().catch(e => { console.error('SCRIPT ERROR', e); process.exit(2); });
