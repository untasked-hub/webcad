// Round 42 verification: command bar dispatcher (LINE, RECTANGLE, CIRCLE, MOVE, COPY, OFFSET).
// Static-source checks + unit tests of the coordinate tokenizer.
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
let fails = 0;
const check = (name, ok) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + name); if (!ok) fails++; };

// ---- dispatcher presence ----
check('execCommand defined', app.includes('function execCommand(raw)'));
check('CMD_NAMES table with 6 commands', /line:\s*'LINE'/.test(app) && /circle:\s*'CIRCLE'/.test(app)
  && /rect:\s*'RECTANGLE'/.test(app) && /move:\s*'MOVE'/.test(app)
  && /copy:\s*'COPY'/.test(app) && /offset:\s*'OFFSET'/.test(app));
check('tokenizer parsePointTokens defined', app.includes('function parsePointTokens(tokens)'));
check('dispatcher reuses parseCoordEntry', /function execCommand[\s\S]{0,2000}parseCoordEntry\(/.test(app));
check('drawing command dispatches parsed points via pickPoint', /name === 'LINE' \|\| name === 'RECTANGLE' \|\| name === 'CIRCLE'[\s\S]{0,1700}for \(const p of pts\) pickPoint\(p\)/.test(app));
check('MOVE delta via applyTranslate', /name === 'MOVE'[\s\S]{0,2600}applyTranslate\(ents, d\)/.test(app));
check('COPY delta via cloneEnt+applyTranslate', /applyTranslate\(copies, d\)/.test(app));
check('COPY keeps originals (clone first)', /const copies = ents\.map\(cloneEnt\)/.test(app));
check('OFFSET numeric form uses signed normal+applyOffset', /name === 'OFFSET'[\s\S]{0,3000}applyOffset\(e, calc\)/.test(app) && app.includes('ov: [-dy / len * num[1], dx / len * num[1]]'));
check('pushUndo before MOVE mutation', /function execCommand[\s\S]{0,4200}pushUndo\(\)/.test(app));
check('locked-layer guard in dispatcher', /state\.doc\.entities\.filter\(e => state\.sel\.has\(e\.id\) && !lockedLayer\(e\.layer\)\)[\s\S]{0,900}applyTranslate/.test(app));
check('command bar exposes closed dispatcher for keyboard use', /const CMD_NAMES = \{[\s\S]{0,500}offset: 'OFFSET'/.test(app));
check('zero-distance guard for offset', app.includes('Math.abs(num[1]) < 1e-9'));
check('cmd history log function', app.includes('function cmdLog(msg)'));
check('history is bounded', app.includes('cmdLogLines.length > 8'));
check('cmdInput Enter runs dispatcher first', /cmdInput\.addEventListener\('keydown'[\s\S]{0,600}execCommand\(raw\)/.test(app));
check('fallback to coordinate entry kept', /execCommand\(raw\)[\s\S]{0,300}parseCoordEntry\(raw, state\.lastPt\)/.test(app));

// ---- UI wiring ----
check('index.html has cmdHistory element', html.includes('id="cmdHistory"'));
check('css styles cmd-history', css.includes('.cmd-history'));
check('placeholder advertises commands', html.includes('Command: LINE, RECTANGLE, CIRCLE'));
check('aria-live on history', html.match(/cmdHistory[^>]*aria-live/));

// ---- risk mitigations from peer critique ----
check('input blur on Enter (no double-consumption)', /const raw = cmdInput\.value;[\s\S]{0,120}cmdInput\.blur\(\)/.test(app));
check('Escape still clears input', app.includes("ev.key === 'Escape'"));
check('unknown command message lists commands', app.includes('unknown command'));

// ---- regressions ----
check('parseCoordEntry intact (round 23 numeric entry)', /function parseCoordEntry/.test(app));
check('keyEnter intact (round 1)', /function keyEnter\(\)/.test(app));
check('mirror-copy intact (round 39)', app.includes('function mirrorSelection(mode, keepOriginal)'));
check('trim intact (round 20)', /function applyTrim/.test(app));
check('break intact (round 38)', /function breakGeom/.test(app));
check('braces balanced', (app.match(/{/g) || []).length === (app.match(/}/g) || []).length);

// ---- unit tests: extract parseCoordEntry and parsePointTokens ----
const mParse = app.match(/function parseCoordEntry[\s\S]*?\n}\n/);
const mRef = app.match(/const PT_TOOLS[^\n]*\n/);
const mPPT = app.match(/function parsePointTokens[\s\S]*?\n}\n/);
if (mParse && mPPT && mRef) {
  const state = { lastPt: null };
  const mod = new Function('state', mRef[0] + mParse[0] + mPPT[0] + `
    return { parseCoordEntry, parsePointTokens };`)(state);
  const pc = mod.parseCoordEntry, ppt = mod.parsePointTokens;
  const close = (a, b) => Math.abs(a - b) < 1e-9;
  const eq2 = (p, q) => p && q && close(p[0], q[0]) && close(p[1], q[1]);

  let u = 0, uf = 0;
  const t = (name, ok) => { u++; if (!ok) { uf++; console.log('FAIL unit ' + name); } };
  const p1 = ppt(['100,50', '@50,0']); t('abs then relative', eq2(p1?.[0], [100, 50]) && eq2(p1?.[1], [150, 50]));
  state.lastPt = [100, 50];
  const p2 = ppt(['@10,0']); t('relative', eq2(p2?.[0], [110, 50]));
  const p3 = ppt(['10<0']); t('polar from last point', eq2(p3?.[0], [110, 50]));
  const p4 = ppt(['@0,10']); t('relative from last point', eq2(p4?.[0], [100, 60]));
  const p5 = ppt(['10<90']); t('polar 90deg', eq2(p5?.[0], [100, 60]));
  t('bad token rejected', ppt(['100,50', 'abc']) === null);
  t('empty ok (no args = interactive)', Array.isArray(ppt([])));
  const pd = pc('@20,30', [1, 2]); t('parseCoordEntry relative', eq2(pd, [21, 32]));
  console.log(uf === 0 ? `UNIT ${u}/${u} PASSED` : uf + ' unit failures');
  fails += uf;
} else {
  console.log('FAIL could not extract tokenizer for unit tests'); fails++;
}

console.log(fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECKS FAILED');
process.exit(fails === 0 ? 0 : 1);
