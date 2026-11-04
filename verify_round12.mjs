// Round-12 verify: Polar angle snap (45°). F10 toggles, tgPolar button toggles,
// line drawn with polar on locks to 45° increments from the first point; ortho off.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 9335;
const BASE = 'http://localhost:8080';
const OUT = '/tmp/cdp_out';
fs.mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let wsUrl = null;
async function getWsUrl() {
  let up = false;
  try { up = !!(await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch {}
  if (!up) {
    spawn('chrome-headless', ['--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--user-data-dir=/tmp/chrome_ak12', '--window-size=1400,900', 'about:blank'], { detached: true, stdio: 'ignore' });
  }
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; return true; }
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

async function typeKey(key) {
  const kd = { type: 'keyDown', modifiers: 0, windowsVirtualKeyCode: vk(key), key, text: key.length === 1 ? key : undefined };
  await cdp.send('Input.dispatchKeyEvent', kd);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, windowsVirtualKeyCode: vk(key), key });
}
function vk(key) {
  if (key === 'Enter') return 13;
  if (key === 'Escape') return 27;
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

// CDP Input.dispatchMouseEvent is blind in this chrome-headless-shell (canvas listeners never
// fire), so drive the canvas with synthetic JS MouseEvents on #cv instead.
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

  // --- F10 toggles polar ---
  const p0 = await evalJs(`window.__ak.state.polar`);
  pass('polar defaults off', p0 === false, String(p0));
  await typeKey('F10');
  await sleep(150);
  const p1 = await evalJs(`window.__ak.state.polar + '|' + document.getElementById('tgPolar').className`);
  pass('F10 enables polar + button on', p1.startsWith('true') && /on/.test(p1), p1);
  await typeKey('F10');
  await sleep(150);
  const p2 = await evalJs(`window.__ak.state.polar + '|' + document.getElementById('tgPolar').className`);
  pass('F10 disables polar + button off', p2.startsWith('false') && !/on/.test(p2), p2);

  // --- button toggles polar ---
  await evalJs(`document.getElementById('tgPolar').click()`);
  await sleep(120);
  const p3 = await evalJs(`window.__ak.state.polar`);
  pass('tgPolar button enables polar', p3 === true, String(p3));

  // ortho must be off for polar path
  const or = await evalJs(`window.__ak.state.ortho`);
  pass('ortho is off for test', or === false, String(or));
  const gs = await evalJs(`window.__ak.state.gridSnap`);
  pass('gridSnap off for test', gs === false, String(gs));

  // --- draw a line with polar on: aim at a non-45° angle, expect snapped to nearest 45° ---
  const nBefore = await evalJs(`window.__ak.state.doc.entities.length`);
  await typeKey('l');
  await sleep(150);
  const tool = await evalJs(`window.__ak.state.tool`);
  pass('line tool active', tool === 'line', tool);

  await clickAt(500, 500); // first point
  await sleep(150);
  // aim right-down at ~14° from horizontal (not a 45 multiple)
  await fireMouse('mousemove', 500 + 300, 500 + 75, 0);
  await sleep(200);
  // commit second point at the same mouse position
  await clickAt(500 + 300, 500 + 75);
  await sleep(250);
  const ents = await evalJs(`JSON.stringify(window.__ak.state.doc.entities.slice(${nBefore}))`);
  const list = JSON.parse(ents);
  const line = list.find(e => e.type === 'line');
  pass('line entity committed', !!line, ents);
  if (line) {
    const a = line.p1;
    const b = line.p2;
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
    const snapped = Math.abs(((ang % 45) + 45) % 45) < 1e-6 || Math.abs(((ang % 45) + 45) % 45 - 45) < 1e-6;
    pass('line angle is a 45° multiple', snapped, 'angle=' + ang.toFixed(2));
  }

  // --- polar off: same gesture is NOT snapped to 45° ---
  await evalJs(`document.getElementById('tgPolar').click()`);
  await sleep(120);
  const p4 = await evalJs(`window.__ak.state.polar`);
  pass('polar off for control', p4 === false, String(p4));
  const nB2 = await evalJs(`window.__ak.state.doc.entities.length`);
  await typeKey('l'); await sleep(120);
  await clickAt(600, 600); await sleep(120);
  await clickAt(600 + 300, 600 + 100); // ~18.4°, should stay unsnapped
  await sleep(250);
  const ents2 = await evalJs(`JSON.stringify(window.__ak.state.doc.entities.slice(${nB2}))`);
  const l2 = JSON.parse(ents2).find(e => e.type === 'line');
  pass('control line committed', !!l2, ents2);
  if (l2) {
    const a2 = l2.p1;
    const b2 = l2.p2;
    const ang2 = Math.atan2(b2[1] - a2[1], b2[0] - a2[0]) * 180 / Math.PI;
    const snapped = Math.abs(((ang2 % 45) + 45) % 45) < 1e-6;
    pass('control line not forced to 45°', !snapped, 'angle=' + ang2.toFixed(2));
  }

  await typeKey('Escape'); await sleep(100);

  // screenshot for the record
  await evalJs(`document.getElementById('tgPolar').click()`); await sleep(120);
  await typeKey('l'); await sleep(100);
  await clickAt(500, 500); await sleep(100);
  await fireMouse('mousemove', 800, 680, 0); await sleep(150);
  await cdp.send('Page.captureScreenshot', { format: 'png' }).then(async r => {
    fs.writeFileSync(OUT + '/r12_polar.png', Buffer.from(r.data, 'base64'));
  });
  pass('screenshot saved', fs.existsSync(OUT + '/r12_polar.png'), OUT + '/r12_polar.png');

  const np = results.filter(r => r.ok).length;
  console.log(`\n${np}/${results.length} passed`);
  fs.writeFileSync('/tmp/cb_results12.json', JSON.stringify(results, null, 2));
  process.exit(np === results.length ? 0 : 1);
}

main().catch(e => { console.error('SCRIPT ERROR', e); process.exit(2); });
