/* Round 6: selection-based (partial) export.
   1) selectionExportSet returns the selected entities, or null when empty
   2) selectionPreflight shows a summary (count, layers, extent) and a scope choice
   3) buildSVGString(bg, dims, ents) exports only the passed entities
   4) buildDXFExportPlan(units, dims, ents) exports only the passed entities and
      its summary notes the selection scope
   5) exporters use '-selection' filenames and selection-only toasts when chosen */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const log = [];
const check = (name, ok, detail) => {
  log.push((ok ? 'PASS: ' : 'FAIL: ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) process.exitCode = 1;
};

function extractBlock(i) {
  let depth = 0, started = false;
  for (let p = i; p < src.length; p++) {
    const ch = src[p];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') { depth--; if (started && depth === 0) return src.slice(i, p + 1); }
  }
  return src.slice(i);
}
function grab(name) {
  let i = src.indexOf('function ' + name + '(');
  if (i < 0) i = src.indexOf('function ' + name + ' =');
  if (i >= 0) {
    return extractBlock(i);
  }
  i = src.indexOf('const ' + name + ' =');
  if (i >= 0) {
    return extractBlock(i);
  }
  throw new Error('missing ' + name);
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

// Test-local implementations of the small geometry/export helpers app.js relies on.
// Defined as source so they can be injected into the sandboxed Function scope.
// along with the real exporter functions extracted from app.js.
const helperDefs = `
function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function len(v) { return Math.hypot(v[0], v[1]); }
function mul(v, s) { return [v[0] * s, v[1] * s]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
function formatDimension(v) { return v.toFixed(2) + ' mm'; }
function dimGeom(e) {
  const d = sub(e.p2, e.p1);
  const L = len(d) || 1;
  const n = [-d[1] / L, d[0] / L];
  const o = e.offset || 0;
  const a = add(e.p1, mul(n, o));
  const b = add(e.p2, mul(n, o));
  const txt = e.text || formatDimension(L);
  const lines = [[e.p1, add(e.p1, mul(n, o * 1.14))], [e.p2, add(e.p2, mul(n, o * 1.14))], [a, b]];
  return { a, b, n, txt, lines, L };
}
function entityPoints(e) {
  if (e.type === 'line') return [e.p1, e.p2];
  if (e.type === 'circle' || e.type === 'arc') return [e.c];
  if (e.type === 'polyline') return e.pts;
  if (e.type === 'rect') return [e.p1, e.p2];
  if (e.type === 'text' || e.type === 'dim') return [e.p || e.p1];
  return [];
}
function extentsOf(ents) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of ents) for (const p of entityPoints(e)) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  if (!isFinite(x0)) return null;
  return { x0, y0, x1, y1 };
}
function layerOf(name) { return layers.find(l => l.name === name) || layers[0]; }
function unitLabelOf(u) { return u || 'unknown'; }
function esc(s) { return String(s); }
function rad(d) { return d * Math.PI / 180; }
function toast(m) { toasts.push(m); }
const UNIT_MM = { mm: 1, in: 25.4, ft: 304.8 };
const TAU = Math.PI * 2;
`;

const layers = [{ name: '0', color: '#fff', visible: true, lineweight: 1 }, { name: 'Wall', color: '#f80', visible: true, lineweight: 1 }];
const e1 = { id: 'a', type: 'line', p1: [0, 0], p2: [100, 0], layer: '0' };
const e2 = { id: 'b', type: 'circle', c: [50, 50], r: 25, layer: 'Wall' };
const e3 = { id: 'c', type: 'line', p1: [900, 900], p2: [950, 950], layer: '0' };
const state = {
  sel: new Set(['a', 'b']),
  doc: { units: 'mm', layers, entities: [e1, e2, e3] },
};
const confirms = [];
let confirmAnswers = [];
const window = {
  confirm: (msg) => { confirms.push(msg); return confirmAnswers.length ? confirmAnswers.shift() : true; },
  prompt: () => 'mm',
};
const toasts = [];
let downloaded = null;
const download = (name, data, mime) => { downloaded = { name, data, mime }; };
const slug = () => 'round6-test';

const extraNames = ['DXF_INSUNITS', 'dxfLine'];
const extraSrc = extraNames.map(n => stripComments(grab(n))).join('\n') + '\n';
const fnNames = ['selectionExportSet', 'selectionPreflight', 'buildSVGString', 'buildDXFExportPlan', 'exportDXF', 'exportSVG'];
const fnSrc = fnNames.map(n => stripComments(grab(n))).join('\n');
const ctx = new Function('state', 'window', 'download', 'slug', 'layers', 'toasts',
  helperDefs + extraSrc + fnSrc + '\nreturn {' + fnNames.join(',') + '};')(state, window, download, slug, layers, toasts);

// 1) selectionExportSet
const picked = ctx.selectionExportSet();
check('selectionExportSet returns selected entities', picked && picked.length === 2 && picked.includes(e1) && picked.includes(e2));
state.sel = new Set();
check('selectionExportSet null when nothing selected', ctx.selectionExportSet() === null);
state.sel = new Set(['a', 'b']);

// 2) selectionPreflight message content
confirms.length = 0;
confirmAnswers = [true];
const ok = ctx.selectionPreflight('DXF', picked);
const msg = confirms[0] || '';
check('selectionPreflight confirms scope', ok === true);
check('preflight mentions counts and layers', msg.includes('2 of 3') && msg.includes('0, Wall'), msg.slice(0, 120));

// 3) SVG partial export
state.sel = new Set(['a', 'b']);
confirmAnswers = [true, true, true, true]; // preflight, dimChoice, okExport
confirms.length = 0;
ctx.exportSVG();
const svg = downloaded && String(downloaded.data);
check('SVG selection export filename', downloaded && downloaded.name === 'round6-test-selection.svg', downloaded && downloaded.name);
check('SVG contains selected geometry only', svg.includes('circle') && !svg.includes('900'), 'circle in, far line out');

// 4) DXF partial plan
state.sel = new Set(['a', 'b']);
const plan = ctx.buildDXFExportPlan('mm', true, picked);
check('DXF plan scope note', plan.summary.includes('selection only — 2 of 3'), plan.summary.split('\n').find(l => l.includes('Scope')));
check('DXF plan omits unselected entity', !plan.content.includes('900.0000'), 'no far-away coordinates');

// 5) DXF exporter full-drawing fallback (user cancels preflight)
state.sel = new Set(['a', 'b']);
confirmAnswers = [false, true, true, true];
confirms.length = 0;
downloaded = null;
ctx.exportDXF();
check('DXF falls back to whole drawing on preflight cancel', downloaded && downloaded.name === 'round6-test.dxf', downloaded && downloaded.name);
check('whole-drawing DXF includes unselected entity', String(downloaded.data).includes('900.0000'));

// 6) DXF exporter selection-only path
state.sel = new Set(['a', 'b']);
confirmAnswers = [true, true, true, true];
confirms.length = 0;
downloaded = null;
ctx.exportDXF();
check('DXF selection export filename', downloaded && downloaded.name === 'round6-test-selection.dxf', downloaded && downloaded.name);
check('selection DXF toast', toasts.some(t => t.includes('selection only — 2 object(s)')), toasts[toasts.length - 1]);

console.log(log.join('\n'));
console.log(process.exitCode ? 'RESULT: FAIL' : 'RESULT: OK');
