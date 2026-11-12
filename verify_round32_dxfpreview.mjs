/* Round 31 feature: DXF import coverage preview.
   Verifies (extracting real app source like rt_test.js / verify_round26):
   1) parseDXF counts unsupported entities (DIMENSION/MTEXT/INSERT/etc.)
   2) buildDXFImportPlan summarizes will-add counts, skipped counts, layers
   3) empty file plan: 0 add, 0 skip, explicit "No recognizable" line
   4) unsupported-only file: willAddTotal 0, skip counts, warning line
   5) importDXFText shows confirm dialog with plan summary and honors cancel
   6) importDXFText proceeds on confirm, loads doc, reports skipped in toast */
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

const dxfSample = `0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n0\n20\n0\n11\n100\n21\n0\n0\nCIRCLE\n8\n0\n10\n50\n20\n50\n40\n25\n0\nARC\n8\nWall\n10\n30\n20\n30\n40\n10\n50\n0\n51\n90\n0\nTEXT\n8\nNotes\n10\n5\n20\n5\n40\n12\n1\nHELLO\n0\nDIMENSION\n0\nMTEXT\n0\nINSERT\n0\nENDSEC\n0\nEOF\n`;
const dxfEmpty = `0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n`;
const dxfUnsupportedOnly = `0\nSECTION\n2\nENTITIES\n0\nDIMENSION\n0\nMTEXT\n0\nSPLINE\n0\nENDSEC\n0\nEOF\n`;

const stub = `
const window = globalThis;
const LAYER_COLORS = ['#e6edf3','#f87171','#4ade80','#60a5fa','#fbbf24','#c084fc'];
const state = { doc: { layers: [], entities: [] } };
function loadDoc(doc, id, name) { globalThis.__loaded = { doc, id, name }; }
function toast(msg) { globalThis.__toast = String(msg); }
function markDirty() {}
function renderAll() {}
let __confirmCalls = 0, __confirmMsgs = [], __confirmNext = true;
function confirmShim(msg) { __confirmCalls++; __confirmMsgs.push(String(msg)); return __confirmNext; }
window.confirm = confirmShim;
globalThis.__confirmCalls = () => __confirmCalls;
globalThis.__confirmMsgs = () => __confirmMsgs;
globalThis.__setConfirm = (v) => { __confirmNext = v; };
`;

const code = stub + '\n' + grab('parseDXF') + '\n' + grab('buildDXFImportPlan') + '\n' + grab('importDXFText') +
  '\nreturn { parseDXF, buildDXFImportPlan, importDXFText };';
const fn = new Function(code);
const { parseDXF, buildDXFImportPlan, importDXFText } = fn();

// 1-2 mixed sample
const parsed = parseDXF(dxfSample);
check('parseDXF found drawable entities', parsed.entities.length === 4, parsed.entities.length);
check('parseDXF counts unsupported kinds', parsed.unsupported &&
  parsed.unsupported.DIMENSION === 1 && parsed.unsupported.MTEXT === 1 && parsed.unsupported.INSERT === 1 &&
  Object.keys(parsed.unsupported).length === 3, JSON.stringify(parsed.unsupported));
const plan = buildDXFImportPlan(parsed);
check('plan adds 4 objects', plan.willAddTotal === 4, plan.willAddTotal);
check('plan counts LINE/CIRCLE/ARC/TEXT', plan.willAdd.LINE === 1 && plan.willAdd.CIRCLE === 1 &&
  plan.willAdd.ARC === 1 && plan.willAdd.TEXT === 1, JSON.stringify(plan.willAdd));
check('plan counts 3 skipped', plan.skippedTotal === 3, plan.skippedTotal);
check('plan layers include default 0', plan.layers.includes('0') && plan.layers.length === 1, plan.layers.join(','));
check('plan summary lists skip section', /that will be skipped \(3\)/.test(plan.summary), plan.summary);

// 3 empty
const pe = parseDXF(dxfEmpty);
const ple = buildDXFImportPlan(pe);
check('empty file: 0 add 0 skip', ple.willAddTotal === 0 && ple.skippedTotal === 0, ple.summary);
check('empty file: explicit no-entities line', ple.summary.includes('No recognizable DXF entities found'), ple.summary);
let threw = '';
try { importDXFText(dxfEmpty); } catch (e) { threw = e.message || String(e); }
check('empty import throws clear error', threw.includes('no recognizable DXF entities'), threw);

// 4 unsupported-only
const pu = parseDXF(dxfUnsupportedOnly);
const plu = buildDXFImportPlan(pu);
check('unsupported-only: adds 0', plu.willAddTotal === 0, JSON.stringify(plu.willAdd));
check('unsupported-only: skips 3 kinds', plu.skippedTotal === 3 && plu.skipped.SPLINE === 1, JSON.stringify(plu.skipped));
check('unsupported-only warns about nothing drawable', plu.summary.includes('Nothing drawable'), plu.summary);

// 5 cancel path on mixed sample
globalThis.__setConfirm(false);
globalThis.__loaded = undefined;
const cancelled = importDXFText(dxfSample);
check('cancel returns null without mutating drawing', cancelled === null && globalThis.__loaded === undefined,
  JSON.stringify(globalThis.__loaded));
const msgs = globalThis.__confirmMsgs();
check('confirm shown once with preview title', msgs.length === 1 && msgs[0].includes('DXF import preview'), msgs.join('|'));
check('dialog shows counts', msgs[0].includes('Objects to add (4)') && msgs[0].includes('skipped (3)'), msgs[0]);
check('dialog warns replaces contents', msgs[0].includes('replaces the current drawing'), msgs[0]);

// 6 confirm path
globalThis.__setConfirm(true);
const okPlan = importDXFText(dxfSample);
const loaded = globalThis.__loaded;
check('confirm proceeds and loads doc', okPlan && loaded && loaded.name === 'Imported DXF' &&
  loaded.doc.entities.length === 4, JSON.stringify(loaded && loaded.doc && loaded.doc.entities.length));
check('layers merged with default 0', loaded.doc.layers.length === 1 && loaded.doc.layers[0].name === '0', loaded.doc.layers.map(l => l.name).join(','));
check('toast reports skipped count', globalThis.__toast.includes('(3 unsupported skipped)'), globalThis.__toast);

console.log(checks + ' checks, ' + fails + ' failures');
process.exit(fails === 0 ? 0 : 1);
