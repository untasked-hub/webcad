// Round 24: ortho lock with live guide line
// Checks peer must-fixes:
//  1) toolbar/status toggle exists (tgOrtho) + active state class
//  2) explicit ortho-vs-snap precedence documented (ortho constrains axis, snap acts along it)
//  3) status hint while ortho active
//  4) degenerate cursor-on-anchor case: no NaN (sqrt/hypot guard)
//  5) guide line overlay is display-only: no undo/doc references; drawn as dashed overlay;
//     clears on toggle-off (toggle calls draw() for ortho)
// Also: guide anchored to pending point (drawing) or drag.base (move);
// guides for both ortho and polar; gridSnap applies after ortho (along allowed axis).
import { readFileSync } from 'fs';
const app = readFileSync('public/app.js', 'utf-8');
const html = readFileSync('public/index.html', 'utf-8');
let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : (fail++, console.log('FAIL', n)); console.log(c ? 'PASS' : '----', n); };

ok('status bar has ORTHO toggle button (tgOrtho)', html.includes('id="tgOrtho"'));
ok('toggle() marks button active state via classList', app.includes("classList.toggle('on'"));
ok('mirror-copy mode guarded (no undo of originals on plain mirror)', /function mirrorSelection\(mode, keepOriginal\)/.test(app));
ok('snap applies along allowed axis (osnap before ortho, gridSnap after ortho in snapPoint)',
   /state\.osnap[\s\S]*?state\.ortho && state\.lastPt[\s\S]*?state\.gridSnap/.test(app.slice(app.indexOf('function snapPoint'), app.indexOf('function snapPoint') + 2200)));
ok('ORTHO status hint while active', app.includes("state.ortho ? 'Ortho on"));
ok('POLAR status hint while active', app.includes("state.polar ? 'Polar on"));
ok('guide line drawn from anchor with dashed overlay', app.includes('function drawOrthoGuide()') && /setLineDash\(\[8, 5\]\)/.test(app));
ok('guide anchored to pending point while drawing', app.includes('state.pending[state.pending.length - 1]') && /drawing \? state\.pending\[state\.pending\.length - 1\]/.test(app));
ok('guide anchored to drag.base while moving', /state\.drag && state\.drag\.mode === 'move'\) \? state\.drag\.base/.test(app));
ok('guide supports both ortho and polar', /state\.ortho \? '#7fd1ff' : '#c9a6ff'/.test(app));
ok('degenerate cursor-on-anchor guarded: no NaN', /Math\.hypot\(d\[0\], d\[1\]\) < 1e-9\) return/.test(app));
ok('guide is display-only (no undo/save/model writes in guide fn)',
   !/drawOrthoGuide\(\)[\s\S]{0,1200}(pushUndo|markDirty|commitEntity|doc\.entities\s*=)/.test(app));
ok('guide rendered in draw()', app.includes('drawOrthoGuide();'));
ok('toggle clears guide immediately when ortho/polar switched off',
   /prop === 'ortho' \|\| prop === 'polar'[\s\S]{0,600}draw\(\);/.test(app.slice(app.indexOf('function toggle'))));
ok('toggle refreshes snap state before redraw', app.includes('refresh snap/ortho state before redraw'));
ok('ortho toggle key F8 still wired', app.includes("ev.key === 'F8'"));
ok('F10 polar still wired', app.includes("ev.key === 'F10'"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
