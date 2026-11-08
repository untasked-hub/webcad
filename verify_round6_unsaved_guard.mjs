// Round 6 acceptance checks for the unsaved-work guard on New / Open / Import.
// Run: node apps/webcad/verify_round6_unsaved_guard.mjs
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
let pass = 0, fail = 0;
function check(name, condition, detail) {
  if (condition) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

check('HTML includes #replaceModal with Save, Discard, and Cancel buttons',
  /id="replaceModal"/.test(html) && /id="replaceSave"/.test(html) &&
  /id="replaceDiscard"/.test(html) && /id="replaceCancel"/.test(html));
check('CSS styles .replace-msg and .replace-foot',
  /\.replace-msg\b/.test(css) && /\.replace-foot\b/.test(css));
check('beforeunload only prevents unload while state.dirty is true',
  /addEventListener\('beforeunload',\s*\(ev\)\s*=>\s*\{\s*if\s*\(state\.dirty\)/.test(app));

const gStart = app.indexOf('/* ---------- unsaved-work guard (round 6) ---------- */');
const gEnd = app.indexOf('/* ---------- end unsaved-work guard ---------- */');
check('guard block present in app.js', gStart > 0 && gEnd > gStart);

const grab = (sig) => {
  const i = app.indexOf(sig);
  if (i < 0) throw new Error('missing ' + sig);
  let d = 0, j = app.indexOf('{', i);
  for (let k = j; k < app.length; k++) {
    if (app[k] === '{') d++;
    else if (app[k] === '}') { d--; if (d === 0) return app.slice(i, k + 1); }
  }
};

const code = [
  app.slice(gStart, gEnd),
  grab('async function openDrawing('),
  grab('async function newDrawing('),
  grab('async function importJSONText('),
].join('\n');

const els = {
  replaceModal: {
    shown: false,
    classList: {
      add(c) { if (c === 'show') els.replaceModal.shown = true; },
      remove(c) { if (c === 'show') els.replaceModal.shown = false; },
    },
  },
  replaceMsg: { textContent: '' },
  replaceSave: { focus() {} },
};

const state = { dirty: false, readOnly: false, doc: { entities: [{ id: 'e1' }] }, drawingId: 'd1' };
const loaded = [];
const toasts = [];
let saveResult = 'saved-id';
let saveCalls = 0;
let fetchCount = 0;

const ctx = {
  state,
  window: { confirm: () => false },
  document: { getElementById: (id) => els[id] || null },
  history: { replaceState() {} },
  fetch: async (u) => {
    fetchCount++;
    return { ok: true, json: async () => ({ drawing: { id: 'd2', name: 'Plan B', data: { entities: [] } } }) };
  },
  saveDrawing: async () => { saveCalls++; if (saveResult) state.dirty = false; return saveResult; },
  loadDoc: (data, id, name) => { state.dirty = false; loaded.push({ id, name, count: (data.entities || []).length }); },
  emptyDoc: () => ({ entities: [] }),
  closeOpen: () => {},
  setPrompt: () => {},
  showLaunchPanel: () => {},
  markDirty: () => { state.dirty = true; },
  toast: (m) => toasts.push(String(m)),
};
vm.createContext(ctx);
vm.runInContext(code, ctx);

// 1. Clean drawing: New and Open run with zero modal prompts.
state.dirty = false;
await ctx.newDrawing();
check('clean drawing: newDrawing replaces immediately without showing modal',
  loaded.length === 1 && loaded[0].name === 'Untitled Drawing' && !els.replaceModal.shown);

await ctx.openDrawing('d2');
check('clean drawing: openDrawing loads immediately without showing modal',
  loaded.length === 2 && loaded[1].id === 'd2' && !els.replaceModal.shown);

// 2. Read-only example preview: never prompts even if dirty flag were set.
state.dirty = true; state.readOnly = true;
await ctx.newDrawing();
check('read-only preview bypasses unsaved guard', loaded.length === 3 && !els.replaceModal.shown);
state.readOnly = false;

// 3. Dirty drawing + Cancel: keeps current drawing, does not fetch or replace.
state.dirty = true;
const beforeLen = loaded.length;
const beforeFetch = fetchCount;
const pCancel = ctx.openDrawing('d2');
check('dirty openDrawing opens #replaceModal with contextual message',
  els.replaceModal.shown && /open another drawing/.test(els.replaceMsg.textContent));
ctx.finishReplace('cancel');
await pCancel;
check('Cancel aborts openDrawing without fetching or replacing canvas',
  loaded.length === beforeLen && fetchCount === beforeFetch && state.dirty === true && !els.replaceModal.shown);

// 4. Dirty drawing + Discard: replaces without saving.
state.dirty = true;
const pDiscard = ctx.newDrawing();
ctx.finishReplace('discard');
await pDiscard;
check('Discard replaces drawing without calling saveDrawing',
  loaded.length === beforeLen + 1 && saveCalls === 0 && state.dirty === false);

// 5. Dirty drawing + Save & continue (save succeeds): saves first, then replaces.
state.dirty = true;
saveResult = 'saved-99';
const pSave = ctx.importJSONText(JSON.stringify({ name: 'Site Plan', data: { entities: [{ id: 'a' }, { id: 'b' }] } }));
ctx.finishReplace('save');
await pSave;
check('Save & continue calls saveDrawing then completes import',
  saveCalls === 1 && loaded[loaded.length - 1].name === 'Site Plan' && loaded[loaded.length - 1].count === 2);

// 6. Dirty drawing + Save & continue when save fails: aborts replacement so work is not lost.
state.dirty = true;
saveResult = null;
const keepCount = loaded.length;
const pFail = ctx.newDrawing();
ctx.finishReplace('save');
await pFail;
check('failed save aborts replacement and warns via toast',
  loaded.length === keepCount && state.dirty === true && toasts.some(t => /nothing was replaced/i.test(t)));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
