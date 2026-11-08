/* Round 26: focused DXF export - explicit units + honest entity coverage.
   Extracts the real exportDXF/dxfLine source from public/app.js and runs it
   against stubbed globals so the serializer itself is what gets checked. */
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(import.meta.dirname, 'public', 'app.js'), 'utf8');

function grab(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing function ' + name);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const exported = [];
let toastMsg = '';
let promptAnswer = 'mm';
let promptCalls = 0;
let confirmAnswer = true;
let confirmText = '';

const state = {
  doc: {
    layers: [{ name: '0' }, { name: 'Walls' }],
    entities: [
      { type: 'line', layer: 'Walls', p1: [0, 0], p2: [100, 0] },
      { type: 'polyline', layer: 'Walls', pts: [[0, 0], [10, 0], [10, 10]] },
      { type: 'rect', layer: 'Walls', p1: [0, 0], p2: [20, 10] },
      { type: 'circle', layer: '0', c: [5, 5], r: 2 },
      { type: 'arc', layer: '0', c: [0, 0], r: 10, a0: 0, a1: 90 },
      { type: 'text', layer: '0', p: [1, 2], text: 'BATH', size: 24 },
      { type: 'dim', layer: 'Dims', p1: [0, 0], p2: [100, 0], offset: -70 },
      { type: 'hatch', layer: '0' },
    ],
  },
};

const window = {
  prompt: () => { promptCalls++; return promptAnswer; },
  confirm: (text) => { confirmText = text; return confirmAnswer; },
};
function toast(m) { toastMsg = m; }
function download(name, content) { exported.push({ name, content }); }
function slug() { return 'unit-test'; }

const fn = new Function('state', 'window', 'toast', 'download', 'slug',
  grab('dxfLine') + '\n' + grab('buildDXFExportPlan') + '\n' + grab('exportDXF') + '\nreturn { exportDXF, buildDXFExportPlan };');
const { exportDXF, buildDXFExportPlan } = fn(state, window, toast, download, slug);

const results = [];
const check = (name, cond, extra) => { results.push([cond ? 'PASS' : 'FAIL', name, extra || '']); };

function pairs(text) {
  const L = text.split('\n');
  const out = [];
  for (let i = 0; i + 1 < L.length; i += 2) out.push([L[i].trim(), L[i + 1]]);
  return out;
}

// 1. millimetres: $INSUNITS 4, coordinates unchanged
promptAnswer = 'mm';
exported.length = 0;
exportDXF();
const mm = exported[0];
check('mm export produced a file', !!mm && mm.name === 'unit-test.dxf', mm && mm.name);
const mmPairs = pairs(mm.content);
const idx = mmPairs.findIndex(p => p[0] === '9' && p[1] === '$INSUNITS');
check('$INSUNITS present', idx >= 0);
check('mm sets $INSUNITS=4', mmPairs[idx + 1] && mmPairs[idx + 1][0] === '70' && mmPairs[idx + 1][1] === '4',
  mmPairs[idx + 1] && mmPairs[idx + 1][1]);
const mmLine = mmPairs.find(p => p[0] === '0' && p[1] === 'LINE');
const li = mmPairs.indexOf(mmLine);
const mmStart = mmPairs.slice(li, li + 4).filter(p => p[0] === '10' || p[0] === '20').map(p => p[1]);
check('mm coordinates not rescaled', mmStart[0] === '0.0000' && mmStart[1] === '0.0000', mmStart.join(','));
check('toast reports mm', /mm/.test(toastMsg), toastMsg);
check('review reports unknown source units and no conversion', /Source units: unknown \/ unset/.test(confirmText) && /Conversion: none/.test(confirmText), confirmText);
check('review reports exact supported entity counts', confirmText.includes('Included DXF entities (10): ARC: 1, CIRCLE: 1, LINE: 7, TEXT: 1'), confirmText);
check('review names dimension and hatch omissions', confirmText.includes('Omitted drawing objects (2): dimensions: 1, hatch: 1'), confirmText);

// 2. inches: $INSUNITS 1, same coordinates
promptAnswer = 'in';
exported.length = 0;
exportDXF();
const inch = exported[0];
const inPairs = pairs(inch.content);
const iidx = inPairs.findIndex(p => p[0] === '9' && p[1] === '$INSUNITS');
check('in sets $INSUNITS=1', inPairs[iidx + 1] && inPairs[iidx + 1][1] === '1', inPairs[iidx + 1] && inPairs[iidx + 1][1]);
const inLine = inPairs.find(p => p[0] === '0' && p[1] === 'LINE');
const ii = inPairs.indexOf(inLine);
const inStart = inPairs.slice(ii, ii + 4).filter(p => p[0] === '10' || p[0] === '20').map(p => p[1]);
check('in coordinates identical to mm (no rescale)', inStart.join(',') === mmStart.join(','), inStart.join(','));
check('toast reports in', /\bin\b/.test(toastMsg), toastMsg);

// 3. entity coverage + honest omissions
const kinds = inPairs.filter(p => p[0] === '0').map(p => p[1]);
const count = (k) => kinds.filter(k2 => k2 === k).length;
check('polyline exported as 2 LINEs', count('LINE') === 1 + 2 + 4, String(count('LINE')));
check('circle exported', count('CIRCLE') === 1);
check('arc exported', count('ARC') === 1);
check('text exported', count('TEXT') === 1);
check('dimension omitted (no DIMENSION entity)', count('DIMENSION') === 0);
check('unsupported entity omitted', count('HATCH') === 0);
check('omissions disclosed in toast', /see export review for omissions/.test(toastMsg), toastMsg);
check('file ends with EOF', /EOF\s*$/.test(inch.content.trimEnd() + '\n') && inch.content.endsWith('EOF\n'));
check('layer table carries both layers', count('LAYER') === 2, String(count('LAYER')));

// 4. cancel and invalid input
promptAnswer = null;
exported.length = 0;
exportDXF();
check('cancel exports nothing', exported.length === 0);
promptAnswer = 'furlongs';
exported.length = 0;
exportDXF();
check('invalid unit exports nothing', exported.length === 0);
check('invalid unit warns', /choose mm or in/.test(toastMsg), toastMsg);

const failed = results.filter(r => r[0] === 'FAIL');
for (const [s, n, e] of results) console.log(`${s} ${n}${e ? ' :: ' + e : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
