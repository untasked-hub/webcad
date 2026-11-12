import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const src = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const syntax = spawnSync(process.execPath, ['--check', new URL('./public/app.js', import.meta.url).pathname], { encoding: 'utf8' });
assert.equal(syntax.status, 0, syntax.stderr || 'app.js syntax check failed');
const start = src.indexOf('const SB_STEPS =');
const end = src.indexOf('\nfunction drawScaleBar()', start);
assert.ok(start >= 0 && end > start, 'scale-bar model block exists');
const context = { state: { doc: null, view: { zoom: 1 } }, fmt: n => Number(n.toFixed(2)).toString() };
vm.runInNewContext(src.slice(start, end) + '\nglobalThis.model = scaleBarModel;', context);
const model = context.model;
for (const [units, zoom] of [['mm', 1], ['mm', 0.01], ['in', 1], ['in', 0.1], [null, 1], ['mm', 20], ['in', 0.02]]) {
  context.state.doc = { units };
  context.state.view.zoom = zoom;
  const m = model();
  assert.ok(Number.isFinite(m.world) && m.world > 0, `positive world distance for ${units}/${zoom}`);
  assert.ok(m.px >= 12 && m.px <= 160, `readable bar width for ${units}/${zoom}: ${m.px}`);
  assert.ok(m.label.length > 0, `visible label for ${units}/${zoom}`);
  assert.equal(m.zoom, zoom);
}
context.state.doc = { units: 'mm' }; context.state.view.zoom = 0.01;
assert.match(model().label, /m$/, 'large metric distance is shown in metres');
context.state.doc = { units: 'in' }; context.state.view.zoom = 0.1;
assert.match(model().label, /ft$/, 'large imperial distance is shown in feet');
context.state.doc = { units: 'mm' }; context.state.view.zoom = 1;
assert.match(model().label, /mm$/, 'small metric distance is shown in millimetres');
assert.match(src, /drawScaleBar\(\);/, 'scale bar is included in canvas draw cycle');
assert.match(src, /getElementById\('hun'\)/, 'units HUD is refreshed');
assert.match(src, /fmt\(r\(len\)\) \+ sbUnitsLabel\(\)/, 'live measurement length includes document units');
const html = fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
assert.match(html, /id="hun"/, 'units HUD target exists in page');
console.log('Round 11 scale-bar checks passed (7 zoom/unit combinations, metric/imperial labels, draw wiring, HUD units, JS syntax).');
