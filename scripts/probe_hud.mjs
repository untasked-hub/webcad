// One-off CDP probe: does updateMeasureHud actually run on a real mousemove?
import { spawn } from 'node:child_process';

const BASE = 'http://localhost:8080';
const CHROME = '/usr/bin/chrome-headless-shell || /usr/bin/google-chrome || /usr/bin/chromium';

function waitPort(port, ms) {
  return new Promise((res) => {
    const t0 = Date.now();
    (function check() {
      fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json()).then(() => res(true)).catch(() => {
        if (Date.now() - t0 > ms) res(false); else setTimeout(check, 250);
      });
    })();
  });
}

const chrome = spawn('bash', ['-c', `chrome-headless || chrome-headless-shell || google-chrome || chromium --headless --remote-debugging-port=9333 --no-sandbox --disable-gpu --window-size=1400,900 about:blank`], { stdio: 'ignore' });

const up = await waitPort(9333, 15000);
console.log('chrome up:', up);
if (!up) { process.exit(1); }

const targets = await (await fetch('http://127.0.0.1:9333/json')).json();
let page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
function send(method, params = {}) {
  return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
}
const events = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  else if (d.method) events.push(d.method);
};
await new Promise(r => ws.onopen = r);

await send('Page.enable');
await send('Runtime.enable');
// Console listener: log console messages that mention measure/HUD
send('Runtime.consoleAPICalled', {});
const consoleLog = [];
ws.on('message', ()=>{}); // noop
await send('Page.navigate', { url: BASE });
await new Promise(r => setTimeout(r, 2500));

await send('Runtime.evaluate', { expression: `document.body.focus?.()` });

// Press 'u' to select measure tool
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'u', code: 'KeyU', windowsVirtualKeyCode: 85, text: 'u' });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'u', code: 'KeyU', windowsVirtualKeyCode: 85 });
await new Promise(r => setTimeout(r, 300));

// Real mouse sequence: press at 600,400 then move (raw) to 900,400
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 600, y: 400, button: 'left', buttons: 1, clickCount: 1 });
await new Promise(r => setTimeout(r, 150));
await send('Input.dispatchMouseEvent', { type: 'mousemove', x: 900, y: 400, buttons: 1 });
await new Promise(r => setTimeout(r, 200));

const probe = await send('Runtime.evaluate', {
  expression: `(() => {
    const row = document.getElementById('hud-measure');
    const hl = document.getElementById('hl');
    const cs = row ? getComputedStyle(row).display : 'no-row';
    const styleAttr = row ? row.getAttribute('style') : 'no-row';
    // listeners info: can't enumerate natively; check app state instead
    const state = (window.__WebCADDebug || window.state || null);
    return JSON.stringify({
      rowHTML: row ? row.outerHTML : null,
      display: cs,
      styleAttr,
      hlText: hl ? hl.textContent : null,
      activeTool: window.__lastTool ?? null
    });
  })()`,
  returnByValue: true,
});
console.log('AFTER move-inside-drag:', probe.result.result.value);

// Now move without buttons (plain hover)
await send('Input.dispatchMouseEvent', { type: 'mouseup', x: 900, y: 400, button: 'left', buttons: 0, clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mousemove', x: 950, y: 420, buttons: 0 });
await new Promise(r => setTimeout(r, 200));
const probe2 = await send('Runtime.evaluate', {
  expression: `(() => {
    const row = document.getElementById('hud-measure');
    return JSON.stringify({ rowHTML: row ? row.outerHTML : null, display: row ? getComputedStyle(row).display : null });
  })()`,
  returnByValue: true,
});
console.log('AFTER plain hover:', probe2.result.result.value);

// Check what tool is active / whether 'u' did anything
const tool = await send('Runtime.evaluate', {
  expression: `(() => {
    const btns = [...document.querySelectorAll('[data-tool], .tool-btn, .toolbar [data-action]')].map(b => ({id: b.id, cls: b.className, data: b.dataset.tool, active: b.classList.contains('active')}));
    return JSON.stringify(btns.slice(0, 30));
  })()`,
  returnByValue: true,
});
console.log('TOOLBAR:', tool.result.result.value);

chrome.kill();
process.exit(0);
