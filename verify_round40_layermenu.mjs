// Round 40 verification: layer context menu (right-click a layer row).
// Static-source analysis following the round-39 pattern.
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
let fails = 0;
const check = (name, ok) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + name); if (!ok) fails++; };

// Menu infrastructure
check('row.oncontextmenu wired to openLayerMenu', /row\.oncontextmenu = \(ev\) => \{ ev\.preventDefault\(\); ev\.stopPropagation\(\); openLayerMenu\(ev, L\); \}/.test(app));
check('openLayerMenu defined', app.includes('function openLayerMenu(ev, L)'));
check('closeLayerMenu defined', app.includes('function closeLayerMenu()'));
check('layerMenuItem helper defined', app.includes('function layerMenuItem(menu, label, action, danger)'));
check('menu element id layerCtxMenu', app.includes("menu.id = 'layerCtxMenu'"));
check('close on outside mousedown (capture)', app.includes("document.addEventListener('mousedown', closeLayerMenu, true)"));
check('Escape closes menu and stops propagation', app.includes("ev.key === 'Escape'") && /layerMenuEscape[\s\S]{0,200}closeLayerMenu\(\); ev\.stopPropagation\(\)/.test(app));
check('menu positioned clamped to viewport', /menu\.style\.left = Math\.min\(ev\.clientX, vw - r\.width - pad\)/.test(app) && /menu\.style\.top = Math\.min\(ev\.clientY, vh - r\.height - pad\)/.test(app));

// Menu items
check('visibility toggle item with state-aware label', app.includes("(L.visible ? 'Hide' : 'Show') + ' layer '"));
check('lock toggle item with state-aware label', app.includes("(L.locked ? 'Unlock' : 'Lock') + ' layer '"));
check('show all layers item', app.includes("'Show all layers'"));
check('isolate item hides others', app.includes("'Isolate (hide all others)'") && app.includes('x.visible = (x === L)'));
check('set as current item', app.includes("'Set as current'"));
check('rename item calls renameLayer', app.includes("layerMenuItem(menu, 'Rename', () => renameLayer(L))"));
check('delete item hidden for layer 0', app.includes("if (L.name !== '0') layerMenuItem"));
check('delete item marked danger', app.includes("deleteLayer(L), true"));
check('deleteLayer moves entities to layer 0', /for \(const e of state\.doc\.entities\) if \(e\.layer === L\.name\) e\.layer = target/.test(app));
check('deleteLayer refuses to delete the only layer', app.includes("'Cannot delete the only layer'"));
check('deleteLayer confirm mentions moved objects', app.includes("Its ' + count + ' object(s) move to layer '"));
check('deleteLayer fixes currentLayer and selection', /state\.doc\.currentLayer === L\.name\) state\.doc\.currentLayer = target/.test(app));

// Undo / state hygiene
check('pushUndo before visibility toggle', /' layer ' \+ L\.name, \(\) => \{\s*pushUndo\(\); L\.visible = !L\.visible/.test(app));
check('pushUndo before lock toggle', /' layer ' \+ L\.name, \(\) => \{\s*pushUndo\(\); L\.locked = !L\.locked/.test(app));
check('pushUndo before show-all', /'Show all layers', \(\) => \{\s*pushUndo\(\)/.test(app));
check('pushUndo before isolate', /'Isolate \(hide all others\)', \(\) => \{\s*pushUndo\(\)/.test(app));
check('pushUndo before delete', /function deleteLayer\(L\) \{[\s\S]{0,600}pushUndo\(\)/.test(app));
check('pushUndo before rename', /function renameLayer\(L\) \{[\s\S]{0,600}pushUndo\(\)/.test(app));
check('markDirty + renderAll after each mutation', (app.match(/markDirty\(\);/g) || []).length >= 4);

// CSS
check('#layerCtxMenu styled (fixed, z-index)', /#layerCtxMenu\{[\s\S]{0,200}position:fixed/.test(css));
check('.ctx-item hover style', /#layerCtxMenu \.ctx-item:hover\{background/.test(css));
check('.danger item styled', css.includes('.ctx-item.danger'));

// Regressions: prior rounds intact
check('renameLayer still defined (round 36)', app.includes('function renameLayer(L)'));
check('mirrorSelection intact (round 39)', app.includes('function mirrorSelection(mode, keepOriginal)'));
check('zoomExtents intact (round 33)', app.includes('function zoomExtents'));
check('breakGeom intact (round 38)', /function breakGeom/.test(app));
check('braces balanced', (app.match(/{/g) || []).length === (app.match(/}/g) || []).length);
check('parens balanced', (app.match(/\(/g) || []).length === (app.match(/\)/g) || []).length);

console.log(fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECKS FAILED');
process.exit(fails === 0 ? 0 : 1);
