// Round-11 verify: Measure tool (key u + toolbar button), HUD #hl, dashed line label
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 9333;
const BASE = 'http://localhost:8080';
const OUT = '/tmp/cdp_out';
fs.mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let wsUrl = null;
async function getWsUrl() {
  let up = false;
  try { up = !!(await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch {}
  if (!up) {
    spawn('chrome-headless', ['--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--user-data-dir=/tmp/chrome_ak11', '--window-size=1400,900', 'about:blank'], { detached: true, stdio: 'ignore' });
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
  if (key === 'Backspace') return 8;
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  if (lower.includes(key.toLowerCase())) return 65 + lower.indexOf(key.toLowerCase());
  if (/\d/.test(key)) return 48 + parseInt(key);
  return 0;
}

async function canvasOrigin() {
  const box = await evalJs(`(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return JSON.stringify([r.x, r.y]); })()`);
  return JSON.parse(box);
}

// CDP Input.dispatchMouseEvent is blind in this chrome-headless-shell (canvas listeners never
// fire), so drive the measure flow with synthetic JS MouseEvents on #cv instead.
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

async function moveAt(x, y) {
  await fireMouse('mousemove', x, y, 0);
}

async function clickAt(x, y) {
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

  // --- measure via key u ---
  const entBefore = await evalJs(`window.__ak.state.doc.entities.length`);
  await typeKey('u');
  await sleep(150);
  const t1 = await evalJs(`window.__ak.state.tool + '|' + window.__ak.state.pending.length`);
  pass('key u starts measure', t1.startsWith('measure|0'), t1);

  const prompt1 = await evalJs(`document.getElementById('prompt').textContent`);
  pass('prompt first point', /Measure: pick first point/i.test(prompt1), prompt1);

  await clickAt(600, 400);
  await sleep(150);
  const t2 = await evalJs(`window.__ak.state.pending.length`);
  pass('first click sets pending', t2 === 1, 'pending=' + t2);
  const prompt2 = await evalJs(`document.getElementById('prompt').textContent`);
  pass('prompt second point', /second point/i.test(prompt2), prompt2);

  // HUD shows live distance during preview (mousemove)
  await moveAt(900, 400);
  await sleep(200);
  const hud = await evalJs(`(() => {
    const row = document.getElementById('hud-measure');
    return JSON.stringify({ row: row ? row.style.display : null, hl: document.getElementById('hl') ? document.getElementById('hl').textContent : null });
  })()`);
  const hj = JSON.parse(hud);
  const dist = parseFloat(hj.hl);
  pass('HUD #hl shows live distance', hj.row === 'flex' && isFinite(dist) && dist > 0, hud);

  // second click commits
  await clickAt(900, 400);
  await sleep(200);
  const mr = await evalJs(`JSON.stringify(window.__ak.state.measureResult)`);
  const mj = JSON.parse(mr);
  const d = Math.hypot(mj.b[0] - mj.a[0], mj.b[1] - mj.a[1]);
  pass('measureResult committed', Array.isArray(mj.a) && Array.isArray(mj.b) && Math.abs(d - dist) < 5, mr + ' expected~' + dist);
  const entCount = await evalJs(`window.__ak.state.doc.entities.length`);
  pass('measure commits no entity', entCount === entBefore, 'entities=' + entCount + ' before=' + entBefore);

  const prompt3 = await evalJs(`document.getElementById('prompt').textContent`);
  pass('prompt measured', /Measured/i.test(prompt3), prompt3);

  // --- measure via toolbar button ---
  const btn = await evalJs(`(() => {
    const b = document.querySelector('button.tool[title*="U)"][title*="easure"], button.tool[data-tool="measure"], button.tool[title*="Measure"]');
    if (!b) return null; b.click(); return b.getAttribute('title') || b.textContent.trim();
  })()`);
  pass('toolbar measure button found+click', !!btn, JSON.stringify(btn));
  await sleep(150);
  const t3 = await evalJs(`window.__ak.state.tool`);
  pass('button starts measure', t3 === 'measure', t3);

  await clickAt(650, 450);
  await sleep(120);
  await clickAt(850, 450);
  await sleep(200);
  const mr2 = await evalJs(`JSON.stringify(window.__ak.state.measureResult)`);
  const mj2 = JSON.parse(mr2);
  pass('button measure completes', Array.isArray(mj2.a) && Array.isArray(mj2.b), mr2);

  // Escape resets
  await typeKey('Escape');
  await sleep(150);
  const t4 = await evalJs(`window.__ak.state.tool + '|' + (window.__ak.state.measureResult ? 'kept' : 'null')`);
  pass('escape ends measure', !t4.startsWith('measure|'), t4);

  // dashed line label renders (canvas draw check via screenshot)
  await typeKey('u'); await sleep(120);
  await clickAt(600, 400); await sleep(120);
  await clickAt(900, 430); await sleep(200);
  await cdp.send('Page.captureScreenshot', { format: 'png' }).then(async r => {
    fs.writeFileSync(OUT + '/r11_measure.png', Buffer.from(r.data, 'base64'));
  });
  const shot = fs.existsSync(OUT + '/r11_measure.png');
  pass('screenshot saved', shot, OUT + '/r11_measure.png');

  const np = results.filter(r => r.ok).length;
  console.log(`\n${np}/${results.length} passed`);
  fs.writeFileSync('/tmp/cb_results11.json', JSON.stringify(results, null, 2));
  process.exit(np === results.length ? 0 : 1);
}

main().catch(e => { console.error('SCRIPT ERROR', e); process.exit(2); });
