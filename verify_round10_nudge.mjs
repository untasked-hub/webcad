// Round 10 acceptance checks: arrow-key nudge for the selected objects.
// Run: node apps/webcad/verify_round10_nudge.mjs
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
let pass = 0, fail = 0;
function check(name, condition) {
  if (condition) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

// --- static wiring -------------------------------------------------------
check('keydown handler routes all four arrow keys into nudgeSelection',
  /ev\.key === 'ArrowLeft'[\s\S]{0,200}nudgeSelection\(ev\.key, ev\.shiftKey \? 10 : 1\)/.test(app));

check('arrow routing sits after the toggle/F-key block so it cannot shadow F3/F7/F8/F9/F10',
  app.indexOf("if (ev.key === 'F9')") < app.indexOf("if (ev.key === 'ArrowLeft'"));

check('drafting guide documents the nudge shortcut',
  /data-search="nudge arrow keys/.test(html) && /<kbd>Arrows<\/kbd>/.test(html));

check('nudge is not reachable from the command bar or a modal input (typing guard precedes it)',
  app.indexOf("const typing = tag === 'input' || tag === 'textarea';") <
  app.indexOf("if (ev.key === 'ArrowLeft'"));

// --- behavioural slice ---------------------------------------------------
const start = app.indexOf('function nudgeSelection(');
const end = app.indexOf('function deleteSelection(', start);
if (start < 0 || end < 0) { console.log('FAIL could not slice nudgeSelection'); process.exit(1); }
const slice = app.slice(start, end);

function makeCtx(sel, readOnly, locked) {
  const ctx = {
    undo: 0, prompts: [], toasts: [], draws: 0, rendered: 0, dirtyMarks: 0,
    state: {
      doc: {
        layers: [{ name: '0', locked: false }, { name: 'Walls', locked: !!locked }],
        entities: [
          { id: 'e1', type: 'line', layer: 'Walls', p1: [0, 0], p2: [100, 0] },
          { id: 'e2', type: 'text', layer: '0', p: [10, 10], text: 'A', size: 5 },
          { id: 'e3', type: 'arc', layer: '0', c: [50, 50], r: 5, a0: 0, a1: 90 },
        ],
      },
      sel: new Set(sel),
      readOnly: !!readOnly,
      dirty: false,
    },
  };
  ctx.pushUndo = () => { ctx.undo++; };
  ctx.markDirty = () => { ctx.dirtyMarks++; };
  ctx.renderAll = () => { ctx.rendered++; };
  ctx.draw = () => { ctx.draws++; };
  ctx.setPrompt = (t) => { ctx.prompts.push(t); };
  ctx.lockedLayer = (name) => { const L = ctx.state.doc.layers.find(l => l.name === name); return !!(L && L.locked); };
  ctx.applyTranslate = (ents, d) => {
    for (const e of ents) {
      if (e.p1) { e.p1 = [e.p1[0] + d[0], e.p1[1] + d[1]]; e.p2 = [e.p2[0] + d[0], e.p2[1] + d[1]]; }
      if (e.c) e.c = [e.c[0] + d[0], e.c[1] + d[1]];
      if (e.p) e.p = [e.p[0] + d[0], e.p[1] + d[1]];
    }
  };
  vm.createContext(ctx);
  vm.runInContext(slice + '\nthis.nudgeSelection = nudgeSelection;', ctx);
  return ctx;
}

let c = makeCtx(['e1']);
check('ArrowRight moves a selected line by +1 in x and pushes exactly one undo step',
  c.nudgeSelection('ArrowRight', 1) === true &&
  c.state.doc.entities[0].p1[0] === 1 &&
  c.state.doc.entities[0].p2[0] === 101 &&
  c.undo === 1);

check('a nudge marks the drawing dirty and re-renders the canvas and panels',
  c.dirtyMarks === 1 && c.state.dirty === true && c.rendered === 1 && c.draws === 1);

check('the status prompt reports the delta and the Shift hint',
  c.prompts.length === 1 && /\+?1, 0/.test(c.prompts[0]) && /Shift\+Arrow = 10/.test(c.prompts[0]));

c = makeCtx(['e2']);
c.nudgeSelection('ArrowUp', 10);
check('Shift amount (10) moves text downward-free upward (+y) by exactly 10',
  c.state.doc.entities[1].p[0] === 10 && c.state.doc.entities[1].p[1] === 20);

c = makeCtx(['e3']);
c.nudgeSelection('ArrowLeft', 1);
c.nudgeSelection('ArrowDown', 10);
check('repeated nudges accumulate and each is its own undo step',
  c.state.doc.entities[2].c[0] === 49 && c.state.doc.entities[2].c[1] === 40 && c.undo === 2);

c = makeCtx(['e1', 'e2']);
c.nudgeSelection('ArrowRight', 1);
check('multi-selection nudges every object together in one undo step',
  c.state.doc.entities[0].p1[0] === 1 && c.state.doc.entities[1].p[0] === 11 && c.undo === 1);

c = makeCtx(['e1'], false, true);
const lockedRes = c.nudgeSelection('ArrowRight', 1);
check('an object on a locked layer is not moved and no undo step is pushed',
  lockedRes === true && c.state.doc.entities[0].p1[0] === 0 && c.undo === 0 &&
  /locked layer/.test(c.prompts[0]));

c = makeCtx([]);
const emptyRes = c.nudgeSelection('ArrowRight', 1);
check('with nothing selected the key is consumed with a hint instead of moving anything',
  emptyRes === true && c.undo === 0 && c.state.doc.entities[0].p1[0] === 0 &&
  /select objects first/.test(c.prompts[0]));

c = makeCtx(['e1'], true);
check('read-only viewers get no move at all',
  c.nudgeSelection('ArrowRight', 1) === false && c.state.doc.entities[0].p1[0] === 0 && c.undo === 0);

c = makeCtx(['e1']);
check('a non-arrow key is not handled by nudgeSelection',
  c.nudgeSelection('Enter', 1) === false && c.undo === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;