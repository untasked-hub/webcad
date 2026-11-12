// Round-44 verification: reference image underlay with 2-point calibration.
// Real DOM via CDP against a local server.
import { spawn } from 'node:child_process';

const PORT = 9351;
const BASE = 'http://localhost:8080';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = (v) => (JSON.stringify(v) === undefined ? 'null' : JSON.stringify(v));
const S = (v) => (typeof v === 'string' ? JSON.stringify(v.slice(0, 200)) : String(v));

async function getWsUrl() {
  try { const j = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json(); if (j.webSocketDebuggerUrl) return true; } catch (e) {}
  spawn('chrome-headless', ['--remote-debugging-port=' + PORT, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--user-data-dir=/tmp/chrome_ak44_' + Date.now(), '--window-size=1400,900', 'about:blank'], { detached: true, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    try { const j = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json(); if (j.webSocketDebuggerUrl) return true; } catch (e) {}
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
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && c.pending.has(m.id)) { c.pending.get(m.id)(m); c.pending.delete(m.id); } };
    return c;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
      this.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  }
}

let cdp = null;
let pass = 0, fail = 0;
function pass1(name, ok, detail) { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' -- ' + detail : '')); }

async function evalJs(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('evalJs: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result ? r.result.value : undefined;
}

function makeFile(w, h) {
  return '(async () => {' +
    'const c = document.createElement("canvas"); c.width = ' + w + '; c.height = ' + h + ';' +
    'const g = c.getContext("2d");' +
    'g.fillStyle = "#204060"; g.fillRect(0, 0, ' + w + ', ' + h + ');' +
    'g.strokeStyle = "#ffffff"; g.lineWidth = 3; g.strokeRect(10, 10, ' + (w - 20) + ', ' + (h - 20) + ');' +
    'const blob = await new Promise(function(r){ c.toBlob(r, "image/png"); });' +
    'const f = new File([blob], "ref.png", { type: "image/png" });' +
    'const res = await window.__ak.readUnderlayFile(f);' +
    'window.__ak.setUnderlay(res.src, res.name, res.iw, res.ih);' +
    'return JSON.stringify({ iw: res.iw, ih: res.ih, chars: res.src.length, prefix: res.src.slice(0, 23) });' +
  '})()';
}

async function main() {
  if (!(await getWsUrl())) { console.log('FAIL setup: no debug port'); process.exit(1); }
  let pageWs = null;
  for (let i = 0; i < 20; i++) {
    const targets = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json();
    const page = targets.find(t => t.type === 'page');
    if (page) { pageWs = page.webSocketDebuggerUrl; break; }
    await sleep(500);
  }
  cdp = await Cdp.connect(pageWs);
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Page.navigate', { url: BASE + '?rnd44=' + Date.now() });
  await sleep(3000);

  const fns = ['readUnderlayFile', 'setUnderlay', 'clearUnderlay', 'calibrateUnderlay',
    'startUnderlayCalibrate', 'underlayBBox', 'placeUnderlay', 'loadDoc'];
  for (const fn of fns) pass1('__ak.' + fn + ' exported', await evalJs('typeof window.__ak.' + fn + ' === "function"'));

  await evalJs('(function(){ var s = window.__ak.state; s.doc.underlay = null; s.calibPts = []; s.doc.entities = []; window.__ak.renderUnderlayPanel(); return 1; })()');
  pass1('idle panel offers Import image', await evalJs('!!document.getElementById("btnUnderlayImport")'));
  pass1('calibrate modal markup present', await evalJs('!!document.getElementById("calModal") && !!document.getElementById("calDist")'));
  pass1('hidden underlay file input present', await evalJs('(function(){ var i = document.getElementById("fileUnderlay"); return !!i && i.type === "file"; })()'));

  const imp = JSON.parse(await evalJs(makeFile(800, 600)));
  pass1('import encodes a JPEG data URL', imp.prefix.indexOf('data:image/jpeg') === 0, S(imp.prefix));
  pass1('800x600 import keeps native size', imp.iw === 800 && imp.ih === 600, imp.iw + 'x' + imp.ih);
  pass1('underlay stored on the document', await evalJs('!!window.__ak.state.doc.underlay'));
  pass1('underlay adds no entities', (await evalJs('window.__ak.state.doc.entities.length')) === 0);
  pass1('underlay visible and layer-less (non-snapping)', await evalJs('(function(){ var u = window.__ak.state.doc.underlay; return u.visible === true && u.layer === undefined; })()'));
  const bb = JSON.parse(await evalJs('JSON.stringify(window.__ak.underlayBBox(window.__ak.state.doc.underlay))'));
  pass1('placement has positive world size', bb.x1 > bb.x0 && bb.y1 > bb.y0, J(bb));
  const ratio = (bb.x1 - bb.x0) / (bb.y1 - bb.y0);
  pass1('placement preserves aspect ratio', Math.abs(ratio - 800 / 600) < 0.01, 'ratio=' + ratio.toFixed(3));
  pass1('panel labels the reference as locked', /locked/.test(await evalJs('document.getElementById("underlayBody").textContent')));

  const big = JSON.parse(await evalJs(makeFile(4000, 2000)));
  pass1('large import downscaled to 1600 long edge', Math.max(big.iw, big.ih) === 1600, big.iw + 'x' + big.ih);
  pass1('encoded payload under the cap', big.chars < 3.2 * 1024 * 1024, 'chars=' + big.chars);
  const refusal = await evalJs('(async function(){ var f = new File([new Uint8Array(5*1024*1024)], "huge.png", { type: "image/png" }); try { await window.__ak.readUnderlayFile(f); return "accepted"; } catch (e) { return "rejected: " + e.message; } })()');
  pass1('>4 MB source refused', String(refusal).indexOf('rejected') === 0, S(refusal));
  const notImage = await evalJs('(async function(){ var f = new File(["hello"], "a.txt", { type: "text/plain" }); try { await window.__ak.readUnderlayFile(f); return "accepted"; } catch (e) { return "rejected: " + e.message; } })()');
  pass1('non-image file refused', String(notImage).indexOf('rejected') === 0, S(notImage));

  await evalJs(makeFile(800, 600));
  const cal = JSON.parse(await evalJs('(function(){ var ak = window.__ak, s = ak.state, u = s.doc.underlay; u.x = 0; u.y = 0; u.w = 100; u.h = 75; u.opacity = 0.55; s.calibPts = [[0,0],[50,0]]; var r = ak.calibrateUnderlay(500); return JSON.stringify({ r: r, u: { x: u.x, y: u.y, w: u.w, h: u.h, calibrated: u.calibrated } }); })()'));
  pass1('calibration accepted', !!cal.r && cal.r.ok === true, J(cal.r));
  pass1('scale factor k = real / measured', Math.abs(cal.r.k - 10) < 1e-9, 'k=' + cal.r.k);
  pass1('w and h scale by k', Math.abs(cal.u.w - 1000) < 1e-6 && Math.abs(cal.u.h - 750) < 1e-6, J(cal.u));
  pass1('anchor point stays fixed', Math.abs(cal.u.x) < 1e-9 && Math.abs(cal.u.y) < 1e-9, J(cal.u));
  pass1('calibration records the real distance', cal.u.calibrated === 500, 'calibrated=' + cal.u.calibrated);
  const bad = JSON.parse(await evalJs('(function(){ var s = window.__ak.state; s.calibPts = [[0,0],[0,0]]; var a = window.__ak.calibrateUnderlay(100); s.calibPts = [[0,0],[10,0]]; var b = window.__ak.calibrateUnderlay(-5); return JSON.stringify({ a: a && a.ok, b: b && b.ok, reasonA: a && a.reason }); })()'));
  pass1('identical picks rejected', bad.a === false, S(bad.reasonA));
  pass1('negative distance rejected', bad.b === false);

  const flow = JSON.parse(await evalJs('(function(){ var ak = window.__ak, s = ak.state; s.doc.underlay.x = 0; s.doc.underlay.y = 0; s.doc.underlay.w = 100; s.doc.underlay.h = 75; s.calibPts = [[0,0],[20,0]]; ak.openCalibrateModal(20); var opened = document.getElementById("calModal").classList.contains("show"); document.getElementById("calDist").value = "100"; ak.submitCalibrateModal(); var closed = !document.getElementById("calModal").classList.contains("show"); return JSON.stringify({ opened: opened, closed: closed, w: s.doc.underlay.w }); })()'));
  pass1('2-pt pick opens the calibrate modal', flow.opened === true, J(flow));
  pass1('modal closes and scales the underlay', flow.closed === true && Math.abs(flow.w - 500) < 1e-6, J(flow));

  await evalJs('(function(){ var sl = document.getElementById("underlayOpacity"); if (sl) { sl.value = "30"; sl.dispatchEvent(new Event("input", { bubbles: true })); } return 1; })()');
  const op = await evalJs('window.__ak.state.doc.underlay.opacity');
  pass1('opacity slider updates the underlay', Math.abs(op - 0.30) < 0.02, 'opacity=' + op);
  await evalJs('document.getElementById("btnUnderlayToggle").click()');
  pass1('toggle hides the underlay', (await evalJs('window.__ak.state.doc.underlay.visible')) === false);
  await evalJs('document.getElementById("btnUnderlayToggle").click()');
  pass1('toggle shows the underlay again', (await evalJs('window.__ak.state.doc.underlay.visible')) === true);

  const rt = await evalJs('(function(){ var s = window.__ak.state; var before = s.doc.underlay.src.length; var payload = JSON.parse(JSON.stringify({ name: s.doc.name, layers: s.doc.layers, entities: s.doc.entities, currentLayer: s.doc.currentLayer, underlay: s.doc.underlay || null })); window.__ak.loadDoc(payload); var u = window.__ak.state.doc.underlay; return JSON.stringify({ kept: !!u, chars: u ? u.src.length : 0, before: before }); })()');
  const rj = JSON.parse(rt);
  pass1('JSON round trip keeps the underlay', rj.kept === true && rj.chars === rj.before, rt);

  await evalJs('(function(){ var s = window.__ak.state; s.doc.layers = [{ name: "0", color: "#dddddd", visible: true, locked: false, lineweight: 1 }]; s.doc.entities = [{ id: "e1", type: "line", layer: "0", p1: [0,0], p2: [100,0] }]; s.doc.currentLayer = "0"; s.sel = new Set(); return 1; })()');
  const svg = await evalJs('window.__ak.buildSVGString("#0b1017").svg');
  pass1('SVG export contains the line', svg.indexOf('<line') !== -1);
  pass1('SVG export omits the underlay', svg.indexOf('data:image/jpeg') === -1 && svg.indexOf('<image') === -1, 'len=' + String(svg).length);
  const dxfPlan = await evalJs('(function(){ var p = window.__ak.buildDXFExportPlan("mm"); return JSON.stringify({ len: p.content.length, summary: p.summary }); })()');
  const dj = JSON.parse(dxfPlan);
  pass1('DXF export runs', dj.len > 100, 'len=' + dj.len);
  pass1('DXF export notes the omitted underlay', /underlay/i.test(dj.summary), S(dj.summary));

  await evalJs('window.__ak.clearUnderlay()');
  pass1('remove clears the underlay', (await evalJs('window.__ak.state.doc.underlay')) === null);
  pass1('entities survive removal', (await evalJs('window.__ak.state.doc.entities.length')) === 1);
  pass1('panel returns to the Import image state', await evalJs('!!document.getElementById("btnUnderlayImport")'));

  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log('FAIL fatal ' + e.message); process.exit(1); });
