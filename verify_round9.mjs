// Round-9 E2E verify: precise coordinate entry via command bar (CDP)
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 9333;
const BASE = 'http://localhost:8080';
const OUT = '/tmp/cdp_out';
fs.mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let wsUrl = null;
async function getWsUrl() {
  // launch chrome once if not already running
  let up = false;
  try { up = !!(await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch {}
  if (!up) {
    spawn('chrome-headless', ['--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--user-data-dir=/tmp/chrome_ak9', '--window-size=1400,900', 'about:blank'], { detached: true, stdio: 'ignore' });
  }
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; return true; }
    } catch {}
    await sleep(500);
  }
  return false;
}

// tiny CDP client
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new Cdp(ws); c.ws = ws;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.pending.has(m.id)) { c.pending.get(m.id)(m); c.pending.delete(m.id); }
      else c.events.push(m);
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
  async waitEvent(name, pred = () => true, timeout = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const i = this.events.findIndex(e => e.method === name && pred(e));
      if (i >= 0) return this.events.splice(i, 1)[0];
      await sleep(50);
      // pump
    }
    throw new Error('waitEvent timeout: ' + name);
  }
}

let cdp = null;
const results = [];
function pass(name, ok, detail = '') { results.push({ name, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); }

async function main() {
  if (!(await getWsUrl())) { console.log('FAIL setup: no debug port'); process.exit(1); }
  // connect to a page target, not the browser endpoint
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
  await cdp.send('Log.enable').catch(() => {});
  const consoleErrors = [];
  cdp.send('Runtime.consoleAPICalled').catch(() => {});
  await cdp.send('Runtime.evaluate', { expression: `window.__errs=[]; window.addEventListener('error',e=>__errs.push(String(e.message)))`, returnByValue: true });

  // Listen for console errors by polling evaluate instead (simpler)
  await cdp.send('Page.navigate', { url: BASE });
  await sleep(2500);
  await cdp.send('Runtime.evaluate', { expression: `1`, returnByValue: true });

  // sign in
  const user = 'cbuser' + Date.now().toString().slice(-6);
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
  const authErr = await evalJs(`(() => { const el = document.getElementById('authErr'); return el ? el.textContent : '(no el)'; })()`);
  pass('signup+session', !!who, 'user=' + JSON.stringify(who) + ' authErr=' + authErr);

  await cdp.send('Runtime.evaluate', { expression: `window.__errs=[];`, returnByValue: true });

  // parse unit checks
  const u = await evalJs(`JSON.stringify([
    window.__ak.parseCoordEntry('100,50', [0,0]),
    window.__ak.parseCoordEntry('-10, 3.5', [0,0]),
    window.__ak.parseCoordEntry('50<45', [0,0]),
    window.__ak.parseCoordEntry('@10,20', [7,7]),
    window.__ak.parseCoordEntry('@5<90', [7,7]),
    window.__ak.parseCoordEntry('50<999', [0,0]),
    window.__ak.parseCoordEntry('abc', [0,0]),
    window.__ak.parseCoordEntry('', [0,0]),
  ])`);
  const uj = JSON.parse(u);
  const close = (a, b) => Math.abs(a - b) < 1e-6;
  pass('parse abs', close(uj[0][0], 100) && close(uj[0][1], 50));
  pass('parse abs neg+dec', close(uj[1][0], -10) && close(uj[1][1], 3.5));
  pass('parse polar', close(uj[2][0], 35.35533905932738) && close(uj[2][1], 35.35533905932738));
  pass('parse rel xy', close(uj[3][0], 17) && close(uj[3][1], 27));
  pass('parse rel polar', close(uj[4][0], 7) && close(uj[4][1], 12));
  pass('parse polar 999deg valid point', Array.isArray(uj[5]) && isFinite(uj[5][0]) && isFinite(uj[5][1]));
  pass('parse reject abc', uj[6] === null);
  pass('parse reject empty', uj[7] === null);

  // keyboard flow: press 'l' to start line, then type 100,50 and Enter
  await typeKey('l');
  await sleep(150);
  const t1 = await evalJs(`window.__ak.state.tool + '|' + window.__ak.state.pending.length`);
  pass('key l starts line', t1.startsWith('line|0'), t1);

  // type digits -> cmdInput should capture
  for (const ch of '100,50') await typeKey(ch);
  await sleep(120);
  const f1 = await evalJs(`(document.activeElement && document.activeElement.id) + '|' + document.getElementById('cmdInput').value`);
  pass('digit typing captured in cmdInput', f1 === 'cmdInput|100,50', f1);

  await typeKey('Enter');
  await sleep(150);
  const s1 = await evalJs(`window.__ak.state.pending.length ? JSON.stringify(window.__ak.state.pending[0]) : 'none'`);
  pass('abs entry sets start point', s1 === '[100,50]', s1);

  // second point: polar from start, via keyboard again (first char must not be lost)
  for (const ch of '50<45') await typeKey(ch);
  await sleep(120);
  const f2 = await evalJs(`(document.activeElement && document.activeElement.id) + '|' + document.getElementById('cmdInput').value`);
  pass('polar typing captured intact', f2 === 'cmdInput|50<45', f2);

  await typeKey('Enter');
  await sleep(200);
  const lineCount = await evalJs(`window.__ak.state.doc.entities.filter(e=>e.type==='line').length`);
  pass('line committed from typed coords', lineCount >= 1, 'lines=' + lineCount);
  const le = await evalJs(`JSON.stringify((e=>e?[e.p1,e.p2]:null)(window.__ak.state.doc.entities.filter(e=>e.type==='line').at(-1)))`);
  const lj = JSON.parse(le);
  const expX = 100 + 50 * Math.SQRT1_2, expY = 50 + 50 * Math.SQRT1_2;
  pass('polar end point correct', close(lj[0][0], 100) && close(lj[0][1], 50) && close(lj[1][0], expX, ) && close(lj[1][1], expY), le);

  // mixed flow: click start, then type relative
  await typeKey('Escape');
  await sleep(100);
  await typeKey('l'); await sleep(100);
  await clickAt(600, 400);
  await sleep(150);
  const s2 = await evalJs(`window.__ak.state.pending.length ? JSON.stringify(window.__ak.state.pending[0]) : 'none'`);
  pass('mouse start still works', s2 !== 'none', s2);

  for (const ch of '@30,20') await typeKey(ch);
  await sleep(120);
  await typeKey('Enter');
  await sleep(200);
  const le2 = await evalJs(`JSON.stringify((e=>e?[e.p1,e.p2]:null)(window.__ak.state.doc.entities.filter(e=>e.type==='line').at(-1)))`);
  const lj2 = JSON.parse(le2);
  pass('relative from clicked point', close(lj2[1][0], lj2[0][0] + 30) && close(lj2[1][1], lj2[0][1] + 20), le2);

  // screenshot for evidence
  await cdp.send('Page.captureScreenshot', { format: 'png' }).then(async r => {
    fs.writeFileSync(OUT + '/r9_final.png', Buffer.from(r.data, 'base64'));
  });

  const errs = await evalJs(`window.__errs.join('; ')`);
  pass('no runtime errors', !errs, errs || 'clean');

  const np = results.filter(r => r.ok).length;
  console.log(`\n${np}/${results.length} passed`);
  fs.writeFileSync('/tmp/cb_results.json', JSON.stringify(results, null, 2));
  process.exit(np === results.length ? 0 : 1);
}

async function evalJs(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('evalJs exception: ' + JSON.stringify(r.exceptionDetails));
  return r.result ? r.result.value : undefined;
}

async function typeKey(key) {
  // dispatch proper keydown/keyup
  const kd = { type: 'keyDown', modifiers: 0, windowsVirtualKeyCode: vk(key), key, text: key.length === 1 ? key : undefined };
  await cdp.send('Input.dispatchKeyEvent', kd);
  if (key.length === 1) await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, windowsVirtualKeyCode: vk(key), key });
  else await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, windowsVirtualKeyCode: vk(key), key });
}

function vk(key) {
  if (key === 'Enter') return 13;
  if (key === 'Escape') return 27;
  if (key === 'Backspace') return 8;
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  if (lower.includes(key.toLowerCase())) return 65 + lower.indexOf(key.toLowerCase());
  if (/\d/.test(key)) return 48 + parseInt(key);
  switch (key) {
    case ',': return 188; case '.': return 190; case '-': return 189;
    case '@': return 50; case '<': return 188; case '+': return 187;
    default: return 0;
  }
}

// click at canvas coords: assumes canvas positioned; we use center-ish
async function clickAt(x, y) {
  // get canvas bounding box from page
  const box = await evalJs(`(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return JSON.stringify([r.x, r.y, r.width, r.height]); })()`);
  const [cx, cy, w, h] = JSON.parse(box);
  const absX = cx + (x / w) * w, absY = cy + (y / h) * h;
  const seq = Date.now();
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x: absX, y: absY, button: 'left', buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: 1, pointerType: 'mouse'
    });
  }
}

main().catch(e => { console.error('SCRIPT ERROR', e); process.exit(2); });