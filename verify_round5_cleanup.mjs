// Round 5 verification: Health Cleanup planner + wiring.
// Run: node apps/autokad/verify_round5_cleanup.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const H = require('./public/health.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + JSON.stringify(extra) : '')); }
}

const doc = {
  layers: [
    { name: '0', color: '#fff', visible: true, locked: false },
    { name: 'Walls', color: '#7fd1ff', visible: true, locked: false },
    { name: 'Empty', color: '#aaa', visible: true, locked: false },
    { name: 'Ghost', color: '#aaa', visible: true, locked: false },
    { name: 'Lock', color: '#aaa', visible: true, locked: true }
  ],
  entities: [
    { id: 'e1', type: 'line', layer: 'Walls', p1: [0, 0], p2: [100, 0] },
    { id: 'e2', type: 'line', layer: 'Walls', p1: [100, 0], p2: [0, 0] },   // duplicate of e1
    { id: 'e3', type: 'line', layer: 'Walls', p1: [50, 50], p2: [50, 50] }, // zero length
    { id: 'e4', type: 'rect', layer: 'Walls', p1: [0, 0], p2: [100, 80] },
    { id: 'e5', type: 'circle', layer: 'Lock', c: [5000, 5000], r: 10 },
    { id: 'e6', type: 'text', layer: 'Ghost', p: [10, 10], text: '', size: 12 }, // empty text
    { id: 'e7', type: 'circle', layer: '0', c: [20, 20], r: 0 }              // zero radius
  ],
  currentLayer: 'Walls'
};

const plan = H.planCleanup(doc, { tolerance: 0.01 });
check('plan is an object', !!plan && Array.isArray(plan.entities) && Array.isArray(plan.layers), plan);
check('plan changes something', plan.changes === true);
check('removes exactly e2,e3,e6,e7', JSON.stringify([...plan.entities].sort()) === JSON.stringify(['e2', 'e3', 'e6', 'e7']), plan.entities);
check('keeps first duplicate e1', !plan.entities.includes('e1'));
check('keeps real geometry e4/e5', !plan.entities.includes('e4') && !plan.entities.includes('e5'));
check('counts duplicates = 1', plan.counts.duplicate === 1, plan.counts);
check('counts zeroLength = 3 (e3,e6 empty text,e7)', plan.counts.zeroLength === 3, plan.counts);
check('empty layers Empty + Ghost (not 0, not current Walls)', JSON.stringify(plan.layers.sort()) === JSON.stringify(['Empty', 'Ghost']), plan.layers);

// After applying the plan the drawing should report clean of warning-level geometry issues
const applied = {
  layers: doc.layers.filter(l => !plan.layers.includes(l.name)),
  entities: doc.entities.filter(e => !plan.entities.includes(e.id)),
  currentLayer: 'Walls'
};
const after = H.analyze(applied).summary;
check('no duplicate issues remain', !H.analyze(applied).issues.some(i => i.code === 'duplicate'));
check('no zero-length issues remain', !H.analyze(applied).issues.some(i => i.code === 'zero-length' || i.code === 'empty-text'));
const emptyLeft = H.analyze(applied).issues.filter(i => i.code === 'empty-layer').map(i => i.layer);
check('only the protected layer 0 may stay empty', JSON.stringify(emptyLeft) === JSON.stringify(['0']), emptyLeft);
check('e1 and e4 survive', applied.entities.map(e => e.id).sort().join(',') === 'e1,e4,e5', applied.entities.map(e => e.id));

// Idempotency: a second plan on the cleaned doc does nothing
const plan2 = H.planCleanup(applied, { tolerance: 0.01 });
check('second cleanup is a no-op', plan2.changes === false, plan2);

// Layer safety: never removes layer 0, current layer, or the last remaining layer
const onlyZero = { layers: [{ name: '0' }], entities: [], currentLayer: '0' };
check('never removes layer 0', H.planCleanup(onlyZero).layers.length === 0);
const twoEmpty = { layers: [{ name: '0' }, { name: 'A' }], entities: [], currentLayer: 'A' };
const p3 = H.planCleanup(twoEmpty);
check('keeps current layer A', !p3.layers.includes('A'), p3.layers);
check('never strips every layer', twoEmpty.layers.length - p3.layers.length >= 1, p3.layers);

// Tolerance sensitivity: two lines offset by less than tolerance are duplicates
const near = {
  layers: [{ name: '0' }],
  entities: [
    { id: 'n1', type: 'line', layer: '0', p1: [0, 0], p2: [10, 0] },
    { id: 'n2', type: 'line', layer: '0', p1: [0, 0.004], p2: [10, 0.004] }
  ]
};
check('near-duplicate collapses at tol 0.01', H.planCleanup(near, { tolerance: 0.01 }).entities.length === 1);
check('near-duplicate kept at tol 0.001', H.planCleanup(near, { tolerance: 0.001 }).entities.length === 0);

// Wiring checks: the UI hook and button exist
const app = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
const health = fs.readFileSync(new URL('./public/health.js', import.meta.url), 'utf8');
check('health.js exports planCleanup', /planCleanup:\s*planCleanup/.test(health));
check('app.js defines cleanupFromHealth', /function cleanupFromHealth\s*\(/.test(app));
check('app.js binds healthCleanup button', /on\('healthCleanup'/.test(app));
check('index.html has #healthCleanup', /id="healthCleanup"/.test(html));
check('index.html loads health.js before app.js', html.indexOf('/health.js') > -1 && html.indexOf('/health.js') < html.indexOf('/app.js'));
check('cleanup pushes undo', /pushUndo\(\);[\s\S]{0,400}gone\.size/.test(app));
check('cleanup never touches underlay', !/cleanupFromHealth[\s\S]{0,1200}underlay/.test(app));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
