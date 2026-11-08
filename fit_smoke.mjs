// Smoke check: zoom-to-fit (btnFit + 'f' key). Raw CDP client, no deps.
// View state is at window.__WebCAD.state.view = {x, y, zoom}.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const URL_ = process.env.APP_URL || 'http://127.0.0.1:8080';
const user = 'fit' + Date.now().toString(36);
const pass = 'pw-' + Math.random().toString(36).slice(2);

function cdpPort(chrome) {
  return new Promise((res, rej) => {
    let out = '';
    chrome.stderr.on('data', d => { out += d; const m = out.match(/ws:\/\/127\.0\.0\.1:(\d+)/); if (m) res(+m[1]); });
    chrome.on('exit', () => rej(new Error('chrome exited: ' + out)));
  });
}

async function main() {
  const chrome = spawn('chrome-headless', ['--remote-debugging-port=0', '--no-sandbox', '--disable-gpu', '--user-data-dir=/tmp/cdp-' + Date.now(), '--window-size=1280,900', 'about:blank']);
  const port = await cdpPort(chrome);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find(t => t.type === 'page');
  if (typeof WebSocket === 'undefined') throw new Error('no global WebSocket');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  const events = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    else if (m.method) events.push(m);
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: URL_ });
  await sleep(1500);
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

  await sleep(1000);
  const bootInfo = await ev(`(() => ({ ready: document.readyState, hasAK: !!(window.__ak && window.__ak.state), hasHook: !!window.__WebCAD, doc: (window.__WebCAD && window.__WebCAD.state && !!window.__WebCAD.state.doc) || false, title: document.title, body: document.body ? document.body.innerText.slice(0,200) : '' }))()`);
  console.log('BOOT', JSON.stringify(bootInfo));

  // sign up via the auth modal (same flow as verify_round9)
  const signup = await ev(`(async()=>{window.__ak.openAuth('register');await new Promise(r=>setTimeout(r,300));document.getElementById('authUser').value=${JSON.stringify(user)};document.getElementById('authPass').value=${JSON.stringify(pass)};window.__ak.submitAuth();await new Promise(r=>setTimeout(r,1800));return window.__ak.currentUser})()`);
  // open first drawing if needed
  await ev(`(async()=>{const li=document.querySelector('#drawingList li'); if(li){li.click();await new Promise(r=>setTimeout(r,800));}})()`);

  const readView = () => ev(`(() => { const s = window.__WebCAD && window.__WebCAD.state; return s && s.doc ? JSON.stringify(s.view) : 'nodoc'; })()`);

  // Destructure the view: huge zoom, pan far off-content
  await ev(`(() => { const s = window.__WebCAD.state; if (s.doc) { s.view.zoom = 25; s.view.x = 90000; s.view.y = -90000; draw && draw(); } return 'ok'; })()`);
  const before = await readView();

  // press F key
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'f',bubbles:true}))`);
  await sleep(300);
  const afterF = await readView();
  // click the Fit button too
  await ev(`(() => { const b = document.getElementById('btnFit') || document.getElementById('btnZoomExt'); if (b) b.click(); })()`);
  await sleep(300);
  const afterBtn = await readView();

  const jsErrors = events.filter(e => e.method === 'Runtime.exceptionThrown').map(e => JSON.stringify(e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text));

  const parse = j => { try { return JSON.parse(j); } catch { return null; } };
  const b = parse(before), af = parse(afterF), ab = parse(afterBtn);
  const moved = j => j && (j.zoom !== b.zoom || Math.abs(j.x - b.x) > 1 || Math.abs(j.y - b.y) > 1);
  const settled = j => af && ab && Math.abs(af.zoom - ab.zoom) < 0.01 && Math.abs(af.x - ab.x) < 1 && Math.abs(af.y - ab.y) < 1;

  const ok = !!(b && moved(af) && moved(ab) && settled(af) && jsErrors.length === 0);
  console.log(JSON.stringify({ user, signup: String(signup ?? '').slice(0, 80), before, afterF, afterBtn, jsErrors, pass: ok }, null, 2));
  ws.close(); chrome.kill();
  process.exit(ok ? 0 : 1);
}
main().catch(e => { console.error('FAIL', e); process.exit(2); });
