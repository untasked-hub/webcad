// Round 37 feature: typed Properties editing for the selected entity.
// Checks:
//  1) renderProps builds an editable form for a single selected entity
//  2) per-type editable fields: circle radius, rect W/H, arc radius, text string+height, dim offset
//  3) commit path: Enter key handler -> pushUndo, applyFn mutation, markDirty, renderAll, setPrompt
//  4) Apply button commits all fields, skips invalid values
//  5) validation: non-numeric rejected; radius/size/width/height must be positive; offset may be 0/negative
//  6) multi-selection stays read-only (no edit form)
//  7) read-only rows still shown (Start/End/Length/Angle etc.)
//  8) Escape key re-renders (discards edit)
//  9) panel markup/styles present in style.css
// 10) no model writes inside draw path (edit form lives only in renderProps)
import { readFileSync } from 'fs';
const app = readFileSync('public/app.js', 'utf-8');
const css = readFileSync('public/style.css', 'utf-8');
let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : (fail++, console.log('FAIL', n)); console.log(c ? 'PASS' : '----', n); };

ok('renderProps builds .prop-edit form for single selection', app.includes('prop-edit') && app.includes("form.className = 'prop-edit'"));
ok('circle radius editable', /'circle'[\s\S]{0,200}edits\.push\(\['Radius', e\.r,/.test(app));
ok('rect width+height editable', /'rect'[\s\S]{0,300}\['Width', Math\.abs\(e\.p2\[0\] - e\.p1\[0\]\)/.test(app) && app.includes("['Height', Math.abs(e.p2[1] - e.p1[1])"));
ok('arc radius editable', /'arc'[\s\S]{0,300}edits\.push\(\['Radius', e\.r,/.test(app));
ok('text string + height editable', app.includes("['Text', e.text || ''") && app.includes("['Height', e.size"));
ok('dim offset editable', /'dim'[\s\S]{0,300}\['Offset', e\.offset \|\| 0,/.test(app));
ok('Enter commits: pushUndo + apply + markDirty + renderAll', /'Enter'\) \{ ev\.preventDefault\(\); commit\(\); \}/.test(app) &&
   /const commit = \(\) => \{[\s\S]{0,400}pushUndo\(\);[\s\S]{0,400}applyFn\(e, raw\);[\s\S]{0,200}markDirty\(\);[\s\S]{0,120}renderAll\(\);/.test(app));
ok('Apply button commits all fields', app.includes("btn.textContent = 'Apply'") && /btn\.onclick = \(\) => \{[\s\S]{0,400}inputs\.forEach/.test(app));
ok('non-numeric numeric field rejected', app.includes('if (label !== \'Text\' && (!isFinite(raw)))'));
ok('positive-only validation (radius/size/w/h), offset exempt', app.includes("raw <= 0 && label !== 'Offset'"));
ok('multi-selection stays read-only', app.includes('if (!readOnly && edits.length)') && app.includes("const readOnly = sel.length > 1"));
ok('read-only rows preserved (Start/End/Length/Angle)', app.includes("['Start', pt(e.p1)], ['End', pt(e.p2)], ['Length'") && app.includes("['Angle'"));
ok('Escape discards edit (re-render)', app.includes("if (ev.key === 'Escape') { renderProps(); }"));
ok('aria-label on inputs for a11y', app.includes("inp.setAttribute('aria-label', label)"));
ok('panel CSS present', css.includes('.prop-edit') && css.includes('.prop-input') && css.includes('.prop-apply'));
ok('edit form lives only in renderProps (draw path untouched)', (() => {
  const i = app.indexOf('function draw()');
  const j = app.indexOf('function renderAll()', i);
  const body = app.slice(i, j);
  return !/pushUndo|markDirty|prop-edit|applyFn/.test(body);
})());
// mutation semantics sanity (pure functions, mirrored logic)
{
  // rect width applies to p2[0]; height to p2[1]
  ok('rect edit mutates p2 not p1', /en\.p2\[0\] = en\.p1\[0\] \+ v/.test(app) && /en\.p2\[1\] = en\.p1\[1\] \+ v/.test(app));
  ok('circle/arc radius sets en.r', (app.match(/en\.r = v;/g) || []).length >= 2);
  ok('dim offset sets en.offset', app.includes('en.offset = v;'));
  ok('text edit sets en.text and en.size', app.includes('en.text = v;') && app.includes('en.size = v;'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
