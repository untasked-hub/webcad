// Round 41 verification: print/PDF sheet output in WebCAD.
// Static-source analysis following the round-39 pattern, plus a functional
// SVG-string check of buildSVGString extracted from app.js.
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
let fails = 0;
const check = (name, ok) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + name); if (!ok) fails++; };

// SVG refactor
check('buildSVGString(bg) defined', app.includes('function buildSVGString(bg)'));
check('SVG background is parameterized', app.includes("fill=\"' + bg + '\""));
check('exportSVG wraps buildSVGString with dark bg', /function exportSVG\(\) \{[\s\S]{0,200}buildSVGString\('#0b1017'\)/.test(app));
check('exportSVG still downloads svg', /function exportSVG\(\)[\s\S]{0,400}download\(slug\(\) \+ '\.svg'/m.test(app));
check('exportSVG still toasts', /function exportSVG\(\)[\s\S]{0,500}toast\('Exported SVG'\)/.test(app));

// Print feature core
check('printSheetDialog defined', app.includes('function printSheetDialog()'));
check('readPrintOptions defined', app.includes('function readPrintOptions()'));
check('openPrintWindow defined', app.includes('function openPrintWindow()'));
check('PAPER_MM covers a4/letter/a3', app.includes('a4: [210, 297]') && app.includes('letter: [215.9, 279.4]') && app.includes('a3: [297, 420]'));
check('print uses white background SVG', /function buildPrintSvgForPrint[\s\S]{0,200}buildSVGString\('#ffffff'\)/.test(app));
check('print computes fit scale from paper', /function buildPrintSvgForPrint[\s\S]{0,600}Math\.min\(availW \/ r\.w, availH \/ r\.h\)/.test(app));
check('custom scale mode honored', /opts\.scaleMode === 'custom'[\s\S]{0,80}scale = opts\.scalePct \/ 100/.test(app));
check('landscape swaps paper dims', /const pw = opts\.landscape \? ps\[1\] : ps\[0\]/.test(app));
check('@page size emitted in mm', /@page \{ size: ' \+ mm\(pw\) \+ ' ' \+ mm\(ph\)/.test(app));
check('title block includes name, scale, date', /esc\(p\.name\)[\s\S]{0,200}esc\(p\.scaleLabel\)[\s\S]{0,200}esc\(p\.date\)/.test(app));
check('auto window.print() after load', /window\.onload[\s\S]{0,200}window\.print\(\)/.test(app));
check('pop-up blocked fallback toast', app.includes('Pop-up blocked'));
check('print registered in EXPORTERS', /const EXPORTERS = \{[^}]*print: printSheetDialog/.test(app));

// UI wiring
check('index.html has printModal', html.includes('id="printModal"'));
check('index.html has Print menu entry', html.includes('data-exp="print"'));
check('print modal has paper/orient/scale controls', html.includes('id="printPaper"') && html.includes('id="printOrient"') && html.includes('id="printScaleMode"') && html.includes('id="printScalePct"'));
check('print modal has title-block checkbox', html.includes('id="printTitle"'));
check('printGo wired to openPrintWindow', /printGo'\)\.onclick[\s\S]{0,120}openPrintWindow\(\)/.test(app));
check('printCancel/close wired', app.includes("printCancel').onclick = closePrintModal") && app.includes("printClose').onclick = closePrintModal"));
check('style.css has print row styles', css.includes('.print-row'));

// Regression: existing exporters and recent features intact
check('DXF exporter intact (round 26/32)', app.includes('function buildDXFExportPlan'));
check('layer context menu intact (round 40)', app.includes('function openLayerMenu(ev, L)') && app.includes('row.oncontextmenu'));
check('mirror-copy intact (round 39)', app.includes('function mirrorSelection(mode, keepOriginal)'));
check('properties editing intact (round 37)', app.includes("form.className = 'prop-edit'") && app.includes("setPrompt('Properties updated')"));
check('braces balanced', (app.match(/{/g) || []).length === (app.match(/}/g) || []).length);

// Functional: extract buildSVGString + deps and render a sample doc in node
const src = app;
function grab(name) {
  let i = src.indexOf('function ' + name + '(');
  if (i < 0) i = src.indexOf('const ' + name + ' =');
  if (i < 0) throw new Error('missing fn ' + name);
  if (!src.startsWith('function', i)) { return src.slice(src.indexOf('const', i)).split(';')[0] + ';'; }
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced fn ' + name);
}
const deps = ['buildSVGString', 'extentsOf', 'layerOf', 'esc', 'dimGeom', 'entityPoints', 'arcPts']
  .map(grab).join('\n');
const harness = deps + "\nconst mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];\nconst TAU = Math.PI * 2;\nconst rad = (d) => d * Math.PI / 180;" + `
globalThis.state = { doc: { entities: [
  { id:'a', type:'line', p1:[0,0], p2:[100,0], layer:'0' },
  { id:'b', type:'circle', c:[50,50], r:20, layer:'0' },
  { id:'c', type:'text', p:[10,10], text:'hello', size:12, layer:'0' },
  { id:'d', type:'rect', p1:[0,0], p2:[80,60], layer:'0' },
  { id:'e', type:'arc', c:[50,50], r:30, a0:0, a1:90, layer:'0' },
  { id:'f', type:'polyline', pts:[[0,0],[10,10],[20,0]], layer:'0' }
], layers: [ { id:'0', name:'0', visible:true, color:'#ffcc00', lineweight:1 } ] } };
const r1 = buildSVGString('#0b1017');
const r2 = buildSVGString('#ffffff');
console.log('svg_len', r1.svg.length, 'dims', r1.w, r1.h);
if (!r1.svg.includes('fill="#0b1017"')) throw new Error('dark bg missing');
if (!r2.svg.includes('fill="#ffffff"')) throw new Error('white bg missing');
if (!r1.svg.includes('<line') || !r1.svg.includes('<circle') || !r1.svg.includes('<text') ||
    !r1.svg.includes('<rect') || !r1.svg.includes('<path') || !r1.svg.includes('<polyline'))
  throw new Error('entity kinds missing');
if (!r1.svg.trim().endsWith('</svg>')) throw new Error('svg not closed');
if (!(r1.w > 0 && r1.h > 0)) throw new Error('bad dims');
console.log('FUNCTIONAL_SVG_OK');
`;
new Function(harness)();

console.log(fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECKS FAILED');
process.exit(fails === 0 ? 0 : 1);
