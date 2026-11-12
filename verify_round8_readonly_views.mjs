// Round 8 acceptance checks: saved layer views work on read-only share pages.
// Run: node apps/webcad/verify_round8_readonly_views.mjs
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
let pass = 0, fail = 0;
function check(name, condition) {
  if (condition) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}
function slice(startMarker, endMarker) {
  const a = app.indexOf(startMarker);
  if (a < 0) throw new Error('missing ' + startMarker);
  const b = app.indexOf(endMarker, a);
  if (b < 0) throw new Error('missing end for ' + startMarker);
  return app.slice(a, b);
}

const applySrc = slice('function applyVisibilityPreset(', 'function renameVisibilityPreset(');
check('apply pushes undo only when the drawing is editable',
  /if \(!state\.readOnly\) pushUndo\(\);/.test(applySrc) && !/^\s*pushUndo\(\);/m.test(applySrc));
check('apply marks dirty only when editable',
  /if \(!state\.readOnly\) \{ state\.dirty = true; markDirty\(\); \}/.test(applySrc));
check('apply still re-resolves hidden layer names against current layers',
  /for \(const L of state\.doc\.layers\) L\.visible = !hidden\.has\(L\.name\)/.test(applySrc) &&
  /p\.hidden = p\.hidden\.filter\(n => state\.doc\.layers\.some\(l => l\.name === n\)\)/.test(applySrc));
check('apply reports a review-mode prompt instead of the read-only warning',
  /View applied for review/.test(applySrc) && !/exampleNotice/.test(applySrc));

const saveSrc = slice('function saveVisibilityPreset(', 'function applyVisibilityPreset(');
check('saving a new view is blocked on read-only documents',
  /if \(state\.readOnly\) \{ exampleNotice\(\); return; \}/.test(saveSrc));

const chipSrc = slice('function renderPresets(', '/* ---------- layer context menu ---------- */');
check('read-only viewers get no preset editing context menu',
  /chip\.oncontextmenu = state\.readOnly[\s\S]{0,80}ev\.preventDefault\(\); ev\.stopPropagation\(\); \}/.test(chipSrc));
check('preset tooltip lists the hidden layer names',
  /p\.hidden\.length \? ': ' \+ p\.hidden\.join\(', '\)/.test(chipSrc));

const eyeSrc = slice('const eye = document.createElement', 'const lock = document.createElement');
check('layer eye toggle never dirties a read-only drawing',
  /if \(state\.readOnly\) setPrompt\(/.test(eyeSrc) && /else markDirty\(\);/.test(eyeSrc) &&
  !/renderAll\(\); markDirty\(\); \};/.test(eyeSrc));

// Behavioural check: run applyVisibilityPreset in a read-only document context.
const sandbox = {
  state: {
    readOnly: true,
    dirty: false,
    doc: {
      layers: [{ name: 'Walls', visible: true }, { name: 'Dims', visible: true }, { name: 'Text', visible: true }],
      visibilityPresets: [{ name: 'Presentation', hidden: ['Dims', 'Gone'] }, { name: 'All', hidden: [] }],
    },
  },
  undoCalls: 0,
  dirtyCalls: 0,
  prompts: [],
  pushUndo() { sandbox.undoCalls++; },
  markDirty() { sandbox.dirtyCalls++; },
  setPrompt(t) { sandbox.prompts.push(t); },
  renderAll() {},
};
sandbox.presets = () => sandbox.state.doc.visibilityPresets;
vm.createContext(sandbox);
vm.runInContext(applySrc + '\nthis.applyVisibilityPreset = applyVisibilityPreset;', sandbox);
sandbox.applyVisibilityPreset(0);

check('read-only apply hides exactly the preset layers',
  sandbox.state.doc.layers[0].visible === true &&
  sandbox.state.doc.layers[1].visible === false &&
  sandbox.state.doc.layers[2].visible === true);
check('read-only apply makes no undo entry and no dirty state',
  sandbox.undoCalls === 0 && sandbox.dirtyCalls === 0 && sandbox.state.dirty === false);
check('read-only apply prunes layer names that no longer exist',
  JSON.stringify(sandbox.state.doc.visibilityPresets[0].hidden) === '["Dims"]');
check('read-only apply announces the review-mode result',
  /View applied for review/.test(sandbox.prompts.join(' | ')));

// Same function must still be an undoable edit in an editable document.
sandbox.state.readOnly = false;
sandbox.applyVisibilityPreset(1);
check('editable apply still pushes undo and marks dirty',
  sandbox.undoCalls === 1 && sandbox.dirtyCalls === 1 && sandbox.state.dirty === true);
check('editable apply restores every layer when the view hides nothing',
  sandbox.state.doc.layers.every(l => l.visible === true));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
