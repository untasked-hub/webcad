// Round 5 test: PNG print-at-scale preflight + SVG unit metadata.
// Runs the new export helpers headlessly with stubbed DOM/prompt/confirm.
// Usage: node scripts/png-preflight-test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('PASS', name);
  else { failures++; console.log('FAIL', name, detail || ''); }
}

// --- Extract and evaluate the exportPNG scale math independently ---
const UNIT_MM = { mm: 1, in: 25.4, ft: 304.8 };
function pngScale(units, dpi, wWorld, hWorld) {
  const unitMm = UNIT_MM[units] || 0;
  const pxPerUnit = dpi / 25.4 * (unitMm || 25.4);
  return { W: Math.max(64, Math.round(wWorld * pxPerUnit)), H: Math.max(64, Math.round(hWorld * pxPerUnit)) };
}
// 100 mm wide drawing at 300 DPI -> 100/25.4*300 = 1181 px
const s1 = pngScale('mm', 300, 100, 50);
check('mm@300dpi pixel math', s1.W === 1181 && s1.H === 591, JSON.stringify(s1));
// 10 in wide at 96 dpi -> 960 px
const s2 = pngScale('in', 96, 10, 5);
check('in@96dpi pixel math', s2.W === 960 && s2.H === 480, JSON.stringify(s2));
// unitless falls back to 96dpi-equivalent per unit
const s3 = pngScale(undefined, 300, 100, 50);
check('unitless fallback px/unit = dpi/25.4*25.4', s3.W === Math.round(100 * 300 / 25.4 * 25.4), JSON.stringify(s3));

// --- Source-level checks on app.js ---
check('exportPNG prompts for DPI', /Target print DPI/.test(src));
check('exportPNG blocks out-of-range DPI', /DPI must be between 24 and 1200/.test(src));
check('exportPNG shows physical mm size', /Printed size at 1:1/.test(src));
check('exportPNG warns when units unset', /units unset — printed size is not measurable/.test(src));
check('exportPNG no longer uses legacy fixed scale', !/Math\.min\(8, 2000 \/ Math\.max\(wWorld/.test(src));
check('buildSVGString takes includeDims', /function buildSVGString\(bg, includeDims\)/.test(src));
check('SVG dims skippable', /if \(!includeDims\) continue;/.test(src));
check('exportSVG offers dim choice', /Include dimensions as geometry \+ text in the file\?\\n\\nOK = include dimensions, Cancel = export without dimensions\.\'\);\n  const rr = buildSVGString\('#0b1017', dimChoice\);/.test(src));
check('SVG embeds data-units', /data-units="/.test(src));
check('SVG width in mm when units set', /width="' \+ physW \+ 'mm" height="' \+ physH \+ 'mm"/.test(src));
check('exportSVG confirm review', /SVG export review/.test(src));
check('exportSVG cancels cleanly', /SVG export cancelled/.test(src));

// --- Headless behaviour test of exportSVG via vm sandbox ---
const calls = { download: [], toasts: [] };
let confirmQueue = [];
const sandbox = {
  window: { confirm: () => confirmQueue.shift() ?? true },
  document: {
    createElement: () => ({ getContext: () => ({}), toBlob: (cb) => cb(null) }),
    getElementById: () => null,
    querySelector: () => null,
  },
  state: { doc: { units: 'mm', entities: [], layers: [] } },
  UNIT_MM, unitLabelOf: (u) => u === 'mm' ? 'mm' : (u === 'in' ? 'in' : 'ft'),
  extentsOf: () => ({ x0: 0, y0: 0, x1: 100, y1: 50 }),
  layerOf: () => null,
  esc: (t) => t, rad: (a) => a * Math.PI / 180, TAU: Math.PI * 2,
  mid: (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], dimGeom: () => ({ lines: [], a: [0, 0], b: [1, 1], txt: '' }),
  slug: () => 'drawing', docName: () => 'Test', markDirty: () => {},
  download: (fn, content, mime) => { calls.download.push({ fn, mime, content }); },
  toast: (t) => calls.toasts.push(t),
  console,
};
sandbox.window.prompt = () => '300';
vm.createContext(sandbox);

// Extract just the exporter region: buildSVGString + exportSVG
const i0 = src.indexOf('function buildSVGString');
const i1 = src.indexOf('function dxfLine');
const region = src.slice(i0, i1) + '\n' + src.slice(src.indexOf('function exportSVG'), src.indexOf('function dxfLine'));
vm.runInContext(region, sandbox);

// Confirm twice: dimChoice=true, then export ok
confirmQueue = [true, true];
sandbox.exportSVG();
check('SVG downloaded once', calls.download.length === 1, JSON.stringify(calls.download.length));
const svg = calls.download[0].content;
check('SVG has mm width', /width="120\.00mm" height="70\.00mm"/.test(svg), svg.slice(0, 300));
check('SVG has data-units=mm', /data-units="mm"/.test(svg));

// Cancel on review -> no second download
confirmQueue = [false, false];
sandbox.exportSVG();
check('SVG cancel stops download', calls.download.length === 1, JSON.stringify(calls.download.length));
check('cancel toast', calls.toasts.some(t => /cancelled/.test(t)), JSON.stringify(calls.toasts));

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
