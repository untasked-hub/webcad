// Round 9 acceptance checks: reusable drawing starter templates.
// Run: node apps/webcad/verify_round9_templates.mjs
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
let pass = 0, fail = 0;
function check(name, condition) {
  if (condition) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

check('style.css defines .lp-templates, .lp-template-grid, and .lp-template rules',
  /\.launch-panel \.lp-templates/.test(css) &&
  /\.launch-panel \.lp-template-grid/.test(css) &&
  /\.launch-panel \.lp-template\b/.test(css));

check('launch panel renders data-template starter buttons alongside Blank drawing',
  /id="spBlank"/.test(app) &&
  /data-template="/.test(app) &&
  /querySelectorAll\('\[data-template\]'\)/.test(app));

check('startFromTemplate checks approveReplace before replacing a dirty drawing',
  /async function startFromTemplate[\s\S]{0,260}approveReplace\(/.test(app));

const a = app.indexOf('function emptyDoc()');
const b = app.indexOf('/* ---------- math ---------- */', a);
const slice = app.slice(a, b);

const ctx = {
  state: { doc: null, readOnly: false, dirty: false },
  loaded: null,
  approveCalls: 0,
  approveResult: true,
  esc(s) { return String(s); },
  panelUnitsValue() { return 'mm'; },
  unitLabelOf(u) { return u === 'in' ? 'in' : 'mm'; },
  applyUnitConversion(doc, u) {
    doc.units = u;
    if (u === 'in') {
      const k = 1 / 25.4;
      for (const e of doc.entities) {
        if (e.p1) { e.p1 = [e.p1[0] * k, e.p1[1] * k]; e.p2 = [e.p2[0] * k, e.p2[1] * k]; }
        if (e.c) { e.c = [e.c[0] * k, e.c[1] * k]; e.r *= k; }
        if (e.p) { e.p = [e.p[0] * k, e.p[1] * k]; e.size *= k; }
        if (typeof e.offset === 'number') e.offset *= k;
      }
    }
    return doc;
  },
  async approveReplace() { ctx.approveCalls++; return ctx.approveResult; },
  loadDoc(doc, id, name, ro) { ctx.loaded = { doc, id, name, readOnly: !!ro }; },
  history: { replaceState() {} },
  zoomExtents() {},
  markDirty() { ctx.state.dirty = true; },
  hideLaunchPanel() { ctx.hidden = true; },
  setPrompt(p) { ctx.prompt = p; },
  toast(t) { ctx.toastMsg = t; },
  document: { getElementById() { return null; } },
};
vm.createContext(ctx);
vm.runInContext(slice + '\nthis.STARTER_TEMPLATES = STARTER_TEMPLATES; this.starterTemplate = starterTemplate; this.startFromTemplate = startFromTemplate;', ctx);

check('three curated practical starter templates are registered (room, garden, bench)',
  ctx.STARTER_TEMPLATES.length === 3 &&
  ctx.STARTER_TEMPLATES.map(t => t.id).join(',') === 'room,garden,bench');

for (const t of ctx.STARTER_TEMPLATES) {
  const d = t.build();
  const layerNames = new Set(d.layers.map(l => l.name));
  const ids = new Set(d.entities.map(e => e.id));
  const validLayers = d.entities.every(e => layerNames.has(e.layer));
  const hasWalls = d.entities.some(e => e.layer === 'Walls');
  const hasDims = d.entities.some(e => e.type === 'dim' && e.layer === 'Dims');
  const hasText = d.entities.some(e => e.type === 'text' && e.layer === 'Text');
  const hasPreset = Array.isArray(d.visibilityPresets) && d.visibilityPresets.length >= 1;
  check(`template "${t.id}" builds valid geometry, layers, dimensions, labels, and a saved view`,
    d.entities.length >= 6 && ids.size === d.entities.length && validLayers && hasWalls && hasDims && hasText && hasPreset);
}

const okRoom = await ctx.startFromTemplate('room', 'mm');
check('starting from a template opens an editable (non-readOnly) named document and marks dirty',
  okRoom === true &&
  ctx.loaded &&
  ctx.loaded.name === 'Room layout' &&
  ctx.loaded.readOnly === false &&
  ctx.state.dirty === true &&
  ctx.hidden === true);

const okIn = await ctx.startFromTemplate('bench', 'in');
check('starting from a template converts coordinates when inches are selected',
  okIn === true &&
  ctx.loaded.doc.units === 'in' &&
  Math.abs(ctx.loaded.doc.entities[0].p2[0] - 1800 / 25.4) < 1e-6);

ctx.approveResult = false;
ctx.loaded = null;
const cancelled = await ctx.startFromTemplate('garden', 'mm');
check('cancelling the unsaved-work guard leaves the current drawing untouched',
  cancelled === false && ctx.loaded === null);

const unknown = await ctx.startFromTemplate('nonexistent', 'mm');
check('unknown template id returns false cleanly', unknown === false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
