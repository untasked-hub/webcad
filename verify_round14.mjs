// Round-14 verify: Rotate selection tool. Select entities, press Enter, pick
// centre, drag to rotate; Shift drag snaps to 15-degree increments; single undo.
// View is pinned to zoom=1 with screen_x = world_x, screen_y = H/2 - world_y so
// all interaction coordinates are exact.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 9337;
const BASE = 'http://localhost:8080';
const OUT = '/tmp/cdp_out';
fs.mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getWsUrl() {
  let up = false;
  try { up = !!(await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch {}
  if (!up) {
    spawn('chrome-headless', ['--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--user-data-dir=/tmp/chrome_ak14', '--window-size=1400,900', 'about:blank'], { detached: true, stdio: 'ignore' });
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

async function fireMouse(type, x, y, buttons, mods = 0) {
  const [cx, cy] = await canvasOrigin();
  await evalJs(`(() => {
    const c = document.getElementById('cv');
    if (!c) return 'nocv';
    const ev = new MouseEvent('${type}', { clientX: ${cx + x}, clientY: ${cy + y}, button: 0, buttons: ${buttons}, bubbles: true, cancelable: true, view: window });
    Object.defineProperty(ev, 'shiftKey', { value: ${!!(mods & 8)} });
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

// Press without releasing: used for the rotate centre pick, whose mousedown starts a drag.
async function pressAt(x, y) {
  await fireMouse('mousemove', x, y, 0);
  await fireMouse('mousedown', x, y, 1);
}

async function dragPath(points, mods = 0) {
  const [x0, y0] = points[0];
  await fireMouse('mousedown', x0, y0, 1, mods);
  for (const [x, y] of points.slice(1)) {
    await fireMouse('mousemove', x, y, 1, mods);
    await sleep(40);
  }
  await fireMouse('mouseup', points[points.length - 1][0], points[points.length - 1][1], 1, mods);
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

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

  const user = 'r14user' + Date.now().toString().slice(-6);
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

  // Pin the view: zoom=1, world origin mapped so screen (sx,sy) == world (sx, sy - H/2)
  const pinned = await evalJs(`(() => {
    const s = window.__WebCAD.state;
    const c = document.getElementById('cv');
    const h = c.clientHeight, w = c.clientWidth;
    s.view = { x: w / 2, y: 0, zoom: 1 }; // screen_y = cvH/2 - world_y at zoom 1
    window.__ak.renderAll ? window.__ak.renderAll() : (window.__WebCAD.draw ? window.__WebCAD.draw() : null);
    return JSON.stringify(s.view);
  })()`);
  const view = JSON.parse(pinned);
  pass('view pinned zoom=1', view.zoom === 1, 'view=' + pinned);
  // Exact mapping helpers via the app's own s2w
  const H = await evalJs(`document.getElementById('cv').clientHeight`);
  const W = await evalJs(`document.getElementById('cv').clientWidth`);
  const sxy = (wx, wy) => [wx, H / 2 - wy]; // screen from world (exact at zoom=1)

  // Fresh doc
  await evalJs(`(() => { window.__WebCAD.state.doc.entities = []; window.__WebCAD.state.sel.clear(); return true; })()`);
  await sleep(150);

  // Toolbar + prompt check
  await typeKey('o'); await sleep(150);
  const toolRot = await evalJs(`window.__WebCAD.state.tool`);
  pass('hotkey o selects rotate tool', toolRot === 'rotate', 'tool=' + toolRot);

  const promptTxt = await evalJs(`document.getElementById('prompt') ? document.getElementById('prompt').textContent : document.body.textContent.slice(0,200)`);
  pass('prompt mentions Shift 15° snap', /Shift/.test(promptTxt) && /15/.test(promptTxt), promptTxt.slice(0, 120));

  // Draw a horizontal world line (100,0) -> (300,0) with the line tool
  await typeKey('l'); await sleep(120);
  const s1 = sxy(100, 0), s2 = sxy(300, 0);
  await clickAt(s1[0], s1[1]); await sleep(100);
  await clickAt(s2[0], s2[1]); await sleep(150);
  await typeKey('Escape'); await sleep(120);
  const nEnts = await evalJs(`window.__WebCAD.state.doc.entities.length`);
  pass('one line drawn', nEnts === 1, 'n=' + nEnts);

  const lineBefore = JSON.parse(await evalJs(`JSON.stringify(window.__WebCAD.state.doc.entities[0])`));
  const lenBefore = dist(lineBefore.p1, lineBefore.p2);
  pass('line length captured', Math.abs(lenBefore - 200) < 1, 'len=' + lenBefore.toFixed(2) + ' ent=' + JSON.stringify(lineBefore));

  // Select the line (click its midpoint in screen coords) then press rotate hotkey
  await clickAt(sxy(200, 0)[0], sxy(200, 0)[1]); await sleep(150);
  let sel = await evalJs(`window.__WebCAD.state.sel.size`);
  pass('line selected by click', sel === 1, 'sel=' + sel);

  await typeKey('o'); await sleep(150);
  await typeKey('Enter'); await sleep(150);
  const phase = await evalJs(`window.__WebCAD.state.phase`);
  pass('Enter advances to base phase', phase === 'base', 'phase=' + phase);

  // Pick rotation centre = line start world (100,0); app starts a rotate drag
  const entId = await evalJs(`window.__WebCAD.state.doc.entities[0].id`);
  const cScr = sxy(100, 0);
  await pressAt(cScr[0], cScr[1]); await sleep(150);
  const dragMode = await evalJs(`window.__WebCAD.state.drag && window.__WebCAD.state.drag.mode`);
  pass('rotate drag begins at centre pick', dragMode === 'rotate', 'drag=' + JSON.stringify(dragMode));

  // Drag handle from east of centre to north of centre: world angle +90°.
  // Handle must start on the line's own endpoint (200 world px from centre).
  const h0 = sxy(300, 0), h1 = sxy(100, 200), hmid = sxy(100 + 200 * Math.SQRT1_2, 200 * Math.SQRT1_2);
  await dragPath([h0, hmid, h1]);
  await sleep(200);
  const lineAfter = JSON.parse(await evalJs(`JSON.stringify(window.__WebCAD.state.doc.entities.find(e => e.id === ${JSON.stringify(entId)}))`));
  const pivot = lineBefore.p1;
  const angleOf = (p) => Math.atan2(p[1] - pivot[1], p[0] - pivot[0]);
  const aBefore = angleOf(lineBefore.p2);
  const aAfter = angleOf(lineAfter.p2);
  let dAng = aAfter - aBefore;
  while (dAng > Math.PI) dAng -= 2 * Math.PI;
  while (dAng < -Math.PI) dAng += 2 * Math.PI;
  pass('drag rotates about centre ~+90°', Math.abs(dAng - Math.PI / 2) < 0.1, 'dAng=' + (dAng * 180 / Math.PI).toFixed(1) + '° exp=+90°');
  const lenAfter = dist(lineAfter.p1, lineAfter.p2);
  pass('rotation preserves length', Math.abs(lenAfter - lenBefore) < 1, 'len=' + lenAfter.toFixed(2));
  const pivotMoved = dist(lineAfter.p1, pivot);
  pass('pivot point stays fixed', pivotMoved < 1, 'move=' + pivotMoved.toFixed(2));

  // Single undo restores original geometry
  await typeKey('z', 2); await sleep(250);
  const lineUndo = JSON.parse(await evalJs(`JSON.stringify(window.__WebCAD.state.doc.entities[0])`));
  const okUndo = dist(lineUndo.p1, lineBefore.p1) < 0.5 && dist(lineUndo.p2, lineBefore.p2) < 0.5;
  pass('single undo restores line', okUndo, JSON.stringify(lineUndo));

  // Shift-snap drag: rotate about p1 again; snap must land on a multiple of 15°.
  await clickAt(sxy(200, 0)[0], sxy(200, 0)[1]); await sleep(120);
  await typeKey('o'); await sleep(120);
  await typeKey('Enter'); await sleep(120);
  await pressAt(cScr[0], cScr[1]); await sleep(120);
  const drag2 = await evalJs(`window.__WebCAD.state.drag && window.__WebCAD.state.drag.mode`);
  pass('second rotate drag starts', drag2 === 'rotate', 'drag=' + JSON.stringify(drag2));
  const entId2 = await evalJs(`window.__WebCAD.state.doc.entities[0].id`);
  // Move handle 40° below east with Shift held: snapped to nearest 15° (30° or 45°).
  const hs0 = sxy(300, 0);
  const aT = -40 * Math.PI / 180; // screen angle below east
  const hsEnd = [300 + 200 * Math.cos(aT), 0 - 200 * Math.sin(aT) * -1];
  // screen: y down; screen point = (cx + r cos a, H/2 - r sin a) with world angle a.
  const aScr = -40 * Math.PI / 180;
  const hsEnd2 = [100 + 200 * Math.cos(aScr), H / 2 - 200 * Math.sin(aScr)];
  await dragPath([[hs0[0], hs0[1]], [hsEnd2[0], hsEnd2[1]]], 8); // mods=8 => shiftKey
  await sleep(200);
  const lineSnap = JSON.parse(await evalJs(`JSON.stringify(window.__WebCAD.state.doc.entities.find(e => e.id === ${JSON.stringify(entId2)}))`));
  const pivot2 = lineUndo.p1;
  const a0 = angleOf(lineUndo.p2);
  const a1 = angleOf(lineSnap.p2);
  let d2 = a1 - a0;
  while (d2 > Math.PI) d2 -= 2 * Math.PI;
  while (d2 < -Math.PI) d2 += 2 * Math.PI;
  const deg = d2 * 180 / Math.PI;
  const snapOk = Math.abs(deg / 15 - Math.round(deg / 15)) < 0.05 && Math.abs(deg) > 1;
  pass('Shift drag snaps to 15° increment', snapOk, 'deg=' + deg.toFixed(2));
  const lenSnap = dist(lineSnap.p1, lineSnap.p2);
  pass('snap rotation preserves length', Math.abs(lenSnap - lenBefore) < 1, 'len=' + lenSnap.toFixed(2));

  // Undo the snap rotation too
  await typeKey('z', 2); await sleep(250);
  const after = JSON.parse(await evalJs(`JSON.stringify(window.__WebCAD.state.doc.entities[0])`));
  pass('undo restores after snap rotate', dist(after.p1, lineUndo.p1) < 0.5 && dist(after.p2, lineUndo.p2) < 0.5, '');

  await cdp.send('Page.captureScreenshot', { format: 'png' }).then(r => {
    fs.writeFileSync(OUT + '/r14_rotate.png', Buffer.from(r.data, 'base64'));
  });

  const np = results.filter(r => r.ok).length;
  console.log(`\n${np}/${results.length} passed`);
  process.exit(np === results.length ? 0 : 1);
}

main().catch(e => { console.error('SCRIPT ERROR', e); process.exit(2); });
