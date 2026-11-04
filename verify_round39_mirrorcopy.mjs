// Round 39 verification: mirror-copy (keep originals) wiring in WebCAD.
// Static-source analysis following the round-37/33 pattern.
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
let fails = 0;
const check = (name, ok) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + name); if (!ok) fails++; };

// Core function
check('mirrorSelection(mode, keepOriginal) defined', app.includes('function mirrorSelection(mode, keepOriginal)'));
check('keepOriginal duplicates entities with fresh ids', app.includes('const c = JSON.parse(JSON.stringify(e)); c.id = newId(); return c;'));
check('keepOriginal pushes duplicates before mirroring', /keepOriginal[\s\S]{0,400}state\.doc\.entities\.push\(\.\.\.mirrored\)/.test(app));
check('keepOriginal selects only the new copies', /keepOriginal[\s\S]{0,500}state\.sel = new Set\(mirrored\.map\(m => m\.id\)\)/.test(app));
check('applyMirror exists', app.includes('function applyMirror'));
check('locked layer guard before mirroring', app.includes("filter(e => state.sel.has(e.id) && !lockedLayer(e.layer))"));
check('pushUndo before mutation', /function mirrorSelection[\s\S]{0,400}pushUndo\(\)/.test(app));
check('dirty flag + rerender after mirror', /function mirrorSelection[\s\S]{0,1400}state\.dirty = true; markDirty\(\); renderAll\(\)/.test(app));
check('prompt distinguishes copy vs move', app.includes("'Mirror-copied '") && app.includes("'Mirrored '"));

// Keyboard wiring
check('Shift+X triggers mirror-copy', app.includes("mirrorSelection('x', true)"));
check('Shift+Y triggers mirror-copy', app.includes("mirrorSelection('y', true)"));
check('Shift+X handler present', /ev\.shiftKey && ev\.key\.toLowerCase\(\) === 'x'[\s\S]{0,120}mirrorSelection\('x', true\)/.test(app));
check('Shift+Y handler present', /ev\.shiftKey && ev\.key\.toLowerCase\(\) === 'y'[\s\S]{0,120}mirrorSelection\('y', true\)/.test(app));

// Toolbar wiring
check('btnMirrorXCopy wired', app.includes("on('btnMirrorXCopy', () => mirrorSelection('x', true))"));
check('btnMirrorYCopy wired', app.includes("on('btnMirrorYCopy', () => mirrorSelection('y', true))"));
check('plain btnMirrorX stays move-mirror', app.includes("on('btnMirrorX', () => mirrorSelection('x'))"));
check('plain btnMirrorY stays move-mirror', app.includes("on('btnMirrorY', () => mirrorSelection('y'))"));
check('index.html has Mirror+Copy H button', html.includes('btnMirrorXCopy'));
check('index.html has Mirror+Copy V button', html.includes('btnMirrorYCopy'));
check('index.html keeps Mirror H button', html.includes('btnMirrorX'));
check('index.html keeps Mirror V button', html.includes('btnMirrorY'));

// Regression: round 38 break/split still intact
check('break/split intact (round 38)', /function breakGeom/.test(app));
check('zoomExtents intact (round 33)', app.includes('function zoomExtents'));
check('braces balanced', (app.match(/{/g) || []).length === (app.match(/}/g) || []).length);

console.log(fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECKS FAILED');
process.exit(fails === 0 ? 0 : 1);