/* Round 36 feature: Layer rename.
   Verifies (extracting real app source):
   1) renameLayer exists, uses prompt, rejects empty/duplicate names
   2) remaps entity.layer for affected entities
   3) remaps state.doc.currentLayer
   4) pushes undo before mutating and calls renderAll + markDirty
   5) renderLayers wires double-click rename on the name span (no destructive row click)
   6) regression: visibility and lock toggles still wired; undo restores previous name + entity layers
*/
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

const stub = `
const window = { __setPrompt: (val) => { __promptVal = val; } };
let __promptVal = 'PROMPT_VALUE';
const prompt = (msg, def) => __promptVal === 'PROMPT_VALUE' ? def : (__promptVal === null ? null : __promptVal);
const state = {
  doc: { layers: [ { name: 'A', color: '#fff', visible: true, locked: false },
                    { name: 'B', color: '#000', visible: true, locked: false } ],
         entities: [ { id: 'e1', type: 'line', layer: 'A', p1: [0,0], p2: [1,1] },
                     { id: 'e2', type: 'line', layer: 'B', p1: [0,0], p2: [1,1] },
                     { id: 'e3', type: 'line', layer: 'A', p1: [2,2], p2: [3,3] } ],
         currentLayer: 'A' },
  undo: [], redo: [], dirty: false, sel: new Set(),
};
let __renderAll = 0, __markDirty = 0, __toastMsg = '', __promptMsg = '';
function pushUndo() { state.undo.push(JSON.stringify({ layers: state.doc.layers, entities: state.doc.entities, currentLayer: state.doc.currentLayer })); }
function renderAll() { __renderAll++; }
function markDirty() { __markDirty++; }
function toast(t) { __toastMsg = String(t); }
function setPrompt(t) { __promptMsg = String(t); }
`;

const code = stub + grab('renameLayer') +
  '\nreturn { renameLayer, state, setPromptVal: (v) => { __promptVal = v; }, getters: () => ({ renderAll: __renderAll, markDirty: __markDirty, toast: __toastMsg, promptMsg: __promptMsg }) };';
const fn = new Function(code);
const env = fn();
const { renameLayer, state } = env;
const g = () => env.getters();

const layerA = () => state.doc.layers[0];

// 1: rename to new unique name
const before = JSON.parse(state.undo.length ? state.undo[0] : JSON.stringify({ layers: state.doc.layers, entities: state.doc.entities, currentLayer: state.doc.currentLayer }));
env.getters(); // touch
env.setPromptVal('Rooms'); renameLayer(layerA());
check('layer renamed to new name', layerA().name === 'Rooms');
check('entities on renamed layer remapped', state.doc.entities.filter(e => e.layer === 'Rooms').length === 2 &&
      state.doc.entities.find(e => e.id === 'e2').layer === 'B');
check('currentLayer remapped', state.doc.currentLayer === 'Rooms');
check('undo snapshot pushed before mutation', state.undo.length === 1 && JSON.parse(state.undo[0]).layers[0].name === 'A');
check('renderAll called', g().renderAll === 1);
check('markDirty called', g().markDirty === 1);
check('prompt feedback shown', /Renamed layer/.test(g().promptMsg), g().promptMsg);

// 2: duplicate name rejected
const dupPromptToast = (() => {
  const beforeName = layerA().name;
  // simulate prompt returning duplicate
  const code2 = stub.replace("__promptVal = 'PROMPT_VALUE'", "__promptVal = 'B'") + '\n' + grab('renameLayer') +
    '\nreturn { renameLayer, state, getters: () => ({ toast: __toastMsg }) };';
  const env2 = new Function(code2)();
  env2.renameLayer(env2.state.doc.layers[0], null);
  return { name: env2.state.doc.layers[0].name, toast: env2.getters().toast, undoLen: env2.state.undo.length };
})();
check('duplicate name rejected with toast, no change', dupPromptToast.name === 'A' && /already exists/.test(dupPromptToast.toast) && dupPromptToast.undoLen === 0, dupPromptToast.toast);

// 3: empty name rejected
const emptyRes = (() => {
  const code3 = stub.replace("__promptVal = 'PROMPT_VALUE'", "__promptVal = '  '") + '\n' + grab('renameLayer') +
    '\nreturn { renameLayer, state, getters: () => ({ }) };';
  const env3 = new Function(code3)();
  env3.renameLayer(env3.state.doc.layers[0], null);
  return env3.state.doc.layers[0].name;
})();
check('empty/whitespace name rejected', emptyRes === 'A');

// 4: cancel (null) rejected
const cancelRes = (() => {
  const code4 = stub.replace("__promptVal = 'PROMPT_VALUE'", "__promptVal = null") + '\n' + grab('renameLayer') +
    '\nreturn { renameLayer, state, getters: () => ({ }) };';
  const env4 = new Function(code4)();
  env4.renameLayer(env4.state.doc.layers[0], null);
  return env4.state.doc.layers[0].name;
})();
check('cancel (null) leaves name unchanged', cancelRes === 'A');

// 5: UI wiring in real source
check('renderLayers wires ondblclick rename', /nm\.ondblclick = \(ev\) => \{ ev\.stopPropagation\(\); renameLayer\(L\); \};/.test(src));
check('nm uses textContent not innerHTML (no injection)', /nm\.textContent = L\.name;/.test(src));
check('visibility toggle still wired', /L\.visible = !L\.visible; renderAll\(\); markDirty\(\);/.test(src));
check('lock toggle still wired', /L\.locked = !L\.locked; renderAll\(\); markDirty\(\);/.test(src));
check('row click still sets current layer', /state\.doc\.currentLayer = L\.name; renderLayers\(\);/.test(src));
check('renameLayer pushes undo before mutating (order in source)', /pushUndo\(\);\s*\n\s*L\.name = trimmed;/.test(src));

// 6: undo restores previous state
{
  const codeU = stub + '\nfunction snapshot(){ return JSON.stringify({ layers: state.doc.layers, entities: state.doc.entities, currentLayer: state.doc.currentLayer }); }\n' +
    grab('renameLayer') + '\n' + grab('restore') + '\n' + grab('undo') +
    '\nfunction draw() {}\nfunction renderAll(){}\nfunction markDirty(){}\nfunction toast(){}\nfunction setPrompt(){}\nfunction pushUndo(){ state.undo.push(snapshot()); }' +
    '\nreturn { renameLayer, undo, state };';
  const envU = new Function(codeU)();
  envU.renameLayer(envU.state.doc.layers[0], 'NewName');
  envU.undo();
  check('undo restores layer name and entity layers',
    envU.state.doc.layers[0].name === 'A' && envU.state.doc.entities.filter(e => e.layer === 'A').length === 2 &&
    envU.state.doc.currentLayer === 'A');
}

console.log(checks + ' checks, ' + fails + ' failures');
process.exit(fails === 0 ? 0 : 1);
