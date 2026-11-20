// Browser recovery checkpoint policy regression tests. Run with: node test/recovery-checkpoint.test.js
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');

// Keep this test isolated from browser startup; exercise storage helpers with a minimal VM.
const start = source.indexOf('let recoveryTimer = null;');
const end = source.indexOf('\nfunction docName()', start);
if (start < 0 || end < 0) throw new Error('recovery checkpoint helpers not found');
const block = source.slice(start, end).replace(/function markDirty\(\) \{[\s\S]*?\n\}/, '');
const store = new Map();
const ctx = {
  state: { doc: { entities: [] }, readOnly: false, dirty: true, drawingId: null },
  localStorage: { setItem: (k, v) => store.set(k, v), getItem: k => store.get(k) || null, removeItem: k => store.delete(k) },
  Date, JSON, Number, window: { confirm: () => false }, console,
  docPayload: () => ({ name: 'Plan', data: { entities: [{ type: 'line' }] } }),
  loadDoc: (data, id, name) => { ctx.loaded = { data, id, name }; },
  markDirty: () => { ctx.state.dirty = true; }, setPrompt: x => { ctx.prompt = x; }, toast: x => { ctx.toastText = x; },
};
vm.createContext(ctx);
vm.runInContext(block + '\nthis.writeRecoveryCheckpoint=writeRecoveryCheckpoint; this.clearRecoveryCheckpoint=clearRecoveryCheckpoint; this.offerRecoveryCheckpoint=offerRecoveryCheckpoint;', ctx);
ctx.writeRecoveryCheckpoint();
let saved = JSON.parse(store.get('webcad-local-recovery-v1'));
if (saved.version !== 1 || saved.document.name !== 'Plan') throw new Error('checkpoint payload missing/version mismatch');
ctx.state.readOnly = true; ctx.writeRecoveryCheckpoint();
if (JSON.parse(store.get('webcad-local-recovery-v1')).savedAt !== saved.savedAt) throw new Error('read-only state must not overwrite checkpoint');
ctx.state.readOnly = false;
ctx.window.confirm = () => true;
ctx.offerRecoveryCheckpoint();
if (!ctx.loaded || ctx.loaded.name !== 'Plan' || !ctx.state.dirty) throw new Error('restore should reload payload and remain dirty');
ctx.clearRecoveryCheckpoint();
if (store.has('webcad-local-recovery-v1')) throw new Error('clear should remove local checkpoint');
console.log('PASS local recovery checkpoint save, read-only guard, restore, and clear');
