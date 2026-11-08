import fs from 'node:fs';
import assert from 'node:assert/strict';

const html = fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');

const shortcuts = ['Select</b>', 'Line</b>', 'Polyline</b>', 'Rectangle</b>', 'Circle</b>', 'Arc</b>', 'Text</b>', 'Dimension</b>', 'Measure</b>', 'Move</b>', 'Erase</b>', 'Rotate</b>', 'Vertex edit</b>', 'Offset</b>', 'Fillet</b>', 'Trim</b>', 'Extend</b>', 'Object snap</b>', 'Grid snap</b>', 'Ortho</b>', 'Polar snap</b>'];

// Guide completeness: every toolbar tool button has a guide entry (authoritative content check).
const toolIds = [...html.matchAll(/data-tool="([a-z]+)"/g)].map(m => m[1]);
const guideAll = html.match(/<div class="guide-content" id="guideContent"[\s\S]*?<p class="guide-empty"/);
assert.ok(guideAll, 'guide content block found');
const guideText = guideAll[0].toLowerCase();
for (const id of new Set(toolIds)) {
  if (id === 'select') continue; // select is a mode, covered by the Select entry
  assert.ok(guideText.includes(id), `guide covers toolbar tool: ${id}`);
}
assert.ok(guideText.includes('mirror'), 'guide covers mirror buttons');
assert.ok(guideText.includes('array'), 'guide covers array buttons');
for (const item of shortcuts) assert.ok(html.includes(item), `guide entry exists: ${item}`);
for (const shortcut of ['Ctrl C', 'Ctrl V', 'Ctrl Z', 'Shift X/Y', 'Shift A', 'Shift P', 'F3', 'F7', 'F8', 'F9', 'F10']) assert.ok(html.includes(`<kbd>${shortcut}</kbd>`), `shortcut exists: ${shortcut}`);
assert.match(html, /role="region" aria-labelledby="commandGuideTitle"/);
assert.match(html, /aria-controls="commandGuide" aria-expanded="false"/);
assert.match(html, /data-search="[^"]+"/);
assert.match(html, /Escape closes this guide/);
assert.match(html, /distance&lt;angle/);
assert.match(js, /function setCommandGuide\(open\)/);
assert.match(js, /ev\.key === '\?' \|\| \(ev\.shiftKey && ev\.key === '\/'\)/);
assert.match(js, /guideSearch\.addEventListener\('input'/);
assert.match(js, /ev\.target\.id !== 'guideSearch'/);
assert.match(css, /@media\(max-width:700px\)/);
assert.match(css, /\.guide-row\{min-height:44px/);

// Exercise the actual open/close helper against a minimal DOM shim.
const elements = Object.fromEntries(['commandGuide', 'btnCommandGuide', 'guideSearch'].map(id => [id, {
  id, attrs: {}, visible: false,
  classList: { toggle(_name, value) { elements[id].visible = value; }, contains() { return elements[id].visible; } },
  setAttribute(name, value) { this.attrs[name] = value; },
  focus() { document.activeElement = this; },
}]));
const document = { activeElement: null, getElementById(id) { return elements[id] || null; } };
const start = js.indexOf('function setCommandGuide(open)');
const end = js.indexOf("window.addEventListener('keydown'", start);
assert.ok(start >= 0 && end > start, 'guide helper is available');
new Function('document', 'commandGuide', 'btnCommandGuide', 'guideSearch', `${js.slice(start, end)}; setCommandGuide(true); if (!commandGuide.classList.contains('show')) throw Error('did not open'); setCommandGuide(false);`)(document, elements.commandGuide, elements.btnCommandGuide, elements.guideSearch);
assert.equal(elements.commandGuide.attrs['aria-hidden'], 'true');
assert.equal(elements.btnCommandGuide.attrs['aria-expanded'], 'false');
console.log('round28 guide static + interaction checks passed');
