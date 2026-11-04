/* Round 32 feature: Zoom to extents / zoom to selection.
   Verifies (extracting real app source):
   1) viewport-only change: zoomExtents / fitView never mutate doc entities
   2) selection framing: fitView with selection centers on the selection bbox
   3) all-content framing when nothing selected
   4) degenerate bbox (single point / zero area) clamps zoom and pads
   5) shortcut F triggers fitView and does not shadow tool map (F is not a tool key)
   6) readout derives from the same render transform (prompt shows zoom %) */
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const grab = (name) => {
  const i = src.indexOf('function ' + name);
  if (i < 0) throw new Error('missing ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
};
let checks = 0, fails = 0;
const check = (label, cond, extra) => {
  checks++;
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + label + (cond ? '' : ' :: ' + (extra ?? '')));
  if (!cond) fails++;
};

const stub = `
const window = globalThis;
const cv = { width: 800, height: 450 };
function cvW() { return cv.width; }
function cvH() { return cv.height; }
function extentsOf(ents) {
  if (!ents || !ents.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of ents) {
    const pts = e.type === 'line' ? [e.a, e.b] : e.type === 'circle' ? [[e.c[0]-e.r, e.c[1]-e.r],[e.c[0]+e.r, e.c[1]+e.r]] : (e.pts || [e.p]);
    for (const p of pts) { if (!p) continue; x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  }
  if (!Number.isFinite(x0)) return null;
  return { x0, y0, x1, y1 };
}
const state = { doc: { entities: [] }, sel: new Set(), view: { x: 0, y: 0, zoom: 1 } };
let __drawCalls = 0, __prompt = '';
function draw() { __drawCalls++; }
function setPrompt(t) { __prompt = String(t); }
`;

const code = stub + '\n' + grab('zoomExtents') + '\n' + grab('fitView') +
  '\nreturn { zoomExtents, fitView, state, getters: () => ({ drawCalls: __drawCalls, prompt: __prompt }) };';
const fn = new Function(code);
const env = fn();
const { zoomExtents, fitView, state } = env;
const g = () => env.getters();

// entities for tests
const lineA = { id: 'a', type: 'line', a: [0, 0], b: [100, 0] };
const lineB = { id: 'b', type: 'line', a: [100, 50], b: [150, 50] };
const far = { id: 'f', type: 'line', a: [5000, 5000], b: [5100, 5000] };
const point = { id: 'p', type: 'circle', c: [10, 10], r: 0 };

// 1+3: no selection -> frame all
state.doc.entities = [lineA, lineB];
state.sel = new Set();
state.view = { x: 999, y: 999, zoom: 3 };
const beforeEntities = JSON.stringify(state.doc.entities);
fitView();
check('fitView frames all content when nothing selected',
  Math.abs(state.view.x - 75) < 1e-6 && Math.abs(state.view.y - 25) < 1e-6,
  state.view.x + ',' + state.view.y);
const zAll = state.view.zoom;
check('all-content zoom matches bbox with margin (epsilon)',
  Math.abs(zAll - Math.min(800 / (150 * 1.22), 450 / (50 * 1.22))) < 1e-9, zAll);
check('viewport-only: entities unchanged', JSON.stringify(state.doc.entities) === beforeEntities);
check('draw called after fit', g().drawCalls >= 1);

// 2: selection framing
state.doc.entities = [lineA, lineB, far];
state.sel = new Set(['b']);
state.view = { x: 0, y: 0, zoom: 1 };
fitView();
check('fitView centers selection bbox', Math.abs(state.view.x - 125) < 1e-6 && Math.abs(state.view.y - 50) < 1e-6,
  state.view.x + ',' + state.view.y);
check('selection zoom ignores far-away content',
  Math.abs(state.view.zoom - Math.min(800 / (50 * 1.22), 450 / (1 * 1.22))) < 1e-9, state.view.zoom);

// 4: degenerate single-point fixture clamps min zoom
state.doc.entities = [point];
state.sel = new Set();
state.view = { x: 0, y: 0, zoom: 1 };
fitView();
check('degenerate bbox clamps zoom to minimum padding',
  Math.abs(state.view.x - 10) < 1e-6 && Math.abs(state.view.y - 10) < 1e-6 && state.view.zoom > 0 &&
  state.view.zoom <= Math.min(800 / (1 * 1.22), 450 / (1 * 1.22)), state.view.zoom);
check('zoom within global clamp [0.02,60]', state.view.zoom >= 0.02 && state.view.zoom <= 60, state.view.zoom);

// 5: shortcut collision check on real source
check('shortcut F bound to fitView in real source', /if \(k === 'f' && !mod\) \{ ev\.preventDefault\(\); fitView\(\); return; \}/.test(src));
const toolMapMatch = src.match(/const map = \{([^}]*)\}/);
check('F is not shadowed by a tool key', toolMapMatch && !/(\W|^)f\s*:/.test(toolMapMatch[1]), toolMapMatch && toolMapMatch[1]);
check('shortcut E not used (E = erase stays intact)', /e:\s*'erase'/.test(toolMapMatch[1]));
check('toolbar buttons wired to fitView', /on\('btnZoomExt', \(\) => fitView\(\)\)/.test(src) && /on\('btnFit', \(\) => fitView\(\)\)/.test(src));

// 6: readout
check('readout shows zoom percent from render transform', /setPrompt\(\(ents \? 'Zoomed to selection' : 'Zoomed to extents'\) \+ ' — ' \+ Math\.round\(state\.view\.zoom \* 100\) \+ '%'\)/.test(src));
check('readout uses Math.round on state.view.zoom (same transform as HUD)', /Math\.round\(state\.view\.zoom \* 100\)/.test(src));

// empty doc resets view
state.doc.entities = [];
fitView();
check('empty doc resets view to origin/100%', state.view.x === 0 && state.view.y === 0 && state.view.zoom === 1, JSON.stringify(state.view));

console.log(checks + ' checks, ' + fails + ' failures');
process.exit(fails === 0 ? 0 : 1);