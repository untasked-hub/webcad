// Round-15 verify: Duplicate drawing hardening.
// 1. duplicate without custom name -> "X (copy)", twice -> "X (copy 2)" (auto-numbering, no collision)
// 2. duplicate with custom name -> that name, trimmed, >120 chars truncated
// 3. custom name colliding with existing is allowed (explicit choice)
// 4. owner-scoped: another user duplicating -> 403
// 5. UI guard: Duplicate button disabled while request in flight
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 9339;
const BASE = 'http://localhost:8080';
const OUT = '/tmp/cdp_out';
fs.mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getWsUrl() {
  let up = false;
  try { up = !!(await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch {}
  if (!up) {
    spawn('chrome-headless', ['--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--user-data-dir=/tmp/chrome_ak15', '--window-size=1400,900', 'about:blank'], { detached: true, stdio: 'ignore' });
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

// Cookie-session fetch from Node against the local server.
const jars = new Map(); // user -> cookie string
async function api(user, method, path, body) {
  const headers = {};
  if (jars.get(user)) headers.Cookie = jars.get(user);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const setc = res.headers.get('set-cookie');
  if (setc) jars.set(user, setc.split(';')[0]);
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

async function register(user) {
  return api(user, 'POST', '/api/auth/register', { username: user, password: 'secret123' });
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

  const suffix = Date.now().toString().slice(-7);
  const A = 'r15a' + suffix, B = 'r15b' + suffix;
  const ra = await register(A);
  pass('register A', ra.status === 201, 'status=' + ra.status);
  const rb = await register(B);
  pass('register B', rb.status === 201, 'status=' + rb.status);

  // A creates a drawing with a known name.
  const doc = { version: 1, units: 'mm', entities: [{ type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, layer: '0' }] };
  const mk = await api(A, 'POST', '/api/drawings', { name: 'Bracket A', data: JSON.stringify(doc) });
  pass('create drawing', mk.status === 201 && mk.json && mk.json.drawing, JSON.stringify(mk.json || mk.status));
  const id = mk.json && mk.json.drawing && mk.json.drawing.id;

  // 1. auto-numbering: duplicate x2 with no name
  const d1 = await api(A, 'POST', `/api/drawings/${id}/duplicate`, {});
  pass('duplicate #1 -> (copy)', d1.status === 201 && d1.json.drawing.name === 'Bracket A (copy)', JSON.stringify(d1.json));
  const d2 = await api(A, 'POST', `/api/drawings/${id}/duplicate`, {});
  pass('duplicate #2 -> (copy 2)', d2.status === 201 && d2.json.drawing.name === 'Bracket A (copy 2)', JSON.stringify(d2.json));
  const d3 = await api(A, 'POST', `/api/drawings/${id}/duplicate`, {});
  pass('duplicate #3 -> (copy 3)', d3.status === 201 && d3.json.drawing.name === 'Bracket A (copy 3)', JSON.stringify(d3.json));

  // 2. custom name, trimmed
  const dc = await api(A, 'POST', `/api/drawings/${id}/duplicate`, { name: '  Stamped Rev B  ' });
  pass('custom name trimmed', dc.status === 201 && dc.json.drawing.name === 'Stamped Rev B', JSON.stringify(dc.json));

  // 3. custom name longer than 120 chars is truncated
  const longName = 'X'.repeat(200);
  const dl = await api(A, 'POST', `/api/drawings/${id}/duplicate`, { name: longName });
  pass('long name truncated to 120', dl.status === 201 && dl.json.drawing.name.length === 120, 'len=' + (dl.json.drawing.name || '').length);

  // 4. owner-scoped: B cannot duplicate A's drawing
  const forbidden = await api(B, 'POST', `/api/drawings/${id}/duplicate`, {});
  pass('non-owner 403', forbidden.status === 403, JSON.stringify(forbidden));

  // B duplicating their own drawing works and auto-numbers independently
  const mkB = await api(B, 'POST', '/api/drawings', { name: 'Bracket A', data: JSON.stringify(doc) });
  const dupB = await api(B, 'POST', `/api/drawings/${mkB.json.drawing.id}/duplicate`, {});
  pass('per-owner numbering', dupB.status === 201 && dupB.json.drawing.name === 'Bracket A (copy)', JSON.stringify(dupB.json));

  // UI guard: Duplicate button disables while in flight
  await evalJs(`window.__ak.loadAuthed ? true : true`);
  const list = await evalJs(`(async () => {
    // sign in as A in the page and open the drawings panel
    return typeof window.__ak;
  })()`);
  const guard = await evalJs(`(async () => {
    const s = window.__ak;
    if (!s) return 'no __ak';
    // open auth, log in as A
    s.openAuth('login');
    document.getElementById('authUser').value = '${A}';
    document.getElementById('authPass').value = 'secret123';
    await s.submitAuth();
    await new Promise(r => setTimeout(r, 1500));
    // open the drawings modal, which renders Duplicate buttons per row
    document.getElementById('btnOpen').click();
    await new Promise(r => setTimeout(r, 1200));
    const btns = Array.from(document.querySelectorAll('#drawingList button')).filter(b => b.textContent === 'Duplicate');
    if (!btns.length) return 'no duplicate buttons';
    const btn = btns[0];
    btn.click(); btn.click(); btn.click();
    const busyNow = btn.disabled || btn.dataset.busy === '1';
    await new Promise(r => setTimeout(r, 1200));
    return JSON.stringify({ busyNow, labelAfter: btn.textContent, disabledAfter: btn.disabled });
  })()`);
  let g = {};
  try { g = JSON.parse(guard); } catch { g = { raw: guard }; }
  pass('UI guard busy', g.busyNow === true, JSON.stringify(g));
  pass('UI guard restored', g.labelAfter === 'Duplicate' && g.disabledAfter === false, JSON.stringify(g));

  const fails = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} checks passed`);
  process.exit(fails ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
