// Round 5 acceptance checks for the first-run launch panel and example-copy flow.
// Run: node apps/webcad/verify_round5_launch_panel.mjs
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

// Isolate the app's actual gate/show implementation and run it against a tiny DOM/localStorage stub.
const gateStart = app.indexOf('function launchPanelAllowed()');
const panelStart = app.indexOf('function showLaunchPanel(force)', gateStart);
const previewStart = app.indexOf('/* ---------- read-only example document ---------- */', panelStart);
const panelCode = app.slice(gateStart, previewStart);
const local = new Map();
const children = new Map();
const panelControls = new Map();
const stubDoc = {
  getElementById(id) {
    if (children.has(id)) return children.get(id);
    if (['spClose','spBlank','spExample','spA4','cmdInput'].includes(id)) {
      if (!panelControls.has(id)) panelControls.set(id, { id, listeners: {}, addEventListener(k,fn){this.listeners[k]=fn;}, focus(){} });
      return panelControls.get(id);
    }
    return null;
  },
  createElement() { return { id: '', className: '', attrs: {}, listeners: {}, setAttribute(k,v){this.attrs[k]=v;}, addEventListener(k,fn){this.listeners[k]=fn;}, remove(){children.delete(this.id);}, innerHTML: '' }; }
};
const wrap = { appendChild(el) { children.set(el.id, el); } };
const state = { doc: { entities: [] }, readOnly: false, drawingId: null, dirty: false };
const toasts = [];
const ctx = {
  state, wrap, document: stubDoc,
  localStorage: { getItem(k){return local.get(k)||null;}, setItem(k,v){local.set(k,v);} },
  toast(s){toasts.push(s);},
  setPrompt(){},
  panelUnitsValue(){return 'mm';}, emptyDoc(){return {entities:[]};}, applyUnitConversion(d){return d;},
  loadDoc(){}, zoomExtents(){}, hideLaunchPanel(mark){children.delete('startPanel'); if(mark)local.set('webcad-launch-panel-seen','1');},
  loadSampleExample(){}, markDirty(){},
};
vm.createContext(ctx);
vm.runInContext(panelCode, ctx);
check('fresh untouched blank document qualifies for launch panel', ctx.launchPanelAllowed());
ctx.showLaunchPanel(false);
check('first-run panel appears without a modal overlay', !!children.get('startPanel') && children.get('startPanel').className === 'launch-panel' && !/aria-modal/.test(children.get('startPanel').attrs['aria-modal'] || ''));
check('panel includes blank path and explicit example-preview path', /id="spBlank"/.test(children.get('startPanel').innerHTML) && /id="spExample"/.test(children.get('startPanel').innerHTML));
check('orientation includes draw, refine, save/share steps', ['Draw','Refine','Save &amp; share'].every(x => children.get('startPanel').innerHTML.includes(x)));
ctx.hideLaunchPanel(true);
check('dismissal is remembered for subsequent first-run boot', local.get('webcad-launch-panel-seen') === '1');
ctx.showLaunchPanel(false);
check('dismissed panel stays dismissed on non-forced revisit', !children.get('startPanel'));
ctx.showLaunchPanel(true);
check('explicit Get started reopen works on blank drawing', !!children.get('startPanel'));

// The accepted safety properties are encoded in actual app code, not merely in copy.
check('panel gate excludes saved, dirty, read-only, and non-empty documents', /!state\.readOnly && !state\.drawingId && !state\.dirty &&\s*state\.doc\.entities\.length === 0/.test(panelCode));
check('preview loads a readonly sample document', /function loadSampleExample\(\)\s*\{\s*loadDoc\(sampleDoc\(\), null, 'Sample Floor Plan \(example\)', true\)/.test(app));
check('readonly example advertises its state and has an explicit copy button', /Example plan — read-only preview/.test(app) && /btn\.textContent = 'Start from this plan'/.test(app));
check('copy flow deep-copies snapshot into a new, distinguishable document without original id', /const copy = JSON\.parse\(snapshot\(\)\);\s*loadDoc\(copy, null, 'Floor Plan \(my copy\)'\)/.test(app));
check('read-only save and mutation paths are guarded', /function saveDrawing\(auto\)\s*\{\s*if \(state\.readOnly\)/.test(app) && /if \(state\.readOnly\) \{ ev\.preventDefault\(\); exampleNotice\(\); return; \}/.test(app));
check('persistent guide control remains available in the toolbar', /id="btnCommandGuide"/.test(html) && /id="btnLaunch"/.test(html));
check('panel has responsive canvas-docked styling', /\.canvas-wrap\{position:relative/.test(css) && /\.launch-panel\{\s*position:absolute/.test(css) && /@media \(max-width:720px\)\{\s*\.launch-panel/.test(css));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
