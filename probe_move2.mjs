
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'], headless: 'new' });
const pg = await b.newPage();
await pg.goto('http://127.0.0.1:8080', { waitUntil: 'networkidle0' });
const ev = (js) => pg.evaluate(js).catch(e => 'ERR:' + e.message);
await ev(`(() => {
  const s = window.__ak.state;
  s.doc.entities.length = 0;
  s.doc.entities.push({ id: 'r0', type: 'line', layer: '0', p1: [0, 0], p2: [40, 0] });
  s.view = { x: 0, y: 0, zoom: 1 };
  s.sel = new Set(['r0']);
  s.undo.length = 0;
  document.querySelector('[data-tool="move"]').click();
  return { tool: s.tool, selSize: s.sel.size, ents: JSON.stringify(s.doc.entities) };
})()`);
const g1 = await ev(`JSON.stringify(window.__WebCAD.w2s([20,0]))`);
console.log('g1', g1);
const [gx, gy] = JSON.parse(g1);
const r = await ev(`(() => { const cv=document.getElementById('cv'); const rr=cv.getBoundingClientRect(); return JSON.stringify([rr.left,rr.top,rr.width,rr.height]); })()`);
console.log('rect', r);
const res = await ev(`(() => {
  const cv = document.getElementById('cv');
  const e = new MouseEvent('mousedown', { clientX: ${r && JSON.parse(r)[0] ? 0 : 0} + (${gx}), clientY: ${gy}, button: 0, bubbles: true });
  cv.dispatchEvent(e);
  const s = window.__ak.state;
  return JSON.stringify({ drag: s.drag ? { mode: s.drag.mode } : null, selSize: s.sel.size, tool: s.tool, mouseWorld: s.mouseWorld });
})()`);
console.log('after mousedown', res);
await b.close();
