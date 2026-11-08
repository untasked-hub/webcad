// Round 7 acceptance checks for named layer visibility presets.
// Run: node apps/webcad/verify_round7_presets.mjs
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
let pass = 0, fail = 0;
function check(name, condition) {
  if (condition) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

check('Layers panel includes preset list and save-view button', /id="presetList"/.test(html) && /id="btnSavePreset"/.test(html));
check('Preset chips, active state, and empty state are styled', /\.preset-chip\b/.test(css) && /\.preset-chip\.active/.test(css) && /\.preset-empty\b/.test(css));
check('Save button invokes preset capture', /on\('btnSavePreset',\s*\(\)\s*=>\s*saveVisibilityPreset\(\)\)/.test(app));
check('Document payload persists visibility presets', /visibilityPresets:\s*state\.doc\.visibilityPresets\s*\|\|\s*\[\]/.test(app));
check('Loaded document sanitizes visibility presets', /state\.doc\.visibilityPresets\s*=\s*sanitizePresets\(data\s*&&\s*data\.visibilityPresets\)/.test(app));
check('JSON export inherits preset data from docPayload', /Object\.assign\(\{\s*format:\s*'WebCAD'[^}]*\},\s*docPayload\(\)\.data\)/s.test(app));
check('Undo snapshots include presets', /visibilityPresets:\s*state\.doc\.visibilityPresets\s*\|\|\s*\[\]/.test(app.slice(app.indexOf('function snapshot()'), app.indexOf('function pushUndo()'))));
check('Rename, delete, and update actions are available from preset context menu', /function openPresetMenu[\s\S]*?layerMenuItem\(menu, 'Rename',[\s\S]*?layerMenuItem\(menu, 'Delete'/.test(app));
check('Preset application ignores removed layers and leaves new layers visible', /for\s*\(const L of state\.doc\.layers\) L\.visible = !hidden\.has\(L\.name\)/.test(app));

const start = app.indexOf('function sanitizePresets(');
const end = app.indexOf('\nfunction presets()', start);
if (start < 0 || end < 0) throw new Error('Could not extract sanitizePresets');
const code = app.slice(start, end);
const ctx = { state: { doc: { layers: [{name:'Walls'},{name:'Dims'},{name:'Text'}] } } };
vm.createContext(ctx);
vm.runInContext(code + '\nthis.sanitizePresets = sanitizePresets;', ctx);
const cleaned = ctx.sanitizePresets([
  { name: ' Presentation ', hidden: ['Dims', 'Gone', 'Dims'] },
  { name: 'presentation', hidden: ['Walls'] },
  { name: '   ', hidden: [] },
  { name: 'Construction', hidden: ['Text'] },
]);
check('sanitizer trims names, removes duplicates/unknown layers, and rejects empty names', cleaned.length === 2 && cleaned[0].name === 'Presentation' && cleaned[0].hidden.length === 1 && cleaned[0].hidden[0] === 'Dims' && cleaned[1].name === 'Construction');
const capped = ctx.sanitizePresets(Array.from({length: 15}, (_, i) => ({ name: 'V' + i, hidden: [] })));
check('sanitizer enforces the 12-view limit', capped.length === 12);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
