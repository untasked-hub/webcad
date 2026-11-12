// Round 23: live length/angle readout during draw and move
// Checks: HUD row exists & pointer-events:none CSS; updateMeasureHud is rAF-throttled (hudRaf/requestAnimationFrame);
// angle formatted with fmt() + ° like measure tool; move uses drag.base anchor; display-only (no save-format/undo references).
import { readFileSync } from 'fs';
const app = readFileSync('public/app.js', 'utf-8');
const css = readFileSync('public/style.css', 'utf-8');
const html = readFileSync('public/index.html', 'utf-8');
let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : (fail++, console.log('FAIL', n)); console.log(c ? 'PASS' : '----', n); };

ok('hud-measure row exists in HTML', html.includes('id="hud-measure"'));
ok('HUD overlay pointer-events:none', /pointer-events:\s*none/.test(css.slice(css.indexOf('.hud{'), css.indexOf('.hud{') + 400)));
ok('rAF throttle: requestAnimationFrame wrapper', app.includes('hudRaf = requestAnimationFrame'));
ok('rAF throttle: only update via frame callback', app.includes('function renderMeasureHud(p)'));
ok('angle uses shared deg() helper', app.includes('let ang = deg(Math.atan2(dy, dx))'));
ok('angle formatted with fmt() + degree sign like measure tool', app.includes("fmt(r(ang)) + '°'"));
ok('move/drag uses drag.base as anchor', /state\.drag && state\.drag\.base/.test(app));
ok('pending point anchor for drawing', /state\.pending\[state\.pending\.length - 1\]/.test(app));
ok('display-only: HUD code touches no doc model', !/pushUndo|saveDoc|doc\.ents/.test(app.slice(app.indexOf('let hudPending'), app.indexOf('/* ---------- pointer events'))));
// all HUD DOM writes must be inside the rAF callback: extract the callback body and ensure
// no getElementById(...).textContent write occurs in the mousemove handler outside it.
const rafStart = app.indexOf('hudRaf = requestAnimationFrame');
const cb = app.slice(rafStart, app.indexOf('\n  });', rafStart));
const mmStart = app.indexOf("cv.addEventListener('mousemove'");
const mmEnd = app.indexOf('\n});', mmStart);
const mmBody = app.slice(mmStart, mmEnd).replace(/updateMeasureHud\([^\n]*\);/g, '');
ok('mousemove does not write HUD DOM directly', !/getElementById\('h[lxaz]'\)\.textContent/.test(mmBody));
// rAF path must be the only writer: coords in callback, L/A/delta via renderMeasureHud
ok('rAF callback writes coords', /getElementById\('hx'\)\.textContent/.test(cb));
ok('rAF callback renders measure row', cb.includes('renderMeasureHud'));
ok('renderMeasureHud writes L/A/delta', /getElementById\('h[lad]'\)\.textContent/.test(app.slice(app.indexOf('function renderMeasureHud'), app.indexOf('/* ---------- pointer events'))));

// server smoke
const res = await fetch('http://localhost:8080/app.js');
const live = await res.text();
ok('sandbox serves updated app.js (200 + hudRaf)', res.status === 200 && live.includes('hudRaf'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
