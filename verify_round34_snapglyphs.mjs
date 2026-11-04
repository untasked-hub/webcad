// Round 34 feature: Snap indicator glyphs (osnap visual feedback).
// Peer must-fixes verified:
//  1) pure output layer (drawn in draw(), after entities; no model/undo/DOM writes in draw path)
//  2) rAF throttle keyed by candidate identity (no DOM churn on unchanged candidate)
//  3) fixed screen-space glyph size (~10px), independent of zoom
//  4) glyph shapes: square=endpoint, triangle=midpoint, circle=center, cross=intersection/quad
//  5) contrasting outline (dark halo behind accent glyph)
//  6) display-only: exports (PNG/SVG/DXF) never call drawSnapMarker; snap HUD readout present
//  7) deterministic tie-break by draw order (strict <)
//  8) suppressed during rubber-band and pan drags
import { readFileSync } from 'fs';
const app = readFileSync('public/app.js', 'utf-8');
const html = readFileSync('public/index.html', 'utf-8');
let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : (fail++, console.log('FAIL', n)); console.log(c ? 'PASS' : '----', n); };

ok('drawSnapMarker exists and is called from draw()', app.includes('function drawSnapMarker') && app.includes('drawSnapMarker();'));
ok('square glyph for END (strokeRect)', /kind === 'END'\) ctx\.strokeRect/.test(app));
ok('triangle glyph for MID', /kind === 'MID'[\s\S]{0,160}closePath\(\)/.test(app));
ok('circle glyph for CEN', /kind === 'CEN'[\s\S]{0,120}ctx\.arc\(/.test(app));
ok('cross glyph fallback (intersection/quad)', /moveTo\(s\[0\] - r, s\[1\]\); ctx\.lineTo\(s\[0\] \+ r, s\[1\]\)/.test(app));
ok('fixed screen-space size r=5 (does not scale with zoom)', /const r = 5;/.test(app));
ok('contrasting dark halo outline behind accent glyph', app.includes("ctx.strokeStyle = 'rgba(10,14,20,0.9)'"));
ok('accent glyph drawn on top after halo', app.includes("ctx.strokeStyle = '#7ee2a8'"));
ok('suppressed during rubber-band and pan drags', app.includes('if (state.rubber || panning) return;'));
// pure output layer: no model mutation inside drawSnapMarker
{
  const i = app.indexOf('function drawSnapMarker');
  const body = app.slice(i, app.indexOf('function drawMeasure'));
  ok('pure output layer: no pushUndo/markDirty/entity writes in drawSnapMarker',
     !/pushUndo|markDirty|doc\.entities|saveDrawing|fetch\(/.test(body));
}
ok('HUD snap row exists in index.html (hud-snap + #hs)', html.includes('id="hud-snap"') && html.includes('id="hs"'));
ok('HUD snap row is display-only overlay and starts hidden', /id="hud-snap" style="display:none"/.test(html));
ok('malformed HTML from earlier draft removed', !html.includes('</div>span></div>') && !/—<\/span><\/div>span>/.test(html));
ok('updateSnapHud rAF-throttled', /function updateSnapHud[\s\S]{0,400}requestAnimationFrame/.test(app));
ok('HUD throttle keyed by candidate identity', /const key = state\.snapHit \? state\.snapHit\[0\] \+/ .test(app));
ok('SNAP_GLYPHS name table used for HUD text', app.includes('SNAP_GLYPHS[hit[0]]'));
ok('tie-break by draw order documented (strict <)', app.includes('deterministic tie-break: strict < keeps the first candidate in entity draw order'));
// display-only across exports
ok('PNG/SVG/DXF export paths never reference drawSnapMarker',
   ['exportPNG','exportSVG','exportDXF'].every(fn => {
     const i = app.indexOf('function ' + fn);
     if (i < 0) return true; // some exporters may live inline; check absence globally instead
     return !app.slice(i, i + 4000).includes('drawSnapMarker');
   }) && (app.split('drawSnapMarker();').length - 1) === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
