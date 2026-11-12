/* Round 4: DXF export preflight summary + dimension fidelity option.
   1) buildDXFExportPlan(units, includeDims) accepts an includeDims flag
   2) includeDims=false omits dimension geometry/text, summary says so
   3) includeDims=true decomposes dims into lines + text, summary notes R12 fidelity
   4) exportDXF asks the dimension question then confirms with the final plan
   5) exported geometry re-imports (parseDXF round-trip) with true lengths */
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const log = [];
const check = (name, ok, detail) => {
  log.push((ok ? 'PASS: ' : 'FAIL: ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) process.exitCode = 1;
};

function grab(name) {
  const marker = 'function ' + name;
  const i = src.indexOf(marker);
  if (i < 0) throw new Error('missing ' + name);
  const j = src.indexOf('\nfunction ', i + 1);
  return src.slice(i, j < 0 ? undefined : j);
}

const state = {
  doc: {
    units: 'mm',
    layers: [{ name: '0' }, { name: 'Wall' }],
    entities: [
      { type: 'line', p1: [0, 0], p2: [100, 0], layer: '0' },
      { type: 'dim', p1: [0, 0], p2: [100, 0], offset: 20, layer: '0' },
      { type: 'circle', c: [50, 50], r: 25, layer: 'Wall' },
      { type: 'image-underlay-thing', layer: '0' },
    ],
  },
};
const window = { confirm: () => true, prompt: () => 'mm' };
const toasts = [];
let downloaded = null;
const download = (name, data, mime) => { downloaded = { name, data, mime }; };
const slug = () => 'round4-test';

// helpers the grabbed functions reference
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
function unitLabelOf(u) { return u || 'unknown'; }
function toast(m) { toasts.push(m); }

const fn = new Function('state', 'window', 'toast', 'download', 'slug',
  'sub', 'len', 'mul', 'add', 'mid', 'formatDimension', 'unitLabelOf',
  grab('dxfLine') + '\n' + grab('dimGeom') + '\n' + grab('buildDXFExportPlan') + '\n' + grab('exportDXF') +
  '\nreturn { exportDXF, buildDXFExportPlan };');

const { exportDXF, buildDXFExportPlan } = fn(state, window, toast, download, slug,
  sub, len, mul, add, mid, formatDimension, unitLabelOf);

// --- 1: default plan includes dims, notes R12 fidelity
const withDims = buildDXFExportPlan('mm', true);
check('includeDims=true summary mentions R12 dimension decomposition',
  /Dimensions \(1\).*no native dimension entity/.test(withDims.summary), JSON.stringify(withDims.summary));
check('dims decomposed to 3 LINEs + 1 TEXT', withDims.exported.LINE === 4 && withDims.exported.TEXT === 1,
  JSON.stringify(withDims.exported));

// --- 2: omitted dims option
const noDims = buildDXFExportPlan('mm', false);
check('includeDims=false omits dimensions', noDims.omitted.dimension === 1, JSON.stringify(noDims.omitted));
check('omitted-dims summary says omitted by your choice',
  /omitted by your choice/.test(noDims.summary), JSON.stringify(noDims.summary));
check('no-dims plan has no TEXT entities', !noDims.exported.TEXT, JSON.stringify(noDims.exported));

// --- 3: unsupported content still warned
check('unsupported entity counted as omitted', noDims.omitted['image-underlay-thing'] === 1, JSON.stringify(noDims.omitted));

// --- 4: exportDXF flow asks dimension question then confirms
let confirmCalls = 0;
const confirmTexts = [];
window.confirm = (t) => { confirmCalls++; confirmTexts.push(String(t)); return true; };
window.prompt = () => 'mm';
downloaded = null;
exportDXF();
check('exportDXF produced a file', !!downloaded && downloaded.name === 'round4-test.dxf', downloaded && downloaded.name);
check('exportDXF asked the dimension question first',
  confirmCalls === 2 && /Include dimensions as geometry\+text|Include dimensions as geometry \+ text|Include dimensions/.test(confirmTexts[0] || ''),
  'calls=' + confirmCalls + ' first=' + (confirmTexts[0] || '').slice(0, 60));
check('final confirm shows the plan summary', /DXF export review/.test(confirmTexts[1] || ''), (confirmTexts[1] || '').slice(0, 80));

// --- 5: round-trip fidelity: the dim measure line re-imports at true length
const dxfText = withDims.content;
const lines = dxfText.split('\n');
const segs = [];
for (let i = 0; i < lines.length; i++) {
  if (lines[i] === 'LINE') {
    const get = (code) => parseFloat(lines[lines.indexOf('10', i + 1)] !== -1 ? 0 : 0); // placeholder
  }
}
// simpler parse: walk pairs
let ents = [], cur = null;
for (let i = 0; i + 1 < lines.length; i += 2) {
  const code = lines[i].trim(), val = lines[i + 1];
  if (code === '0') { cur = { type: val }; ents.push(cur); }
  else if (cur) cur[code] = val;
}
const dxfLines = ents.filter(e => e.type === 'LINE');
const measure = dxfLines.find(e => Math.hypot((+e['11']) - (+e['10']), (+e['21']) - (+e['20'])) === 100);
check('dimension measure line exports at true 100mm length', !!measure,
  dxfLines.map(e => Math.hypot(+e['11'] - +e['10'], +e['21'] - +e['20'])).join(','));
const dxfTextEnt = ents.find(e => e.type === 'TEXT' && e['1'] === '100.00 mm');
check('dimension label text present as DXF TEXT', !!dxfTextEnt, dxfTextEnt && dxfTextEnt['1']);

console.log(log.join('\n'));
console.log(log.some(l => l.startsWith('FAIL')) ? 'RESULT: FAIL' : 'RESULT: PASS');
