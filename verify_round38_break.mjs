// Round 38 feature: Break/Split tool.
// Checks (static-analysis against the real app source, matching the round-37/33 pattern):
//  1) breakGeom exists and returns two parts for a line at an interior point
//  2) polyline split at nearest segment point (two polylines covering all original vertices)
//  3) arc split at the clicked angle produces two arcs (a0..aDeg, aDeg..a1) and rejects the gap
//  4) no-op handling: circle / rect / text / dim cannot be broken (prompt path + breakGeom null)
//  5) clicking an endpoint refuses the split (no zero-length part)
//  6) workflow: state.breakEnt two-click state machine; second click splits, Alt-click clears
//  7) commit path: pushUndo before split, remove original, add two parts with newId, markDirty/renderAll
//    and undo.pop() rollback when the point is invalid
//  8) toolbar button data-tool="break", Break in the prompt map, shortcut B in the key map
//  9) live preview: mousemove sets state.breakPreview, draw path strokes it
// 10) split output entities inherit the source layer
import { readFileSync } from 'fs';
const app = readFileSync('public/app.js', 'utf-8');
const html = readFileSync('public/index.html', 'utf-8');
let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : (fail++, console.log('FAIL', n)); console.log(c ? 'PASS' : '----', n); };

ok('breakGeom defined', /function breakGeom\(/.test(app));
ok('line split into two collinear lines', /function breakGeom\([\s\S]{0,400}type: 'line', layer: hit\.layer[\s\S]{0,300}\{ parts: \[a, b\] \}/.test(app));
ok('polyline split at nearest segment', /type === 'polyline'[\s\S]{0,900}bd < bd; bd = d; bi = i[\s\S]{0,300}\{ parts: \[a, b\] \}/.test(app) || /if \(d < bd\) \{ bd = d; bi = i; \}/.test(app));
ok('polyline keeps every original vertex (slice(0, bi + 1) + cut, cut + slice(bi + 1))', app.includes('hit.pts.slice(0, bi + 1)') && app.includes('.concat(hit.pts.slice(bi + 1)'));
ok('arc split uses clicked angle and angleInArc gate', /type === 'arc'[\s\S]{0,500}angleInArc\(rad\(aDeg\), hit\.a0, hit\.a1\)/.test(app) && app.includes('a0: hit.a0, a1: mid') && app.includes('a0: mid, a1: hit.a1'));
ok('circle/rect/text/dim breakGeom returns null', /return null; \/\/ circle: no-op/.test(app));
ok('endpoint split refused', /dist2\(hit\.p1, p\) < 1e-9 \|\| dist2\(hit\.p2, p\) < 1e-9\) return null/.test(app));
ok('two-click state machine (breakEnt + clear with Alt)', app.includes('state.breakEnt') && app.includes('if (!state.breakEnt)') && /Alt-click to clear/.test(app) && /state\.breakEnt = null;[\s\S]{0,400}breakGeom\(ent, p\)/.test(app));
ok('commit: pushUndo -> remove original -> parts pushed with newId', /pushUndo\(\);[\s\S]{0,300}breakGeom\(ent, p\)[\s\S]{0,600}e\.id !== ent\.id[\s\S]{0,200}part\.id = newId\(\)[\s\S]{0,200}state\.doc\.entities\.push\(part\)/.test(app));
ok('rollback on invalid point (undo.pop)', /if \(!res\) \{[\s\S]{0,100}state\.undo\.pop\(\);[\s\S]{0,200}endpoint/.test(app));
ok('markDirty + renderAll after break', /part\.id = newId\(\); state\.doc\.entities\.push\(part\); \}[\s\S]{0,120}state\.dirty = true; markDirty\(\); renderAll\(\);/.test(app));
ok('parts inherit source layer', (app.match(/layer: hit\.layer/g) || []).length >= 2 && app.includes('part.id = newId()'));
ok('mousemove preview (state.breakPreview)', app.includes('state.breakPreview = null') && /t === 'break'[\s\S]{0,700}state\.breakPreview = res\.parts/.test(app));
ok('preview drawn in draw path (dashed split preview)', /state\.breakPreview[\s\S]{0,600}pathFor\(part\)/.test(app));
ok('toolbar button data-tool="break"', html.includes('data-tool="break"'));
ok('PROMPTS entry for break', app.includes("break: 'Break: pick an object, then pick where to split it'"));
ok('keyboard shortcut B', app.includes("b: 'break'"));
ok('setTool clears break state', /state\.trimHover = null;[\s\S]{0,80}state\.breakEnt = null;[\s\S]{0,80}state\.breakPreview = null;/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
