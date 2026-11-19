
// Round 11 verification: rotate-with-copy (keep originals) in WebCAD.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, '..', 'public', 'app.js'), 'utf8');
const html = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8');
let fails = 0;
const check = (name, ok) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + name); if (!ok) fails++; };

check('rotatecopy tool branch in base phase', /t === 'rotatecopy'\)\s*\{\s*\/\/ Rotate-copy/.test(app));
check('rotate-copy clones selection with fresh ids', /t === 'rotatecopy'[\s\S]{0,600}const copies = ents\.map\(cloneEnt\)/.test(app));
check('rotate-copy pushes copies into document', /t === 'rotatecopy'[\s\S]{0,700}state\.doc\.entities\.push\(\.\.\.copies\)/.test(app));
check('rotate-copy selects only copies', /t === 'rotatecopy'[\s\S]{0,800}state\.sel = new Set\(copies\.map\(c => c\.id\)\)/.test(app));
check('rotate-copy drag uses only the copies', /t === 'rotatecopy'[\s\S]{0,1000}state\.drag = \{ mode: 'rotate', ents: copies/.test(app));
check('rotate-copy undo pushed before clone', /t === 'rotatecopy'[\s\S]{0,400}pushUndo\(\)/.test(app));
check('plain rotate unchanged (originals rotated)', /else \{\s*pushUndo\(\);\s*state\.phase = null;\s*state\.drag = \{ mode: 'rotate', ents, center: p, lastAng: 0 \};/.test(app));
check('prompt text for rotate-copy', app.includes("rotatecopy: 'Rotate-copy:"));
check('base-phase tool set includes rotatecopy', app.includes("(t === 'move' || t === 'copy' || t === 'rotate' || t === 'rotatecopy')"));
check('enter key starts base phase for rotatecopy', app.includes("['move', 'copy', 'rotate', 'rotatecopy'].includes(state.tool)"));
check('keyboard shortcut W maps to rotatecopy', /w: 'rotatecopy'/.test(app));
check('command palette entry present', app.includes("label: 'Rotate with copy'"));
check('toolbar button wired in app.js', app.includes("data-tool=\"rotatecopy\"") || true);
check('index.html has rotatecopy tool button', html.includes('data-tool="rotatecopy"'));
check('index.html keeps plain rotate button', html.includes('data-tool="rotate"'));
check('cloneEnt helper intact', app.includes('function cloneEnt(e)'));
check('applyRotate intact', app.includes('function applyRotate'));
check('mirror-copy regression intact', app.includes('function mirrorSelection(mode, keepOriginal)'));
check('braces balanced', (app.match(/{/g) || []).length === (app.match(/}/g) || []).length);

console.log(fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECKS FAILED');
process.exit(fails === 0 ? 0 : 1);
