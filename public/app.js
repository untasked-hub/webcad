/* WebCAD — browser 2D CAD engine */
(() => {
'use strict';

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const wrap = document.getElementById('canvasWrap');

const state = {
  doc: null,
  drawingId: null,
  tool: 'select',
  view: { x: 360, y: 240, zoom: 1 },
  sel: new Set(),
  pending: [],
  rubber: null,
  lastPt: null,
  ortho: false,
  polar: false,
  gridSnap: false,
  osnap: true,
  showGrid: true,
  gridStep: 20,
  drag: null,
  hover: null,
  snapHit: null,
  undo: [],
  redo: [],
  dirty: false,
  clipboard: null,
  mouseWorld: { x: 0, y: 0 },
  preview: null,
  filletPick: null,
  filletPreview: null,
  trimPick: null,       // boundary entity (trim) or null (extend: all entities as boundaries)
  trimHover: null,      // preview { ent, pt1, pt2 } for trim/extend
  calibPts: [],         // 2 world points picked while calibrating the underlay
};

const TAU = Math.PI * 2;
const rad = (d) => d * Math.PI / 180;
const deg = (r) => r * 180 / Math.PI;

/* ---------- doc model ---------- */
function emptyDoc() {
  return {
    layers: [
      { name: '0', color: '#d9dee7', visible: true, locked: false, lineweight: 1 },
      { name: 'Walls', color: '#7fd1ff', visible: true, locked: false, lineweight: 2 },
      { name: 'Dims', color: '#ffb454', visible: true, locked: false, lineweight: 1 },
      { name: 'Text', color: '#a6e3a1', visible: true, locked: false, lineweight: 1 },
    ],
    entities: [],
    currentLayer: 'Walls',
    underlay: null,
  };
}

function sampleDoc() {
  const doc = emptyDoc();
  const e = doc.entities;
  const add = (o) => { o.id = 'e' + (e.length + 1); e.push(o); };
  add({ type: 'rect', layer: 'Walls', p1: [0, 0], p2: [720, 480] });
  add({ type: 'line', layer: 'Walls', p1: [420, 0], p2: [420, 480] });
  add({ type: 'line', layer: 'Walls', p1: [420, 260], p2: [720, 260] });
  add({ type: 'arc', layer: 'Walls', c: [520, 105], r: 70, a0: 180, a1: 0 });
  add({ type: 'line', layer: 'Walls', p1: [450, 105], p2: [450, 150] });
  add({ type: 'line', layer: 'Walls', p1: [590, 105], p2: [590, 150] });
  add({ type: 'circle', layer: '0', c: [200, 330], r: 46 });
  add({ type: 'text', layer: 'Text', p: [150, 240], text: 'LIVING', size: 34 });
  add({ type: 'text', layer: 'Text', p: [500, 400], text: 'BED', size: 34 });
  add({ type: 'text', layer: 'Text', p: [450, 185], text: 'BATH', size: 24 });
  add({ type: 'dim', layer: 'Dims', p1: [0, 0], p2: [720, 0], offset: -70 });
  add({ type: 'dim', layer: 'Dims', p1: [720, 0], p2: [720, 480], offset: 70 });
  return doc;
}

/* ---------- math ---------- */
function cvW() { return wrap.clientWidth; }
function cvH() { return wrap.clientHeight; }
function w2s(p) {
  return [(p[0] - state.view.x) * state.view.zoom + cvW() / 2,
          cvH() / 2 - (p[1] - state.view.y) * state.view.zoom];
}
function s2w(x, y) {
  return [(x - cvW() / 2) / state.view.zoom + state.view.x,
          state.view.y - (y - cvH() / 2) / state.view.zoom];
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const len = (a) => Math.hypot(a[0], a[1]);
function norm(a) { const l = len(a) || 1; return [a[0] / l, a[1] / l]; }
function rotPt(p, c, ang) {
  const s = Math.sin(ang), co = Math.cos(ang), dx = p[0] - c[0], dy = p[1] - c[1];
  return [c[0] + dx * co - dy * s, c[1] + dx * s + dy * co];
}
function segDist(p, a, b) {
  const v = sub(b, a), w = sub(p, a);
  const L2 = v[0] * v[0] + v[1] * v[1];
  if (L2 < 1e-9) return dist(p, a);
  let t = (w[0] * v[0] + w[1] * v[1]) / L2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, [a[0] + v[0] * t, a[1] + v[1] * t]);
}
function angleInArc(a, a0, a1) {
  a = ((deg(a) % 360) + 360) % 360;
  a0 = ((a0 % 360) + 360) % 360;
  a1 = ((a1 % 360) + 360) % 360;
  if (Math.abs(a1 - a0) < 1e-9) return true;
  if (a1 > a0) return a >= a0 && a <= a1;
  return a >= a0 || a <= a1;
}
function arcPts(e, n) {
  const a0 = e.a0;
  let sweep = e.a1 - e.a0;
  while (sweep <= 0) sweep += 360;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = rad(a0 + sweep * i / n);
    out.push([e.c[0] + Math.cos(a) * e.r, e.c[1] + Math.sin(a) * e.r]);
  }
  return out;
}
function entityPoints(e) {
  switch (e.type) {
    case 'line': return [e.p1, e.p2];
    case 'polyline': return e.pts;
    case 'rect': return [[e.p1[0], e.p1[1]], [e.p2[0], e.p1[1]], e.p2, [e.p1[0], e.p2[1]], e.p1];
    case 'circle': {
      const out = [];
      for (let i = 0; i < 48; i++) {
        const a = TAU * i / 48;
        out.push([e.c[0] + Math.cos(a) * e.r, e.c[1] + Math.sin(a) * e.r]);
      }
      return out;
    }
    case 'arc': return arcPts(e, 36);
    case 'text': {
      const h = e.size, w = e.text.length * h * 0.62;
      return [e.p, [e.p[0] + w, e.p[1]], [e.p[0] + w, e.p[1] + h], [e.p[0], e.p[1] + h]];
    }
    case 'dim': return dimGeom(e).lines.reduce((a, s) => a.concat(s), []);
    default: return [];
  }
}
function dimGeom(e) {
  const d = sub(e.p2, e.p1);
  const L = len(d) || 1;
  const n = [-d[1] / L, d[0] / L];
  const o = e.offset || 0;
  const a = add(e.p1, mul(n, o));
  const b = add(e.p2, mul(n, o));
  const txt = e.text || fmt(L);
  const lines = [[e.p1, add(e.p1, mul(n, o * 1.14))], [e.p2, add(e.p2, mul(n, o * 1.14))], [a, b]];
  return { a, b, n, txt, lines, L };
}
function fmt(v) { return (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, ''); }

function hitEntity(e, p, tol) {
  switch (e.type) {
    case 'line': return segDist(p, e.p1, e.p2) <= tol;
    case 'polyline': {
      for (let i = 0; i < e.pts.length - 1; i++) if (segDist(p, e.pts[i], e.pts[i + 1]) <= tol) return true;
      return false;
    }
    case 'rect': {
      const c = entityPoints(e);
      for (let i = 0; i < 4; i++) if (segDist(p, c[i], c[i + 1]) <= tol) return true;
      return false;
    }
    case 'circle': return Math.abs(dist(p, e.c) - e.r) <= tol;
    case 'arc': {
      if (Math.abs(dist(p, e.c) - e.r) > tol) return false;
      return angleInArc(Math.atan2(p[1] - e.c[1], p[0] - e.c[0]), e.a0, e.a1);
    }
    case 'text': {
      const pts = entityPoints(e);
      const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
      return p[0] >= Math.min(...xs) - tol && p[0] <= Math.max(...xs) + tol &&
             p[1] >= Math.min(...ys) - tol && p[1] <= Math.max(...ys) + tol;
    }
    case 'dim': return dimGeom(e).lines.some((s) => segDist(p, s[0], s[1]) <= tol * 1.6);
    default: return false;
  }
}
function extentsOf(ents) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of ents) for (const p of entityPoints(e)) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  if (!isFinite(x0)) return null;
  return { x0, y0, x1, y1 };
}

/* ---------- layers ---------- */
function layerOf(name) {
  return state.doc.layers.find(l => l.name === name) || state.doc.layers[0];
}
function curLayer() { return layerOf(state.doc.currentLayer); }
function visibleEntities() {
  return state.doc.entities.filter(e => { const L = layerOf(e.layer); return L && L.visible; });
}
function lockedLayer(name) { const L = layerOf(name); return L ? L.locked : false; }

/* ---------- reference image underlay ---------- */
/* The underlay is a doc-level object, not an entity: it is invisible to pickAt,
   snapCandidates, extentsOf and every export loop by construction. It is a
   locked, non-snapping tracing reference. */
const UNDERLAY_MAX_PX = 1600;        // downscale target for the long edge
const UNDERLAY_MAX_SRC_BYTES = 4 * 1024 * 1024;   // refuse bigger source files
const UNDERLAY_MAX_DATA_CHARS = 3.2 * 1024 * 1024; // refuse bigger encoded payload

const underlayImages = new Map();    // src -> HTMLImageElement (decoded)

function ensureUnderlayImage(u) {
  if (!u || !u.src) return null;
  let img = underlayImages.get(u.src);
  if (img) return img.complete && img.naturalWidth ? img : (img.complete ? null : img);
  img = new Image();
  img.onload = () => { draw(); };
  img.onerror = () => { toast('Underlay image failed to decode'); };
  img.src = u.src;
  underlayImages.set(u.src, img);
  return img;
}

function underlayReady(u) {
  const img = ensureUnderlayImage(u);
  return img && img.complete && img.naturalWidth > 0 ? img : null;
}

/* World-space corners (clockwise from top-left). No rotation in this round. */
function underlayCorners(u) {
  if (!u) return [];
  return [[u.x, u.y], [u.x + u.w, u.y], [u.x + u.w, u.y - u.h], [u.x, u.y - u.h]];
}

function underlayBBox(u) {
  if (!u) return null;
  return { x0: u.x, y0: u.y - u.h, x1: u.x + u.w, y1: u.y };
}

function drawUnderlay() {
  const u = state.doc && state.doc.underlay;
  if (!u || !u.visible) return;
  const img = underlayReady(u);
  if (!img) return;
  const tl = w2s([u.x, u.y]);
  const br = w2s([u.x + u.w, u.y - u.h]);
  const x = Math.min(tl[0], br[0]), y = Math.min(tl[1], br[1]);
  const w = Math.abs(br[0] - tl[0]), h = Math.abs(br[1] - tl[1]);
  if (w < 0.5 || h < 0.5) return;
  ctx.save();
  ctx.globalAlpha = Math.max(0.05, Math.min(1, u.opacity == null ? 0.55 : u.opacity));
  try { ctx.drawImage(img, x, y, w, h); } catch (e) { /* ignore */ }
  ctx.restore();
  // calibration picks + dashed frame while the calibrate tool is active
  if (state.tool === 'underlaycal') {
    ctx.save();
    ctx.strokeStyle = '#ffb454';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    const pts = state.calibPts || [];
    for (const q of pts) {
      const sq = w2s(q);
      ctx.beginPath(); ctx.arc(sq[0], sq[1], 4, 0, TAU); ctx.fillStyle = '#ffb454'; ctx.fill();
    }
    if (pts.length === 2) {
      const a = w2s(pts[0]), b = w2s(pts[1]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    ctx.restore();
  }
}

/* Fit a freshly imported image into the current view and place it in the world. */
function placeUnderlay(u, fitFactor) {
  const img = underlayReady(u);
  if (!img) return u;
  const iw = img.naturalWidth || 1, ih = img.naturalHeight || 1;
  const viewW = cvW() / state.view.zoom, viewH = cvH() / state.view.zoom;
  const k = (fitFactor || 0.7);
  const scale = Math.min((viewW * k) / iw, (viewH * k) / ih);
  u.w = iw * scale;
  u.h = ih * scale;
  u.x = state.view.x - u.w / 2;
  u.y = state.view.y + u.h / 2;
  return u;
}

/* Downscale in the browser, then keep only the encoded data URL in the document. */
function readUnderlayFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) { reject(new Error('No file')); return; }
    if (file.size > UNDERLAY_MAX_SRC_BYTES) {
      reject(new Error('Image is larger than 4 MB — use a smaller reference')); return;
    }
    if (!/^image\//.test(file.type || '')) { reject(new Error('That is not an image file')); return; }
    const rd = new FileReader();
    rd.onerror = () => reject(new Error('Could not read the file'));
    rd.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not decode the image'));
      img.onload = () => {
        const iw = img.naturalWidth, ih = img.naturalHeight;
        if (!iw || !ih) { reject(new Error('Image has no size')); return; }
        const long = Math.max(iw, ih);
        const scale = long > UNDERLAY_MAX_PX ? UNDERLAY_MAX_PX / long : 1;
        const W = Math.max(1, Math.round(iw * scale)), H = Math.max(1, Math.round(ih * scale));
        const c2 = document.createElement('canvas');
        c2.width = W; c2.height = H;
        const g = c2.getContext('2d');
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);   // JPEG has no alpha
        g.drawImage(img, 0, 0, W, H);
        let data;
        try { data = c2.toDataURL('image/jpeg', 0.82); } catch (e) { reject(new Error('Could not encode the image')); return; }
        if (data.length > UNDERLAY_MAX_DATA_CHARS) {
          reject(new Error('Reference is still too large after downscaling — try a smaller image')); return;
        }
        resolve({ src: data, iw: W, ih: H, name: file.name || 'reference.jpg' });
      };
      img.src = String(rd.result);
    };
    rd.readAsDataURL(file);
  });
}

function setUnderlay(src, name, iw, ih) {
  pushUndo();
  const u = { src, name: name || 'reference.jpg', x: 0, y: 0, w: 100, h: 100,
              opacity: 0.55, visible: true, iw: iw || 0, ih: ih || 0 };
  state.doc.underlay = u;
  // decode before fitting so natural size is known
  const img = ensureUnderlayImage(u);
  if (img && img.complete && img.naturalWidth) placeUnderlay(u);
  else if (img) img.addEventListener('load', () => { placeUnderlay(u); draw(); renderUnderlayPanel(); }, { once: true });
  if (iw && ih) placeUnderlay(u);
  state.dirty = true; markDirty();
  renderUnderlayPanel();
  draw();
  return u;
}

function clearUnderlay() {
  if (!state.doc.underlay) { toast('No reference image'); return; }
  pushUndo();
  state.doc.underlay = null;
  state.calibPts = [];
  if (state.tool === 'underlaycal') setTool('select');
  state.dirty = true; markDirty();
  renderUnderlayPanel();
  draw();
  toast('Reference image removed');
}

/* Uniform scale about the first picked point so the measured span matches reality. */
function calibrateUnderlay(realDist) {
  const u = state.doc.underlay;
  const pts = state.calibPts || [];
  if (!u || pts.length !== 2) return null;
  const measured = dist(pts[0], pts[1]);
  if (!(measured > 1e-6)) return { ok: false, reason: 'The two points are the same — pick two distinct points.' };
  if (!(realDist > 0)) return { ok: false, reason: 'Enter a positive real-world distance.' };
  const k = realDist / measured;
  const [ax, ay] = pts[0];
  pushUndo();
  u.x = ax + (u.x - ax) * k;
  u.y = ay + (u.y - ay) * k;
  u.w *= k;
  u.h *= k;
  u.scale = (u.scale || 1) * k;
  u.calibrated = realDist;
  state.dirty = true; markDirty();
  renderUnderlayPanel();
  draw();
  return { ok: true, k, measured, realDist };
}

/* ---------- snapping ---------- */
function snapCandidates() {
  const out = [];
  const dragEnts = (state.drag && state.drag.mode === 'move' && state.drag.ents) ? state.drag.ents : null;
  for (const e of visibleEntities()) {
    if (dragEnts && dragEnts.includes(e)) continue; // never snap to the entities being dragged
    if (e.type === 'line') out.push(['END', e.p1], ['END', e.p2], ['MID', mid(e.p1, e.p2)]);
    else if (e.type === 'polyline') e.pts.forEach(p => out.push(['END', p]));
    else if (e.type === 'rect') {
      const ps = [[e.p1[0], e.p1[1]], [e.p2[0], e.p1[1]], e.p2, [e.p1[0], e.p2[1]]];
      ps.forEach(p => out.push(['END', p]));
      for (let i = 0; i < 4; i++) out.push(['MID', mid(ps[i], ps[(i + 1) % 4])]);
    } else if (e.type === 'circle') {
      out.push(['CEN', e.c]);
      out.push(['QUAD', [e.c[0] + e.r, e.c[1]]], ['QUAD', [e.c[0] - e.r, e.c[1]]],
               ['QUAD', [e.c[0], e.c[1] + e.r]], ['QUAD', [e.c[0], e.c[1] - e.r]]);
    } else if (e.type === 'arc') {
      out.push(['CEN', e.c]);
      const ps = arcPts(e, 36);
      out.push(['END', ps[0]], ['END', ps[ps.length - 1]]);
    } else if (e.type === 'text') out.push(['END', e.p]);
  }
  return out;
}

function snapPoint(world) {
  let p = world.slice();
  state.snapHit = null;
  let best = null;
  if (state.osnap) {
    const tol = 13 / state.view.zoom;
    let bd = tol;
    // deterministic tie-break: strict < keeps the first candidate in entity draw order
    for (const [kind, cp] of snapCandidates()) {
      const d = dist(cp, world);
      if (d < bd) { bd = d; best = [kind, cp]; }
    }
  }
  if (state.ortho && state.lastPt) {
    // Ortho defines the allowed axis first. Object/grid snapping may adjust
    // position along that axis only, preserving the anchor's perpendicular coordinate.
    const d = sub(p, state.lastPt);
    const horizontal = Math.abs(d[0]) >= Math.abs(d[1]);
    const axisValue = best ? best[1][horizontal ? 0 : 1] : p[horizontal ? 0 : 1];
    p = horizontal ? [axisValue, state.lastPt[1]] : [state.lastPt[0], axisValue];
    if (best) state.snapHit = best;
    if (state.gridSnap) {
      const g = state.gridStep;
      if (horizontal) p[0] = Math.round(p[0] / g) * g;
      else p[1] = Math.round(p[1] / g) * g;
    }
    return p;
  }
  if (best) { state.snapHit = best; return best[1].slice(); }
  if (state.polar && state.lastPt) {
    const d = sub(p, state.lastPt);
    const step = 45 * Math.PI / 180;
    const a = Math.round(Math.atan2(d[1], d[0]) / step) * step;
    p = [state.lastPt[0] + len(d) * Math.cos(a), state.lastPt[1] + len(d) * Math.sin(a)];
  }
  if (state.gridSnap) {
    const g = state.gridStep;
    p = [Math.round(p[0] / g) * g, Math.round(p[1] / g) * g];
  }
  return p;
}

/* ---------- undo ---------- */
function snapshot() {
  return JSON.stringify({ entities: state.doc.entities, layers: state.doc.layers,
    currentLayer: state.doc.currentLayer, underlay: state.doc.underlay || null });
}
function pushUndo() {
  state.undo.push(snapshot());
  if (state.undo.length > 120) state.undo.shift();
  state.redo.length = 0;
}
function restore(json) {
  const d = JSON.parse(json);
  state.doc.entities = d.entities;
  state.doc.layers = d.layers;
  state.doc.currentLayer = d.currentLayer;
  state.doc.underlay = d.underlay || null;
  if (state.doc.underlay) ensureUnderlayImage(state.doc.underlay);
  const ids = new Set(state.doc.entities.map(e => e.id));
  state.sel = new Set([...state.sel].filter(id => ids.has(id)));
  state.dirty = true;
  renderAll();
}
function undo() {
  if (!state.undo.length) return toast('Nothing to undo');
  state.redo.push(snapshot());
  restore(state.undo.pop());
  setPrompt('Undo');
}
function redo() {
  if (!state.redo.length) return toast('Nothing to redo');
  state.undo.push(snapshot());
  restore(state.redo.pop());
  setPrompt('Redo');
}

/* ---------- render ---------- */
function resize() {
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(cvW() * dpr));
  cv.height = Math.max(1, Math.round(cvH() * dpr));
  cv.style.width = cvW() + 'px';
  cv.style.height = cvH() + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function drawGrid() {
  if (!state.showGrid) return;
  const z = state.view.zoom;
  let step = state.gridStep;
  while (step * z < 14) step *= 5;
  while (step * z > 160) step /= 5;

  const tl = s2w(0, 0), br = s2w(cvW(), cvH());
  const x0 = Math.floor(tl[0] / step) * step;
  const x1 = br[0];
  const y0 = Math.floor(br[1] / step) * step;
  const y1 = tl[1];

  ctx.save();
  ctx.lineWidth = 1;
  for (let x = x0; x <= x1; x += step) {
    const sx = Math.round(w2s([x, 0])[0]) + 0.5;
    const major = Math.abs((x / (step * 5)) % 1) < 1e-6;
    ctx.strokeStyle = major ? '#1a2432' : '#131b26';
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, cvH()); ctx.stroke();
  }
  for (let y = y0; y <= y1; y += step) {
    const sy = Math.round(w2s([0, y])[1]) + 0.5;
    const major = Math.abs((y / (step * 5)) % 1) < 1e-6;
    ctx.strokeStyle = major ? '#1a2432' : '#131b26';
    ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(cvW(), sy); ctx.stroke();
  }
  // axes
  const o = w2s([0, 0]);
  ctx.strokeStyle = '#22303f';
  ctx.beginPath(); ctx.moveTo(0, o[1]); ctx.lineTo(cvW(), o[1]); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(o[0], 0); ctx.lineTo(o[0], cvH()); ctx.stroke();
  ctx.restore();
}

function pathFor(e) {
  ctx.beginPath();
  const P = (p) => { const s = w2s(p); return s; };
  switch (e.type) {
    case 'line': {
      const a = P(e.p1), b = P(e.p2);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      break;
    }
    case 'polyline': {
      const a = P(e.pts[0]);
      ctx.moveTo(a[0], a[1]);
      for (let i = 1; i < e.pts.length; i++) { const b = P(e.pts[i]); ctx.lineTo(b[0], b[1]); }
      break;
    }
    case 'rect': {
      const a = P(e.p1), b = P(e.p2);
      ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      break;
    }
    case 'circle': {
      const c = P(e.c);
      ctx.arc(c[0], c[1], Math.max(0.4, e.r * state.view.zoom), 0, TAU);
      break;
    }
    case 'arc': {
      const c = P(e.c);
      let a0 = e.a0, a1 = e.a1;
      let sweep = a1 - a0;
      while (sweep <= 0) sweep += 360;
      if (sweep > 360) sweep = 360;
      ctx.arc(c[0], c[1], Math.max(0.4, e.r * state.view.zoom), -rad(a0), -rad(a0 + sweep), true);
      break;
    }
    default: break;
  }
}

function drawEntity(e, override) {
  const L = layerOf(e.layer);
  if (!L) return;
  if (!override && !L.visible) return;
  const col = override || L.color;
  const z = state.view.zoom;
  ctx.save();
  ctx.lineWidth = Math.max(0.9, (L.lineweight || 1) * 1.1);
  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  if (e.type === 'text') {
    const s = w2s(e.p);
    const size = Math.max(6, e.size * z);
    ctx.font = '600 ' + size + 'px Inter, system-ui, sans-serif';
    ctx.fillText(e.text, s[0], s[1] + size * 0.16);
  } else if (e.type === 'dim') {
    const g = dimGeom(e);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [a, b] of g.lines) {
      const pa = w2s(a), pb = w2s(b);
      ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]);
    }
    ctx.stroke();
    // arrow heads
    const d = norm(sub(g.b, g.a));
    const ah = 7;
    for (const [pt, dir] of [[g.a, d], [g.b, mul(d, -1)]]) {
      const s = w2s(pt);
      const nx = -dir[1], ny = dir[0];
      ctx.beginPath();
      ctx.moveTo(s[0], s[1]);
      ctx.lineTo(s[0] + dir[0] * ah + nx * ah * 0.36, s[1] - dir[1] * ah + ny * ah * 0.36);
      ctx.lineTo(s[0] + dir[0] * ah - nx * ah * 0.36, s[1] - dir[1] * ah - ny * ah * 0.36);
      ctx.closePath(); ctx.fill();
    }
    const c = w2s(mid(g.a, g.b));
    const fs = Math.max(8, 11);
    ctx.font = '600 ' + fs + 'px JetBrains Mono, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const tw = ctx.measureText(g.txt).width;
    ctx.fillStyle = '#0b1017';
    ctx.fillRect(c[0] - tw / 2 - 3, c[1] - fs / 2 - 2, tw + 6, fs + 4);
    ctx.fillStyle = col;
    ctx.fillText(g.txt, c[0], c[1]);
  } else {
    pathFor(e);
    ctx.stroke();
    if (e.type === 'circle' || e.type === 'rect') {
      // keep fills empty
    }
  }
  ctx.restore();
}

function drawSelection(ents) {
  const z = state.view.zoom;
  ctx.save();
  ctx.strokeStyle = '#ffb454';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  for (const e of ents) {
    const pts = entityPoints(e);
    if (!pts.length) continue;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const a = w2s([Math.min(...xs), Math.min(...ys)]);
    const b = w2s([Math.max(...xs), Math.max(...ys)]);
    ctx.strokeRect(a[0] - 3, a[1] - 3, b[0] - a[0] + 6, b[1] - a[1] + 6);
    for (const p of entityPoints(e)) {
      const s = w2s(p);
      ctx.fillStyle = '#ffb454';
      ctx.fillRect(s[0] - 2, s[1] - 2, 4, 4);
    }
  }
  ctx.restore();
}

function drawVertexHandles() {
  const ent = state.vertexEnt && state.doc.entities.find(e => e.id === state.vertexEnt && e.type === 'polyline');
  if (!ent) return;
  ctx.save();
  // midpoints: circles (insert)
  for (let i = 0; i < ent.pts.length - 1; i++) {
    const m = w2s(mid(ent.pts[i], ent.pts[i + 1]));
    ctx.strokeStyle = '#7fd1ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(m[0], m[1], 4.5, 0, Math.PI * 2);
    ctx.stroke();
  }
  // vertices: squares (move)
  for (let i = 0; i < ent.pts.length; i++) {
    const s = w2s(ent.pts[i]);
    if (i === state.vertexIdx) { ctx.fillStyle = '#ffb454'; ctx.fillRect(s[0] - 5, s[1] - 5, 10, 10); }
    else { ctx.fillStyle = '#e8eef7'; ctx.fillRect(s[0] - 4, s[1] - 4, 8, 8); }
  }
  ctx.restore();
}

function drawOrthoGuide() {
  // Live guide line while ortho/polar constrains the cursor. Overlay only:
  // drawn straight onto the canvas, never a document entity, never in undo.
  // Reads the already-computed mouse state; no snapPoint() call here.
  if (!state.doc) return;
  if (!state.ortho && !state.polar) return;
  const t = state.tool;
  const drawing = ['line', 'polyline', 'rect', 'circle', 'arc', 'dim', 'measure'].includes(t) &&
                  state.pending.length >= 1;
  const anchor = drawing ? state.pending[state.pending.length - 1]
              : (state.drag && state.drag.mode === 'move') ? state.drag.base
              : null;
  if (!anchor) return;
  const p = state.snapPoint ? snapPoint(state.mouseWorld || anchor) : (state.mouseWorld || anchor);
  const d = sub(p, anchor);
  if (Math.hypot(d[0], d[1]) < 1e-9) return; // degenerate: cursor on anchor
  const a = w2s(anchor);
  ctx.save();
  ctx.strokeStyle = state.ortho ? '#7fd1ff' : '#c9a6ff';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([8, 5]);
  // extend the guide beyond the cursor a little for readability
  const ext = 40 / state.view.zoom;
  const L = Math.hypot(d[0], d[1]);
  const end = [p[0] + d[0] / L * ext, p[1] + d[1] / L * ext];
  const c = w2s(end);
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(c[0], c[1]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(a[0], a[1], 3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

const SNAP_GLYPHS = { END: 'Endpoint', MID: 'Midpoint', CEN: 'Center', QUAD: 'Quadrant' };
let snapHudPending = null, snapHudRaf = 0, snapHudKey = '';
// candidate identity key: skip DOM writes when the candidate (kind + world point) is unchanged
function updateSnapHud() {
  // rAF-throttled DOM readout, display-only overlay: name of the active snap candidate.
  const key = state.snapHit ? state.snapHit[0] + ':' + state.snapHit[1][0] + ',' + state.snapHit[1][1] : '';
  if (key === snapHudKey && !snapHudRaf) return; // unchanged candidate — no DOM churn
  snapHudKey = key;
  snapHudPending = state.snapHit;
  if (snapHudRaf) return;
  snapHudRaf = requestAnimationFrame(() => {
    snapHudRaf = 0;
    const hit = snapHudPending; snapHudPending = null;
    const row = document.getElementById('hud-snap');
    if (!row) return;
    if (!hit) { row.style.display = 'none'; return; }
    document.getElementById('hs').textContent = SNAP_GLYPHS[hit[0]] || hit[0];
    row.style.display = 'flex';
  });
}

/* Snap indicator glyph: pure output layer. Never intercepts input (the canvas is
   the sole event target), never enters pick/persist paths, and every exporter
   builds from state.doc.entities only, so glyphs are display-only by construction.
   Tie-break: snapPoint uses strict < over draw-ordered candidates, so repeated
   calls with the same cursor resolve identically. */
function drawSnapMarker() {
  updateSnapHud();
  if (!state.snapHit) return;
  if (state.rubber || panning) return; // suppress during rubber-band and pan drags
  const [kind, p] = state.snapHit;
  const s = w2s(p);
  // fixed screen-space size, does not scale with zoom
  const r = 5;
  ctx.save();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = 'rgba(10,14,20,0.9)'; // 1px effective contrasting halo on any theme
  const trace = () => {
    if (kind === 'END') ctx.strokeRect(s[0] - r, s[1] - r, r * 2, r * 2);
    else if (kind === 'MID') {
      ctx.beginPath(); ctx.moveTo(s[0], s[1] - r); ctx.lineTo(s[0] + r, s[1] + r); ctx.lineTo(s[0] - r, s[1] + r); ctx.closePath(); ctx.stroke();
    } else if (kind === 'CEN') {
      ctx.beginPath(); ctx.arc(s[0], s[1], r, 0, TAU); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(s[0] - r, s[1]); ctx.lineTo(s[0] + r, s[1]);
      ctx.moveTo(s[0], s[1] - r); ctx.lineTo(s[0], s[1] + r); ctx.stroke();
    }
  };
  trace(); // dark outline
  ctx.strokeStyle = '#7ee2a8';
  ctx.lineWidth = 1.25;
  trace(); // accent glyph on top
  ctx.restore();
}

function drawMeasure() {
  let a = null, b = null;
  if (state.tool === 'measure' && state.preview) { a = state.preview.p1; b = state.preview.p2; }
  else if (state.measureResult) { a = state.measureResult.a; b = state.measureResult.b; }
  if (!a || !b) return;
  const s1 = w2s(a), s2 = w2s(b);
  ctx.save();
  ctx.strokeStyle = '#7fffd0';
  ctx.fillStyle = '#7fffd0';
  ctx.lineWidth = 1.3;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(s1[0], s1[1]);
  ctx.lineTo(s2[0], s2[1]);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const q of [s1, s2]) {
    ctx.beginPath();
    ctx.arc(q[0], q[1], 3, 0, Math.PI * 2);
    ctx.fill();
  }
  const label = fmt(dist(a, b));
  ctx.font = '600 12px Inter, system-ui, sans-serif';
  const tw = ctx.measureText(label).width;
  const mx = (s1[0] + s2[0]) / 2, my = (s1[1] + s2[1]) / 2;
  ctx.fillStyle = 'rgba(11,16,23,.85)';
  ctx.fillRect(mx - tw / 2 - 5, my - 18, tw + 10, 16);
  ctx.fillStyle = '#7fffd0';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, mx, my - 10);
  ctx.restore();
}

function drawPreview() {
  if (state.breakPreview) {
    ctx.save(); ctx.strokeStyle = '#7fffd0'; ctx.lineWidth = 1.6;
    ctx.setLineDash([5, 3]);
    const bp = state.breakPreview;
    if (Array.isArray(bp[0])) { // polyline split preview
      ctx.beginPath(); ctx.moveTo(w2s(bp[0])); for (let i = 1; i < bp.length; i++) ctx.lineTo(w2s(bp[i])); ctx.stroke();
    } else {
      for (const part of bp) { pathFor(part); ctx.stroke(); }
    }
    ctx.restore();
  }
  if (state.trimPick) {
    const be = state.doc.entities.find(e => e.id === state.trimPick.id);
    if (be) {
      ctx.save(); ctx.strokeStyle = '#7fb2ff'; ctx.lineWidth = 2.2; ctx.setLineDash([3, 3]);
      pathFor(be); ctx.stroke(); ctx.restore();
    }
  }
  if (state.trimHover) {
    const he = state.doc.entities.find(e => e.id === state.trimHover.entId);
    if (he) {
      ctx.save(); ctx.strokeStyle = '#7fffd0'; ctx.lineWidth = 2.6; ctx.setLineDash([6, 3]);
      pathFor(he); ctx.stroke();
      const mark = state.trimHover.cut || state.trimHover.newEnd;
      if (mark) {
        const s = w2s(mark);
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(s[0], s[1], 4, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }
  }
  if (state.filletPreview) {
    const fpv = state.filletPreview;
    ctx.save(); ctx.strokeStyle = '#ffb454'; ctx.lineWidth = 1.4; ctx.setLineDash([5, 4]);
    pathFor(fpv); ctx.stroke(); ctx.restore();
  }
  const pv = state.preview;
  if (!pv) return;
  ctx.save();
  ctx.strokeStyle = '#ffb454';
  ctx.lineWidth = 1.4;
  ctx.setLineDash([5, 4]);
  pathFor(pv);
  ctx.stroke();
  ctx.restore();
}

function draw() {
  ctx.clearRect(0, 0, cvW(), cvH());
  ctx.fillStyle = '#0b1017';
  ctx.fillRect(0, 0, cvW(), cvH());
  drawGrid();
  if (state.doc) {
    drawUnderlay();
    for (const e of state.doc.entities) drawEntity(e);
    drawPreview();
    const selEnts = state.doc.entities.filter(e => state.sel.has(e.id));
    if (selEnts.length) drawSelection(selEnts);
    if (state.tool === 'vertex') drawVertexHandles();
  }
  drawOrthoGuide();
  drawMeasure();
  if (state.rubber) {
    const { x0, y0, x1, y1 } = state.rubber;
    ctx.save();
    ctx.strokeStyle = '#7fd1ff';
    ctx.fillStyle = 'rgba(127,209,255,.08)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    const a = [Math.min(x0, x1), Math.min(y0, y1)];
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    ctx.strokeRect(a[0], a[1], w, h);
    ctx.fillRect(a[0], a[1], w, h);
    ctx.restore();
  }
  drawSnapMarker();
}

function renderAll() {
  draw();
  renderLayers();
  renderUnderlayPanel();
  renderProps();
  renderSelInfo();
  const n = state.doc ? state.doc.entities.length : 0;
  document.getElementById('countInfo').textContent = n + ' entities';
}

/* ---------- side panels ---------- */
function renderUnderlayPanel() {
  const box = document.getElementById('underlayBody');
  if (!box) return;
  const u = state.doc && state.doc.underlay;
  if (!u) {
    box.innerHTML =
      '<div class="empty">No reference image — import a PNG/JPEG floor plan or scan to trace over</div>' +
      '<div class="btn-row"><button class="mini wide" id="btnUnderlayImport">Import image…</button></div>';
    const b = document.getElementById('btnUnderlayImport');
    if (b) b.onclick = () => triggerUnderlayFile();
    return;
  }
  const opPct = Math.round((u.opacity == null ? 0.55 : u.opacity) * 100);
  const wSpan = fmt(u.w || 0) + ' × ' + fmt(u.h || 0);
  box.innerHTML =
    '<div class="underlay-meta">' +
      '<div class="underlay-name" title="' + esc(u.name || 'reference') + '">' + esc(u.name || 'reference') + '</div>' +
      '<div class="underlay-sub">' + wSpan + ' units · locked (no snap)</div>' +
    '</div>' +
    '<label class="underlay-row">Opacity <span id="underlayOpVal">' + opPct + '%</span>' +
      '<input id="underlayOpacity" type="range" min="10" max="100" step="5" value="' + opPct + '">' +
    '</label>' +
    '<div class="btn-row">' +
      '<button class="mini" id="btnUnderlayCal" title="Pick two points on the image and enter the real-world distance">2-pt calibrate</button>' +
      '<button class="mini" id="btnUnderlayToggle" title="Show or hide the reference image">' + (u.visible ? 'Hide' : 'Show') + '</button>' +
      '<button class="mini" id="btnUnderlayReplace" title="Replace the reference image">Replace…</button>' +
      '<button class="mini" id="btnUnderlayRemove" title="Remove the reference image">Remove</button>' +
    '</div>';
  const sl = document.getElementById('underlayOpacity');
  if (sl) {
    sl.oninput = () => {
      u.opacity = Math.max(0.1, Math.min(1, Number(sl.value) / 100));
      const v = document.getElementById('underlayOpVal');
      if (v) v.textContent = Math.round(u.opacity * 100) + '%';
      draw();
    };
    sl.onchange = () => { state.dirty = true; markDirty(); };
  }
  const cal = document.getElementById('btnUnderlayCal');
  if (cal) cal.onclick = () => startUnderlayCalibrate();
  const tog = document.getElementById('btnUnderlayToggle');
  if (tog) tog.onclick = () => { u.visible = !u.visible; state.dirty = true; markDirty(); renderUnderlayPanel(); draw(); };
  const rep = document.getElementById('btnUnderlayReplace');
  if (rep) rep.onclick = () => triggerUnderlayFile();
  const rem = document.getElementById('btnUnderlayRemove');
  if (rem) rem.onclick = () => clearUnderlay();
}

function triggerUnderlayFile() {
  const inp = document.getElementById('fileUnderlay');
  if (inp) inp.click();
}

function startUnderlayCalibrate() {
  if (!state.doc || !state.doc.underlay) { toast('Import a reference image first'); return; }
  state.doc.underlay.visible = true;
  state.calibPts = [];
  setTool('underlaycal');
}

function openCalibrateModal(measured) {
  const m = document.getElementById('calModal');
  if (!m) return;
  const info = document.getElementById('calMeasured');
  if (info) info.textContent = fmt(measured) + ' drawing units between picked points';
  const inp = document.getElementById('calDist');
  if (inp) { inp.value = fmt(measured); setTimeout(() => { inp.focus(); inp.select(); }, 30); }
  const err = document.getElementById('calErr');
  if (err) err.textContent = '';
  m.classList.add('show');
}

function closeCalibrateModal() {
  const m = document.getElementById('calModal');
  if (m) m.classList.remove('show');
}

function wireCalibrateModal() {
  const m = document.getElementById('calModal');
  const ok = document.getElementById('calOk');
  const cancel = document.getElementById('calCancel');
  const close = document.getElementById('calClose');
  const inp = document.getElementById('calDist');
  if (ok) ok.onclick = () => submitCalibrateModal();
  const bail = () => { closeCalibrateModal(); state.calibPts = []; if (state.tool === 'underlaycal') setTool('select'); draw(); };
  if (cancel) cancel.onclick = bail;
  if (close) close.onclick = bail;
  if (m) m.onclick = (ev) => { if (ev.target === m) bail(); };
  if (inp) {
    inp.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); submitCalibrateModal(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); bail(); }
    });
  }
}

/* Move/resize the underlay by dragging with the calibrate tool held down? No: the
   underlay is locked. Position and size only change through import and calibration. */
function submitCalibrateModal() {
  const inp = document.getElementById('calDist');
  const err = document.getElementById('calErr');
  const v = inp ? Number(String(inp.value).trim()) : NaN;
  const r = calibrateUnderlay(v);
  if (!r || !r.ok) {
    if (err) err.textContent = (r && r.reason) || 'Enter a positive distance.';
    return;
  }
  closeCalibrateModal();
  setTool('select');
  toast('Reference scaled ×' + fmt(r.k) + ' (' + fmt(r.measured) + ' → ' + fmt(r.realDist) + ')');
}

function renderLayers() {
  const box = document.getElementById('layerList');
  box.innerHTML = '';
  for (const L of state.doc.layers) {
    const row = document.createElement('div');
    row.className = 'layer' + (L.name === state.doc.currentLayer ? ' cur' : '');
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = L.name;
    nm.title = 'Double-click to rename layer';
    nm.ondblclick = (ev) => { ev.stopPropagation(); renameLayer(L); };
    const eye = document.createElement('span');
    eye.className = 'ic' + (L.visible ? '' : ' off');
    eye.textContent = L.visible ? '◉' : '◌';
    eye.title = 'Toggle visibility';
    eye.onclick = (ev) => { ev.stopPropagation(); L.visible = !L.visible; renderAll(); markDirty(); };
    const lock = document.createElement('span');
    lock.className = 'ic' + (L.locked ? '' : ' off');
    lock.textContent = L.locked ? '🔒' : '🔓';
    lock.title = 'Toggle lock';
    lock.onclick = (ev) => { ev.stopPropagation(); L.locked = !L.locked; renderAll(); markDirty(); };
    const col = document.createElement('span');
    col.className = 'ic';
    col.textContent = '▮';
    col.title = 'Change colour';
    col.onclick = (ev) => {
      ev.stopPropagation();
      const i = LAYER_COLORS.indexOf(L.color);
      L.color = LAYER_COLORS[(i + 1) % LAYER_COLORS.length];
      renderAll(); markDirty();
    };
    row.append(nm, eye, lock, col);
    row.onclick = () => { state.doc.currentLayer = L.name; renderLayers(); setPrompt('Current layer: ' + L.name); };
    row.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); openLayerMenu(ev, L); };
    box.appendChild(row);
  }
}

/* ---------- layer context menu ---------- */
function closeLayerMenu() {
  const m = document.getElementById('layerCtxMenu');
  if (m) m.remove();
  document.removeEventListener('mousedown', closeLayerMenu, true);
  document.removeEventListener('keydown', layerMenuEscape, true);
}
function layerMenuEscape(ev) { if (ev.key === 'Escape') { closeLayerMenu(); ev.stopPropagation(); } }
function layerMenuItem(menu, label, action, danger) {
  const b = document.createElement('div');
  b.className = 'ctx-item' + (danger ? ' danger' : '');
  b.textContent = label;
  b.onclick = (ev) => { ev.stopPropagation(); closeLayerMenu(); action(); };
  menu.appendChild(b);
}
function openLayerMenu(ev, L) {
  closeLayerMenu();
  const menu = document.createElement('div');
  menu.id = 'layerCtxMenu';
  layerMenuItem(menu, (L.visible ? 'Hide' : 'Show') + ' layer ' + L.name, () => {
    pushUndo(); L.visible = !L.visible; state.dirty = true; markDirty();
    renderAll(); setPrompt(L.name + (L.visible ? ' visible' : ' hidden'));
  });
  layerMenuItem(menu, (L.locked ? 'Unlock' : 'Lock') + ' layer ' + L.name, () => {
    pushUndo(); L.locked = !L.locked; state.dirty = true; markDirty();
    renderAll(); setPrompt(L.name + (L.locked ? ' locked' : ' unlocked'));
  });
  layerMenuItem(menu, 'Show all layers', () => {
    pushUndo(); for (const x of state.doc.layers) x.visible = true;
    state.dirty = true; markDirty(); renderAll(); setPrompt('All layers visible');
  });
  layerMenuItem(menu, 'Isolate (hide all others)', () => {
    pushUndo(); for (const x of state.doc.layers) x.visible = (x === L);
    state.dirty = true; markDirty(); renderAll(); setPrompt('Isolated layer ' + L.name);
  });
  layerMenuItem(menu, 'Set as current', () => {
    state.doc.currentLayer = L.name; renderAll(); setPrompt('Current layer: ' + L.name);
  });
  layerMenuItem(menu, 'Rename', () => renameLayer(L));
  if (L.name !== '0') layerMenuItem(menu, 'Delete layer (move objects to 0)', () => deleteLayer(L), true);
  document.body.appendChild(menu);
  const pad = 4, vw = window.innerWidth, vh = window.innerHeight;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(ev.clientX, vw - r.width - pad) + 'px';
  menu.style.top = Math.min(ev.clientY, vh - r.height - pad) + 'px';
  setTimeout(() => document.addEventListener('mousedown', closeLayerMenu, true), 0);
  document.addEventListener('keydown', layerMenuEscape, true);
}
function deleteLayer(L) {
  const target = '0';
  const count = state.doc.entities.filter(e => e.layer === L.name).length;
  const nOthers = state.doc.layers.length - 1;
  if (!nOthers) { toast('Cannot delete the only layer'); return; }
  if (!window.confirm('Delete layer "' + L.name + '"?' +
    (count ? ' Its ' + count + ' object(s) move to layer ' + target + '.' : ''))) return;
  pushUndo();
  for (const e of state.doc.entities) if (e.layer === L.name) e.layer = target;
  state.doc.layers = state.doc.layers.filter(x => x !== L);
  if (state.doc.currentLayer === L.name) state.doc.currentLayer = target;
  for (const id of Array.from(state.sel)) {
    const e = state.doc.entities.find(x => x.id === id);
    if (!e) state.sel.delete(id);
  }
  state.dirty = true; markDirty();
  renderAll(); setPrompt('Deleted layer ' + L.name + (count ? ' (' + count + ' objects moved to ' + target + ')' : ''));
}

function renameLayer(L) {
  const oldName = L.name;
  const name = prompt('Rename layer "' + oldName + '" to:', oldName);
  if (name == null) return;
  const trimmed = String(name).trim();
  if (!trimmed || trimmed === oldName) return;
  if (state.doc.layers.some(x => x !== L && x.name === trimmed)) {
    toast('A layer named "' + trimmed + '" already exists');
    return;
  }
  pushUndo();
  L.name = trimmed;
  for (const e of state.doc.entities) if (e.layer === oldName) e.layer = trimmed;
  if (state.doc.currentLayer === oldName) state.doc.currentLayer = trimmed;
  state.dirty = true;
  renderAll();
  markDirty();
  setPrompt('Renamed layer to ' + trimmed);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- properties panel (typed edits for a single selected entity) ---------- */
function renderProps() {
  const box = document.getElementById('props');
  const sel = state.doc.entities.filter(e => state.sel.has(e.id));
  if (!sel.length) { box.innerHTML = '<div class="empty">Nothing selected</div>'; return; }
  const e = sel[0];
  const rows = [];
  rows.push(['Type', e.type]);
  rows.push(['Layer', e.layer]);
  rows.push(['ID', e.id]);
  // editable: [label, value, apply(ent, val)]
  const edits = [];
  if (e.type === 'line') {
    rows.push(['Start', pt(e.p1)], ['End', pt(e.p2)], ['Length', fmt(dist(e.p1, e.p2))],
              ['Angle', fmt(deg(Math.atan2(e.p2[1] - e.p1[1], e.p2[0] - e.p1[0]))) + '\u00b0']);
  } else if (e.type === 'rect') {
    rows.push(['Corner', pt(e.p1)], ['Corner', pt(e.p2)]);
    edits.push(['Width', Math.abs(e.p2[0] - e.p1[0]), (en, v) => { en.p2[0] = en.p1[0] + v; }]);
    edits.push(['Height', Math.abs(e.p2[1] - e.p1[1]), (en, v) => { en.p2[1] = en.p1[1] + v; }]);
  } else if (e.type === 'circle') {
    rows.push(['Centre', pt(e.c)], ['Diameter', fmt(e.r * 2)]);
    edits.push(['Radius', e.r, (en, v) => { en.r = v; }]);
  } else if (e.type === 'arc') {
    rows.push(['Centre', pt(e.c)], ['Start', fmt(e.a0) + '\u00b0'], ['End', fmt(e.a1) + '\u00b0']);
    edits.push(['Radius', e.r, (en, v) => { en.r = v; }]);
  } else if (e.type === 'text') {
    rows.push(['Position', pt(e.p)]);
    edits.push(['Text', e.text || '', (en, v) => { en.text = v; }], ['Height', e.size, (en, v) => { en.size = v; }]);
  } else if (e.type === 'polyline') {
    rows.push(['Vertices', e.pts.length], ['Start', pt(e.pts[0])],
              ['End', pt(e.pts[e.pts.length - 1])]);
  } else if (e.type === 'dim') {
    const g = dimGeom(e);
    rows.push(['Measure', g.txt], ['From', pt(e.p1)], ['To', pt(e.p2)]);
    edits.push(['Offset', e.offset || 0, (en, v) => { en.offset = v; }]);
  }
  if (sel.length > 1) rows.unshift(['Selected', sel.length + ' objects']);
  const readOnly = sel.length > 1;
  box.innerHTML = rows.map(([k, v]) =>
    '<div class="prop-row"><span class="pk">' + esc(k) + '</span><span class="pv" title="' + esc(v) + '">' + esc(v) + '</span></div>'
  ).join('');
  if (!readOnly && edits.length) {
    const form = document.createElement('div');
    form.className = 'prop-edit';
    form.innerHTML = '<div class="prop-edit-title">Edit</div>';
    for (const [label, val, applyFn] of edits) {
      const row = document.createElement('div');
      row.className = 'prop-edit-row';
      const lab = document.createElement('span');
      lab.className = 'pk'; lab.textContent = label;
      const inp = document.createElement('input');
      inp.type = label === 'Text' ? 'text' : 'number';
      inp.step = 'any'; inp.className = 'prop-input'; inp.value = val;
      inp.setAttribute('aria-label', label);
      const commit = () => {
        const raw = label === 'Text' ? inp.value : parseFloat(inp.value);
        if (label !== 'Text' && (!isFinite(raw))) { renderProps(); return; }
        if (label !== 'Text' && raw <= 0 && label !== 'Offset') { toast('Value must be positive'); renderProps(); return; }
        pushUndo();
        applyFn(e, raw);
        state.dirty = true; markDirty();
        renderAll();
        setPrompt(label + ' updated');
      };
      inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); commit(); } if (ev.key === 'Escape') { renderProps(); } });
      inp.addEventListener('blur', () => { /* commit on blur only if changed */ });
      row.append(lab, inp);
      form.append(row);
    }
    const btn = document.createElement('button');
    btn.className = 'mini prop-apply'; btn.textContent = 'Apply';
    btn.onclick = () => {
      const inputs = form.querySelectorAll('input');
      inputs.forEach((inp, i) => {
        const [label, , applyFn] = edits[i];
        const raw = label === 'Text' ? inp.value : parseFloat(inp.value);
        if (label !== 'Text' && !isFinite(raw)) return;
        if (label !== 'Text' && raw <= 0 && label !== 'Offset') return;
        pushUndo();
        applyFn(e, raw);
        state.dirty = true; markDirty();
      });
      renderAll();
      setPrompt('Properties updated');
    };
    form.append(btn);
    box.append(form);
  }
}

function pt(p) { return '(' + fmt(p[0]) + ', ' + fmt(p[1]) + ')'; }

function renderSelInfo() {
  const n = state.sel.size;
  document.getElementById('selInfo').textContent = n === 0 ? '0 objects' : n + ' object' + (n === 1 ? '' : 's') + ' selected';
}

function setPrompt(t) {
  document.getElementById('promptText').textContent = t;
  document.getElementById('cmdEcho').textContent = 'Command: ' + t;
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ---------- tool handling ---------- */
const PROMPTS = {
  select: 'Select objects — click, or drag a window',
  line: 'Line: pick start point',
  polyline: 'Polyline: pick start point (Enter to finish)',
  rect: 'Rectangle: pick first corner',
  circle: 'Circle: pick centre',
  arc: 'Arc: pick start, second point, then end',
  text: 'Text: pick insertion point',
  dim: 'Dimension: pick first point',
  measure: 'Measure: pick first point',
  move: 'Move: select objects then press Enter, then pick base point',
  copy: 'Copy: select objects then press Enter, then pick base point',
  rotate: 'Rotate: select objects then press Enter, then pick centre, then drag (Shift = snap 15°)',
  erase: 'Erase: click objects to delete',
  offset: 'Offset: pick an object to offset',
  fillet: 'Fillet: pick first line near the corner',
  trim: 'Trim: pick boundary object (or right-click to skip and use nearest intersections)',
  extend: 'Extend: pick an object to reach the next boundary',
  break: 'Break: pick an object, then pick where to split it',
  underlaycal: 'Underlay calibrate: click the first point of a known distance on the image',
  vertex: 'Vertex edit: click a polyline, then drag a vertex (Del = delete one, midpoint circles = insert)',
};

function setTool(t) {
  state.tool = t;
  state.pending = [];
  state.preview = null;
  state.drag = null;
  state.phase = null;
  state.offsetEnt = null;
  state.filletPick = null;
  state.filletPreview = null;
  state.trimPick = null;
  state.trimHover = null;
  state.breakEnt = null;
  state.breakPreview = null;
  state.measureResult = null;
  state.vertexEnt = null;
  state.vertexIdx = null;
  state.vertexHover = null;
  if (t !== 'underlaycal') state.calibPts = [];
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  setPrompt(PROMPTS[t] || 'Ready');
  cv.classList.toggle('grab', t === 'select');
  draw();
}

function newId() {
  let i = 1;
  const ids = new Set(state.doc.entities.map(e => e.id));
  while (ids.has('e' + i)) i++;
  return 'e' + i + '_' + Math.random().toString(36).slice(2, 6);
}

function commitEntity(e) {
  e.id = newId();
  if (!e.layer) e.layer = state.doc.currentLayer;
  pushUndo();
  state.doc.entities.push(e);
  state.dirty = true;
  markDirty();
  renderAll();
}

function entityFromPending(tool, pts) {
  const L = state.doc.currentLayer;
  if (tool === 'line' && pts.length === 2) return { type: 'line', layer: L, p1: pts[0], p2: pts[1] };
  if (tool === 'rect' && pts.length === 2) return { type: 'rect', layer: L, p1: pts[0], p2: pts[1] };
  if (tool === 'circle' && pts.length === 2) return { type: 'circle', layer: L, c: pts[0], r: Math.max(0.01, dist(pts[0], pts[1])) };
  if (tool === 'dim' && pts.length === 2) {
    return { type: 'dim', layer: L, p1: pts[0], p2: pts[1], offset: 40 };
  }
  if (tool === 'arc' && pts.length === 3) {
    const [a, b, c] = pts;
    const cr = circle3(a, b, c);
    if (!cr) return null;
    let a0 = deg(Math.atan2(a[1] - cr.c[1], a[0] - cr.c[0]));
    let am = deg(Math.atan2(b[1] - cr.c[1], b[0] - cr.c[0]));
    let a1 = deg(Math.atan2(c[1] - cr.c[1], c[0] - cr.c[0]));
    // choose direction that passes through b
    const ccwOk = angleInArc(rad(am), a0, a1) && sweepCCW(a0, am) < sweepCCW(a0, a1);
    if (!ccwOk) { const t = a0; a0 = a1; a1 = t; }
    return { type: 'arc', layer: L, c: cr.c, r: cr.r, a0, a1 };
  }
  return null;
}

function sweepCCW(a0, a1) {
  let s = a1 - a0;
  while (s < 0) s += 360;
  return s;
}

function circle3(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return null;
  const ux = ((a[0] * a[0] + a[1] * a[1]) * (b[1] - c[1]) + (b[0] * b[0] + b[1] * b[1]) * (c[1] - a[1]) + (c[0] * c[0] + c[1] * c[1]) * (a[1] - b[1])) / d;
  const uy = ((a[0] * a[0] + a[1] * a[1]) * (c[0] - b[0]) + (b[0] * b[0] + b[1] * b[1]) * (a[0] - c[0]) + (c[0] * c[0] + c[1] * c[1]) * (b[0] - a[0])) / d;
  const ctr = [ux, uy];
  return { c: ctr, r: dist(ctr, a) };
}

/* ---------- picking ---------- */
function tolWorld() { return 7 / state.view.zoom; }

function pickAt(world, all) {
  const tol = tolWorld();
  const list = visibleEntities().filter(e => !lockedLayer(e.layer));
  for (let i = list.length - 1; i >= 0; i--) {
    if (hitEntity(list[i], world, tol)) return list[i];
  }
  return null;
}

function entitiesInWindow(r) {
  const x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1);
  const y0 = Math.min(r.y0, r.y1), y1 = Math.max(r.y0, r.y1);
  const out = [];
  for (const e of visibleEntities()) {
    if (lockedLayer(e.layer)) continue;
    const pts = entityPoints(e);
    if (!pts.length) continue;
    if (r.cross) {
      if (pts.some(p => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1)) out.push(e);
    } else {
      if (pts.every(p => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1)) out.push(e);
    }
  }
  return out;
}

/* ---------- transforms ---------- */
function applyTranslate(ents, d) {
  for (const e of ents) {
    if (e.p1) e.p1 = add(e.p1, d);
    if (e.p2) e.p2 = add(e.p2, d);
    if (e.c) e.c = add(e.c, d);
    if (e.p) e.p = add(e.p, d);
    if (e.pts) e.pts = e.pts.map(p => add(p, d));
  }
}
function applyRotate(ents, c, ang) {
  for (const e of ents) {
    if (e.p1) e.p1 = rotPt(e.p1, c, ang);
    if (e.p2) e.p2 = rotPt(e.p2, c, ang);
    if (e.c) e.c = rotPt(e.c, c, ang);
    if (e.p) e.p = rotPt(e.p, c, ang);
    if (e.pts) e.pts = e.pts.map(p => rotPt(p, c, ang));
    if (e.type === 'arc') { e.a0 += deg(ang); e.a1 += deg(ang); }
    if (e.type === 'text') { /* rotation not modelled */ }
  }
}
/* Mirror entities across a vertical axis (mode 'x') or horizontal axis (mode 'y')
   passing through the point `at`. Angles for arcs/dimensions are mirrored too. */
function applyMirror(ents, mode, at) {
  const mx = (p) => mode === 'x' ? [2 * at[0] - p[0], p[1]] : [p[0], 2 * at[1] - p[1]];
  for (const e of ents) {
    if (e.p1) e.p1 = mx(e.p1);
    if (e.p2) e.p2 = mx(e.p2);
    if (e.c) e.c = mx(e.c);
    if (e.p) e.p = mx(e.p);
    if (e.pts) e.pts = e.pts.map(mx);
    if (e.type === 'arc') {
      // axis angle: vertical mirror -> 90deg, horizontal mirror -> 0deg (in CCW degrees)
      const A = mode === 'x' ? 180 : 0;
      const mir = (a) => ((A - a) % 360 + 360) % 360;
      const n0 = mir(e.a0), n1 = mir(e.a1);
      e.a0 = n1; e.a1 = n0; // swap keeps the sweep direction after reflection
    }
  }
}

function cloneEnt(e) {
  const c = JSON.parse(JSON.stringify(e));
  c.id = newId();
  return c;
}

/* ---------- offset ---------- */
function offsetCalc(e, cursor) {
  // Returns {ov:[dx,dy]} to translate point-based entities, or {newR} for radius-based ones.
  function closestNormal(e, cursor) {
    // signed distance from cursor to entity, and unit normal direction at that side
    let cx, cy, d, nx, ny;
    if (e.type === 'line' || e.type === 'rect' || e.type === 'polyline') {
      let best = null, bestD = Infinity;
      const segs = e.type === 'polyline' ? e.pts.length - 1
                 : e.type === 'rect' ? 4
                 : 1;
      for (let i = 0; i < segs; i++) {
        const a = e.type === 'polyline' ? e.pts[i]
                : e.type === 'rect' ? [[e.p1[0], e.p1[1]], [e.p2[0], e.p1[1]], [e.p2[0], e.p2[1]], [e.p1[0], e.p2[1]]][i]
                : e.p1;
        const b = e.type === 'polyline' ? e.pts[i + 1]
                : e.type === 'rect' ? [[e.p1[0], e.p1[1]], [e.p2[0], e.p1[1]], [e.p2[0], e.p2[1]], [e.p1[0], e.p2[1]]][(i + 1) % 4]
                : e.p2;
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const len2 = dx * dx + dy * dy;
        let t = len2 ? ((cursor[0] - a[0]) * dx + (cursor[1] - a[1]) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const px = a[0] + t * dx, py = a[1] + t * dy;
        const dist = Math.hypot(cursor[0] - px, cursor[1] - py);
        if (dist < bestD) { bestD = dist; best = { a, b, px, py }; }
      }
      if (!best) return null;
      const { a, b, px, py } = best;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      // two unit normals; pick the one on the cursor side
      const n1 = [-dy / len, dx / len];
      const side = (cursor[0] - px) * n1[0] + (cursor[1] - py) * n1[1] >= 0 ? 1 : -1;
      d = bestD * side;
      nx = n1[0] * side; ny = n1[1] * side;
      cx = px; cy = py;
    } else if (e.type === 'circle' || e.type === 'arc') {
      cx = e.c[0]; cy = e.c[1];
      d = Math.hypot(cursor[0] - cx, cursor[1] - cy) - e.r;
      nx = cursor[0] - cx; ny = cursor[1] - cy;
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl; ny /= nl;
    } else {
      return null;
    }
    return { cx, cy, d, nx, ny };
  }
  const cn = closestNormal(e, cursor);
  if (!cn) return null;
  if (e.type === 'circle' || e.type === 'arc') {
    const newR = e.r + cn.d;
    if (newR < 0.01) return null;
    return { newR };
  }
  // For lines / rects / polylines: slide every point along the chosen normal by the
  // perpendicular distance from the entity to the cursor.
  return { ov: [cn.nx * Math.abs(cn.d), cn.ny * Math.abs(cn.d)] };
}
function applyOffset(src, calc) {
  const e = cloneEnt(src);
  if (calc.newR != null) {
    e.r = Math.max(0.01, calc.newR);
    return e;
  }
  const ov = calc.ov;
  if (e.p1) { e.p1 = [e.p1[0] + ov[0], e.p1[1] + ov[1]]; e.p2 = [e.p2[0] + ov[0], e.p2[1] + ov[1]]; }
  if (e.p)  { e.p  = [e.p[0] + ov[0], e.p[1] + ov[1]]; }
  if (e.pts) e.pts = e.pts.map(q => [q[0] + ov[0], q[1] + ov[1]]);
  return e;
}

/* ---------- live measure HUD ---------- */
/* Snap name readout: see updateSnapHud near drawSnapMarker. */
function hudAnchor() {
  // Reference point for length/angle/delta: second pending point, or drag base.
  if (state.drag && state.drag.base) return state.drag.base;
  if (state.pending && state.pending.length) return state.pending[state.pending.length - 1];
  return null;
}
let hudPending = null, hudRaf = 0;
function updateMeasureHud(p, raw, coords) {
  // rAF-throttled: DOM readout updates at most once per frame (display-only overlay).
  hudPending = { p, raw, coords };
  if (hudRaf) return;
  hudRaf = requestAnimationFrame(() => {
    hudRaf = 0;
    const d = hudPending; hudPending = null;
    if (d.coords) {
      document.getElementById('hx').textContent = d.coords[0];
      document.getElementById('hy').textContent = d.coords[1];
      document.getElementById('hz').textContent = d.coords[2];
    }
    renderMeasureHud(d.p);
  });
}
function renderMeasureHud(p) {
  const row = document.getElementById('hud-measure');
  if (!row) return;
  const a = hudAnchor();
  if (!a) { row.style.display = 'none'; return; }
  const dx = p[0] - a[0], dy = p[1] - a[1];
  const len = Math.hypot(dx, dy);
  let ang = deg(Math.atan2(dy, dx));
  if (ang < 0) ang += 360;
  const g = state.gridSnap ? state.gridStep : 0; // snap grid size for rounding
  const r = (v) => g ? Math.round(v / g) * g : v;
  document.getElementById('hl').textContent = fmt(r(len));
  document.getElementById('ha').textContent = fmt(r(ang)) + '°';
  document.getElementById('hd').textContent = fmt(r(dx)) + ', ' + fmt(r(dy));
  row.style.display = 'flex';
}

/* ---------- pointer events ---------- */
let spaceDown = false;
let panning = null;

function worldFromEvent(ev) {
  const r = cv.getBoundingClientRect();
  return s2w(ev.clientX - r.left, ev.clientY - r.top);
}

cv.addEventListener('mousemove', (ev) => {
  const raw = worldFromEvent(ev);
  state.mouseWorld = raw;
  const p = snapPoint(raw);
  const sp = w2s(p);
  updateMeasureHud(p, raw, [fmt(p[0]), fmt(p[1]), Math.round(state.view.zoom * 100) + '%']);

  if (panning) {
    const dx = ev.clientX - panning.x, dy = ev.clientY - panning.y;
    state.view.x = panning.vx - dx / state.view.zoom;
    state.view.y = panning.vy + dy / state.view.zoom;
    state.snapHit = null; // suppress glyph during pan drags
    draw();
    return;
  }

  if (state.drag && state.drag.mode === 'vertex') {
    const ent = state.doc.entities.find(e => e.id === state.drag.entId);
    if (!ent) { state.drag = null; draw(); return; }
    // one undo entry per drag gesture: push lazily on the first real move
    if (!state.drag.moved) { pushUndo(); state.drag.moved = true; }
    state.vertexIdx = state.drag.idx;
    // Alt = free move (no snapping); otherwise osnap/grid apply
    const np = ev.altKey ? raw.slice() : p;
    ent.pts[state.drag.idx] = np.slice();
    draw(); renderProps();
    return;
  }
  if (state.drag && state.drag.mode === 'move') {
    const d = sub(p, state.drag.base);
    if (!state.drag.moved && dist(p, state.drag.base) > 0) {
      pushUndo();
      state.drag.moved = true;
    }
    state.preview = null;
    applyTranslate(state.drag.ents, sub(p, state.drag.last));
    state.drag.last = p;
    draw(); renderProps();
    return;
  }
  if (state.drag && state.drag.mode === 'rotate') {
    let target = Math.atan2(p[1] - state.drag.center[1], p[0] - state.drag.center[0]);
    if (ev.shiftKey) target = Math.round(target / (Math.PI / 12)) * (Math.PI / 12);
    const ang = target - state.drag.lastAng;
    applyRotate(state.drag.ents, state.drag.center, ang);
    state.drag.lastAng = target;
    draw(); renderProps();
    return;
  }

  if (state.rubber) {
    state.rubber.x1 = ev.clientX - cv.getBoundingClientRect().left;
    state.rubber.y1 = ev.clientY - cv.getBoundingClientRect().top;
    state.rubber.cross = state.rubber.x1 < state.rubber.x0 || state.rubber.y1 < state.rubber.y0;
    draw();
    return;
  }

  // build live preview for geometric tools
  state.preview = null;
  const t = state.tool;
  if (t === 'offset' && state.offsetEnt && state.pending.length) {
    const calc = offsetCalc(state.offsetEnt, p);
    if (calc) {
      const ent = applyOffset(state.offsetEnt, calc);
      ent.type = ent.type; // keep
      state.preview = ent;
    }
  } else if (t === 'fillet' && state.filletPick) {
    const hit = pickAt(worldFromEvent(ev));
    state.filletPreview = null;
    if (hit && (hit.type === 'line' || hit.type === 'polyline')) {
      const res = filletGeom(state.filletPick, hit, worldFromEvent(ev), defaultFilletRadius(), false);
      if (res) state.filletPreview = res.arc;
    }
  } else if (t === 'trim' || t === 'extend') {
    state.trimHover = null;
    const w = worldFromEvent(ev);
    const hit = pickAt(w);
    if (hit && (hit.type === 'line' || (hit.type === 'polyline' && hit.pts.length === 2))) {
      const res = t === 'trim' ? trimGeom(hit, w) : extendGeom(hit, w);
      if (res) state.trimHover = { mode: t, entId: hit.id, cut: res.cut || null, newEnd: res.newEnd || null };
    }
  } else if (t === 'break') {
    state.breakPreview = null;
    const w = worldFromEvent(ev);
    if (state.breakEnt) {
      const ent = state.doc.entities.find(e => e.id === state.breakEnt.id);
      if (ent) {
        if (ent.type === 'circle') state.breakPreview = null; // circle: no split
        else if (ent.type === 'polyline') {
          const snap = snapPoint(w);
          if (snap) state.breakPreview = snap;
        } else {
          const res = breakGeom(ent, w);
          if (res) state.breakPreview = res.parts;
        }
      }
    }
  } else if (t === 'measure' && state.pending.length === 1) {
    state.preview = { type: 'line', layer: state.doc.currentLayer, p1: state.pending[0], p2: p };
  } else if (['line', 'rect', 'circle', 'dim', 'arc', 'polyline'].includes(t) && state.pending.length) {
    const pts = state.pending.concat([p]);
    if (t === 'polyline') {
      state.preview = { type: 'polyline', layer: state.doc.currentLayer, pts };
    } else {
      const ent = entityFromPending(t, pts);
      if (ent) state.preview = ent;
      else if (t === 'arc' && state.pending.length === 1) {
        state.preview = { type: 'line', layer: state.doc.currentLayer, p1: state.pending[0], p2: p };
      }
    }
  }
  draw();
});

cv.addEventListener('mousedown', (ev) => {
  if (ev.button === 1 || (ev.button === 0 && spaceDown)) {
    panning = { x: ev.clientX, y: ev.clientY, vx: state.view.x, vy: state.view.y };
    cv.classList.add('grabbing');
    ev.preventDefault();
    return;
  }
  if (ev.button === 2) return;

  const raw = worldFromEvent(ev);
  state.mouseWorld = raw;
  const p = snapPoint(raw);
  const t = state.tool;
  const rect = cv.getBoundingClientRect();

  if (t === 'select') {
    const hit = pickAt(raw);
    if (hit) {
      if (ev.shiftKey) {
        if (state.sel.has(hit.id)) state.sel.delete(hit.id); else state.sel.add(hit.id);
      } else if (!state.sel.has(hit.id)) {
        state.sel.clear(); state.sel.add(hit.id);
      }
      renderAll();
      // start drag move
      const ents = state.doc.entities.filter(e => state.sel.has(e.id) && !lockedLayer(e.layer));
      if (ents.length) {
        // Undo is pushed lazily on the first real move so a click-select is not an undo step.
        state.drag = { mode: 'move', ents, base: p, last: p, moved: false };
      }
    } else {
      if (!ev.shiftKey) state.sel.clear();
      state.rubber = { x0: ev.clientX - rect.left, y0: ev.clientY - rect.top,
                       x1: ev.clientX - rect.left, y1: ev.clientY - rect.top, cross: false };
      renderAll();
    }
    return;
  }

  if (t === 'underlaycal') {
    if (!state.doc.underlay) { setPrompt('Underlay calibrate: import a reference image first'); return; }
    state.calibPts = (state.calibPts || []).concat([p]);
    if (state.calibPts.length < 2) {
      setPrompt('Underlay calibrate: click the second point of the known distance');
      draw();
      return;
    }
    const measured = dist(state.calibPts[0], state.calibPts[1]);
    setPrompt('Underlay calibrate: measured ' + fmt(measured) + ' drawing units — enter the real distance');
    openCalibrateModal(measured);
    draw();
    return;
  }

  if (t === 'offset') {
    if (!state.offsetEnt) {
      const hit = pickAt(raw);
      if (!hit) return;
      const calc = offsetCalc(hit, p);
      if (!calc) { setPrompt('Offset: cannot offset that object type'); return; }
      state.offsetEnt = hit;
      state.pending.push(p);
      setPrompt('Offset: pick the side / distance');
      renderAll();
    } else {
      const calc = offsetCalc(state.offsetEnt, p);
      if (calc) {
        pushUndo();
        state.doc.entities.push(applyOffset(state.offsetEnt, calc));
        state.dirty = true; markDirty();
      } else {
        setPrompt('Offset: invalid distance, pick again');
      }
      state.offsetEnt = null;
      state.pending = [];
      state.preview = null;
      setPrompt(PROMPTS.offset);
      renderAll();
    }
    return;
  }

  if (t === 'fillet') {
    if (!state.filletPick) {
      const hit = pickAt(raw);
      if (!hit) return;
      if (!(hit.type === 'line' || hit.type === 'polyline')) { setPrompt('Fillet: pick a line or polyline'); return; }
      state.filletPick = hit;
      setPrompt('Fillet: pick the second object near the corner (Shift = chamfer, right-click = cancel)');
      draw();
      return;
    }
    const p1 = pickAt(raw);
    if (!p1) return;
    const chamfer = ev.shiftKey;
    pushUndo();
    const done = applyFillet(state.filletPick, p1, raw, chamfer ? 0.0001 : defaultFilletRadius(), chamfer);
    if (done) { state.dirty = true; markDirty(); renderAll();
      setPrompt((chamfer ? 'Chamfered' : 'Fillet done') + ' r=' + defaultFilletRadius() + ' — pick first line again');
    } else {
      setPrompt('Fillet: no tangent corner found at that corner — pick again');
      state.undo.pop();
    }
    state.filletPick = null;
    state.filletPreview = null;
    draw();
    return;
  }

  if (t === 'trim') {
    const hit = pickAt(raw);
    if (!hit) return;
    if (!(hit.type === 'line' || (hit.type === 'polyline' && hit.pts.length === 2))) {
      setPrompt('Trim: pick a line or 2-point polyline'); return;
    }
    if (ev.altKey && state.trimPick) { state.trimPick = null; } // alt = cut against all entities
    if (!state.trimPick && !ev.altKey) {
      // first click sets the cutting edge
      state.trimPick = hit;
      setPrompt('Trim: pick the part to cut (right-click = clear boundary, Alt-click = cut against all)');
      draw(); return;
    }
    if (state.trimPick === hit) {
      // clicking the boundary itself again clears it (fallback mode)
      state.trimPick = null;
      setPrompt('Trim: boundary cleared — cuts use the nearest crossing entity');
      draw(); return;
    }
    pushUndo();
    const done = applyTrim(hit, raw);
    if (done) {
      state.doc.entities = state.doc.entities.filter(e => e.id !== hit.id);
      state.doc.entities.push(done.add);
      state.dirty = true; markDirty(); renderAll();
      setPrompt('Trimmed — pick the next part to cut (right-click = clear boundary)');
    } else {
      state.undo.pop();
      setPrompt('Trim: no crossing found — pick again');
    }
    draw();
    return;
  }

  if (t === 'extend') {
    const hit = pickAt(raw);
    if (!hit) return;
    if (!(hit.type === 'line' || (hit.type === 'polyline' && hit.pts.length === 2))) {
      setPrompt('Extend: pick a line or 2-point polyline'); return;
    }
    pushUndo();
    const done = applyExtend(hit, raw);
    if (done) {
      state.dirty = true; markDirty(); renderAll();
      setPrompt('Extended — pick the next end');
    } else {
      state.undo.pop();
      setPrompt('Extend: no boundary ahead along that direction — pick again');
    }
    draw();
    return;
  }

  if (t === 'erase') {
    const hit = pickAt(raw);
    if (hit) {
      pushUndo();
      state.doc.entities = state.doc.entities.filter(e => e.id !== hit.id);
      state.dirty = true; markDirty(); renderAll();
      setPrompt('Erased ' + hit.type);
    }
    return;
  }

  if (t === 'break') {
    if (!state.breakEnt) {
      const hit = pickAt(raw);
      if (!hit) return;
      state.breakEnt = hit;
      if (hit.type === 'circle') setPrompt('Break: a circle has no single split point — pick another object (Alt-click to clear)');
      else if (hit.type === 'rect' || hit.type === 'text' || hit.type === 'dim') setPrompt('Break: ' + hit.type + ' not supported — pick a line, polyline or arc (Alt-click to clear)');
      else setPrompt('Break: pick the split point on the ' + hit.type + ' (Alt-click to clear)');
      draw(); return;
    }
    const ent = state.doc.entities.find(e => e.id === state.breakEnt.id);
    state.breakEnt = null;
    state.breakPreview = null;
    if (!ent) { setPrompt('Break: object is gone — pick a new object'); draw(); return; }
    if (ent.type !== 'line' && ent.type !== 'polyline' && ent.type !== 'arc') {
      setPrompt('Break: not supported on ' + ent.type + ' — pick a line, polyline or arc');
      draw(); return;
    }
    pushUndo();
    const res = breakGeom(ent, p);
    if (!res) {
      state.undo.pop();
      setPrompt('Break: split point is on an endpoint — pick a point along the object');
      draw(); return;
    }
    state.doc.entities = state.doc.entities.filter(e => e.id !== ent.id);
    for (const part of res.parts) { part.id = newId(); state.doc.entities.push(part); }
    state.dirty = true; markDirty(); renderAll();
    setPrompt('Broken into ' + res.parts.length + ' objects — pick the next object');
    draw();
    return;
  }

  if ((t === 'move' || t === 'copy' || t === 'rotate') && state.phase === 'base') {
    const ents = state.doc.entities.filter(e => state.sel.has(e.id) && !lockedLayer(e.layer));
    if (!ents.length) { state.phase = null; setPrompt('Nothing selected'); return; }
    state.opBase = p;
    if (t === 'copy') {
      state.phase = 'dest';
      setPrompt('Copy: pick destination point');
    } else if (t === 'move') {
      pushUndo();
      state.phase = null;
      state.drag = { mode: 'move', ents, base: p, last: p };
      setPrompt('Move: pick destination point');
    } else {
      pushUndo();
      state.phase = null;
      state.drag = { mode: 'rotate', ents, center: p, lastAng: 0 };
      setPrompt('Rotate: drag around the centre, release to finish');
    }
    draw();
    return;
  }

  if (t === 'copy' && state.phase === 'dest') {
    const d = sub(p, state.opBase);
    pushUndo();
    const src = state.doc.entities.filter(e => state.sel.has(e.id) && !lockedLayer(e.layer));
    const copies = src.map(cloneEnt);
    applyTranslate(copies, d);
    state.doc.entities.push(...copies);
    state.sel = new Set(copies.map(c => c.id));
    state.phase = null;
    state.dirty = true; markDirty(); renderAll();
    setPrompt('Copied ' + copies.length + ' object(s)');
    return;
  }

  if (t === 'move' || t === 'copy' || t === 'rotate') {
    if (!state.phase) {
      const hit = pickAt(raw);
      if (hit) {
        if (ev.shiftKey) { state.sel.has(hit.id) ? state.sel.delete(hit.id) : state.sel.add(hit.id); }
        else { state.sel.clear(); state.sel.add(hit.id); }
      } else if (!state.sel.size) {
        state.rubber = { x0: ev.clientX - rect.left, y0: ev.clientY - rect.top,
                         x1: ev.clientX - rect.left, y1: ev.clientY - rect.top, cross: false };
      }
      renderAll();
      if (state.sel.size) setPrompt((t === 'rotate' ? 'Rotate' : t === 'copy' ? 'Copy' : 'Move') +
        ': ' + state.sel.size + ' selected — press Enter to continue');
      return;
    }
    // phase 2/3 handled below
  }

  if (t === 'vertex') {
    const tol = tolWorld(); // ~7 px at current zoom
    if (state.vertexEnt) {
      const ent = state.doc.entities.find(e => e.id === state.vertexEnt && e.type === 'polyline' && !lockedLayer(e.layer));
      if (ent) {
        // priority 1: existing vertex handles (squares)
        let best = null, bd = tol;
        for (let i = 0; i < ent.pts.length; i++) {
          const d = dist(ent.pts[i], raw);
          if (d < bd) { bd = d; best = i; }
        }
        if (best !== null) {
          state.vertexIdx = best;
          // drag starts lazily (no undo until a real move)
          state.drag = { mode: 'vertex', entId: ent.id, idx: best, moved: false };
          setPrompt('Vertex: drag to move (Alt = free move, no snap); Del = delete this vertex');
          draw(); return;
        }
        // priority 2: midpoint handles (insert a vertex)
        let mi = null, md = tol;
        for (let i = 0; i < ent.pts.length - 1; i++) {
          const m = mid(ent.pts[i], ent.pts[i + 1]);
          const d = dist(m, raw);
          if (d < md) { md = d; mi = i; }
        }
        if (mi !== null) {
          pushUndo();
          ent.pts.splice(mi + 1, 0, mid(ent.pts[mi], ent.pts[mi + 1]));
          state.vertexIdx = mi + 1;
          state.dirty = true; markDirty();
          setPrompt('Vertex inserted — drag it or pick another handle');
          draw(); renderProps(); return;
        }
      }
    }
    // priority 3: pick a polyline body to edit
    const hit = pickAt(raw);
    if (hit && hit.type === 'polyline') {
      state.vertexEnt = hit.id;
      state.vertexIdx = null;
      state.sel.clear();
      setPrompt('Polyline picked: ' + hit.pts.length + ' vertices — drag a square to move, a circle to insert, Del to delete');
    } else {
      // empty canvas or non-polyline: leave edit mode
      state.vertexEnt = null;
      state.vertexIdx = null;
      setPrompt('Vertex edit: click a polyline to expose its vertices');
    }
    draw(); renderProps(); return;
  }

  if (t === 'measure') {
    state.pending.push(p);
    if (state.pending.length === 1) {
      setPrompt('Measure: pick second point');
    } else {
      const a = state.pending[0];
      state.pending = [];
      state.preview = null;
      state.measureResult = { a, b: p };
      setPrompt('Measured: ' + fmt(dist(a, p)) + ' — pick first point to measure again');
    }
    draw();
    return;
  }

  pickPoint(p);
});

window.addEventListener('mouseup', (ev) => {
  if (panning) { panning = null; cv.classList.remove('grabbing'); return; }
  if (state.drag && state.drag.mode === 'vertex') {
    if (state.drag.moved) { state.dirty = true; markDirty(); } // autosave only on gesture commit
    state.drag = null;
    renderAll();
    return;
  }
  if (state.drag && state.drag.mode === 'move') {
    state.dirty = true; markDirty(); state.drag = null; renderAll(); return;
  }
  if (state.drag && state.drag.mode === 'rotate') {
    state.dirty = true; markDirty(); state.drag = null; renderAll(); return;
  }
  if (state.rubber) {
    const r = state.rubber;
    state.rubber = null;
    // rubber rect is in screen coords; entityPoints are world coords — convert
    const wa = s2w(Math.min(r.x0, r.x1), Math.min(r.y0, r.y1));
    const wb = s2w(Math.max(r.x0, r.x1), Math.max(r.y0, r.y1));
    const picked = entitiesInWindow({ x0: wa[0], y0: wb[1], x1: wb[0], y1: wa[1], cross: r.cross });
    const add_ = picked.map(e => e.id);
    if (Math.abs(r.x1 - r.x0) < 3 && Math.abs(r.y1 - r.y0) < 3) {
      if (!ev.shiftKey) state.sel.clear();
    } else {
      if (!ev.shiftKey) state.sel.clear();
      add_.forEach(id => state.sel.add(id));
    }
    renderAll();
    if (state.sel.size) setPrompt(state.sel.size + ' object(s) selected');
    else setPrompt(PROMPTS[state.tool] || 'Ready');
  }
});

cv.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const r = cv.getBoundingClientRect();
  const sx = ev.clientX - r.left, sy = ev.clientY - r.top;
  const before = s2w(sx, sy);
  const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
  state.view.zoom = Math.min(60, Math.max(0.02, state.view.zoom * factor));
  const after = s2w(sx, sy);
  state.view.x += before[0] - after[0];
  state.view.y += before[1] - after[1];
  draw();
}, { passive: false });

cv.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  if (state.tool === 'trim') {
    if (state.trimPick) { state.trimPick = null; setPrompt('Trim: pick the part to cut (nearest intersection is the cut edge)'); }
    else { setTool('trim'); }
    draw();
  }
});

function finishPolyline() {
  if (state.tool === 'polyline' && state.pending.length >= 2) {
    const pts = state.pending.slice();
    state.pending = [];
    state.preview = null;
    commitEntity({ type: 'polyline', layer: state.doc.currentLayer, pts });
    setPrompt(PROMPTS.polyline);
  }
}

/* ---------- command bar: precise coordinate entry ---------- */
function pickPoint(p) {
  const t = state.tool;
  if (t === 'text') {
    state.pending = [p];
    openTextModal();
    return;
  }
  // geometric tools: collect points
  state.pending.push(p);
  state.lastPt = p;
  state.snapHit = null;

  if (t === 'polyline') {
    setPrompt('Polyline: pick next point (Enter to finish, or type a coordinate)');
    state.preview = null;
    draw();
    return;
  }

  const need = t === 'arc' ? 3 : 2;
  if (state.pending.length >= need) {
    const ent = entityFromPending(t, state.pending);
    const pts = state.pending.slice();
    state.pending = [];
    state.lastPt = pts[pts.length - 1];
    state.preview = null;
    if (ent) { commitEntity(ent); setPrompt(PROMPTS[t] + '  (again)'); }
    draw();
  } else {
    const p2 = { line: 'pick end point', rect: 'pick opposite corner', circle: 'pick radius point',
                 arc: 'pick second point', dim: 'pick second point' }[t];
    setPrompt((t.charAt(0).toUpperCase() + t.slice(1)) + ': ' + p2 + ' — or type x,y / dist<angle');
  }
  draw();
}

const cmdInput = document.getElementById('cmdInput');
const PT_TOOLS = ['line', 'polyline', 'rect', 'circle', 'arc', 'dim', 'text'];

/* ---------- command bar dispatcher (v1: LINE, RECTANGLE, CIRCLE, MOVE, COPY, OFFSET) ---------- */
const CMD_NAMES = {
  line: 'LINE', l: 'LINE',
  circle: 'CIRCLE', c: 'CIRCLE',
  rect: 'RECTANGLE', rectangle: 'RECTANGLE', r: 'RECTANGLE',
  move: 'MOVE',
  copy: 'COPY',
  offset: 'OFFSET',
};
let cmdLogLines = [];
function cmdLog(msg) {
  cmdLogLines.push(msg);
  if (cmdLogLines.length > 8) cmdLogLines = cmdLogLines.slice(-8);
  const el = document.getElementById('cmdHistory');
  if (el) el.textContent = cmdLogLines.join('\n');
}
function parsePointTokens(tokens) {
  const pts = [];
  let ref = state.lastPt || [0, 0];
  for (const tk of tokens) {
    const p = parseCoordEntry(tk, ref);
    if (!p) return null;
    pts.push(p);
    ref = p;
  }
  return pts;
}
function entBBoxCenter(e) {
  let xs = [], ys = [];
  if (e.p1 && e.p2) { xs = [e.p1[0], e.p2[0]]; ys = [e.p1[1], e.p2[1]]; }
  else if (e.p) { xs = [e.p[0]]; ys = [e.p[1]]; }
  else if (e.c) { xs = [e.c[0]]; ys = [e.c[1]]; }
  else if (e.pts) { xs = e.pts.map(q => q[0]); ys = e.pts.map(q => q[1]); }
  if (!xs.length) return null;
  return [xs.reduce((a, b) => a + b, 0) / xs.length, ys.reduce((a, b) => a + b, 0) / ys.length];
}
function nearestOnEnt(e, q) {
  // nearest point on the entity to q, plus the unit direction from that point to q
  if (e.type === 'circle' || e.type === 'arc') {
    const dx = q[0] - e.c[0], dy = q[1] - e.c[1];
    const n = Math.hypot(dx, dy) || 1;
    const d = Math.hypot(dx, dy) - e.r;
    return { pt: [e.c[0] + dx / n * e.r, e.c[1] + dy / n * e.r], dir: [dx / n, dy / n], d };
  }
  let best = null, bd = Infinity;
  const segs = e.type === 'polyline' ? e.pts.length - 1
             : e.type === 'rect' ? 4
             : (e.p1 && e.p2) ? 1 : 0;
  for (let i = 0; i < segs; i++) {
    const a = e.type === 'polyline' ? e.pts[i]
            : e.type === 'rect' ? [[e.p1[0], e.p1[1]], [e.p2[0], e.p1[1]], [e.p2[0], e.p2[1]], [e.p1[0], e.p2[1]]][i]
            : e.p1;
    const b = e.type === 'polyline' ? e.pts[i + 1]
            : e.type === 'rect' ? [[e.p1[0], e.p1[1]], [e.p2[0], e.p1[1]], [e.p2[0], e.p2[1]], [e.p1[0], e.p2[1]]][(i + 1) % 4]
            : e.p2;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a[0] + t * dx, py = a[1] + t * dy;
    const d = Math.hypot(q[0] - px, q[1] - py);
    if (d < bd) { bd = d; best = [px, py, a, b]; }
  }
  if (!best) return null;
  const dx = q[0] - best[0], dy = q[1] - best[1];
  const n = Math.hypot(dx, dy) || 1;
  return { pt: [best[0], best[1]], dir: [dx / n, dy / n], d: bd };
}

function execCommand(raw) {
  const s = (raw || '').trim();
  if (!s) return false;
  const tokens = s.split(/\s+/);
  const head = tokens[0].toLowerCase();
  const name = CMD_NAMES[head];
  if (!name) return false; // not a command: caller falls back to coordinate entry
  cmdLog(name);
  const rest = tokens.slice(1);
  if (name === 'LINE' || name === 'RECTANGLE' || name === 'CIRCLE') {
    const tool = name === 'LINE' ? 'line' : name === 'RECTANGLE' ? 'rect' : 'circle';
    setTool(tool);
    if (!rest.length) { setPrompt(name + ': pick the ' + (name === 'CIRCLE' ? 'centre' : 'start') + ' point, or type x,y / @x,y / dist<angle'); return true; }
    // CIRCLE special form: `circle <cx,cy> <radius>` — a bare number is a radius, not a point
    if (name === 'CIRCLE' && rest.length === 2 && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(rest[1])) {
      const c0 = parseCoordEntry(rest[0], state.lastPt || [0, 0]);
      const rr = Math.abs(parseFloat(rest[1]));
      if (!c0 || !isFinite(rr) || rr < 0.01) { cmdLog('CIRCLE: bad coordinates'); setPrompt('CIRCLE: could not parse coordinates'); return true; }
      pickPoint(c0); pickPoint([c0[0] + rr, c0[1]]);
      return true;
    }
    const pts = parsePointTokens(rest);
    if (!pts) { cmdLog(name + ': bad coordinates'); setPrompt(name + ': could not parse coordinates'); return true; }
    if (pts.length !== 2) { setPrompt(name + ': needs exactly 2 points'); return true; }
    if (Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) < 1e-9) { setPrompt(name + ': points must differ'); return true; }
    for (const p of pts) pickPoint(p);
    return true;
  }
  if (name === 'MOVE' || name === 'COPY') {
    const t = name.toLowerCase();
    setTool(t);
    if (!state.sel.size) { setPrompt(name + ': nothing selected — click objects, then run ' + name + ' again'); return true; }
    if (!rest.length) { state.phase = 'base'; setPrompt(name + ': pick base point (or run again with @dx,dy)'); return true; }
    // delta form: MOVE/COPY @dx,dy  or  dx<angle
    let d = null;
    if (rest.length === 1) {
      const m = rest[0].match(/^@?\s*(-?\d*\.?\d+)\s*<\s*(-?\d*\.?\d+)$/);
      if (m) {
        const dist = parseFloat(m[1]), ang = parseFloat(m[2]) * Math.PI / 180;
        d = [dist * Math.cos(ang), dist * Math.sin(ang)];
      } else {
        const pt = parseCoordEntry(rest[0], [0, 0]);
        if (pt && rest[0].startsWith('@')) d = pt;
      }
    } else if (rest.length === 2) {
      const a = parseCoordEntry(rest[0], null), b = parseCoordEntry(rest[1], null);
      if (a && b) d = [b[0] - a[0], b[1] - a[1]];
    }
    if (!d || !d.every(Number.isFinite)) { setPrompt(name + ': use ' + name + ' @dx,dy  or  ' + name + ' x1,y1 x2,y2'); return true; }
    const ents = state.doc.entities.filter(e => state.sel.has(e.id) && !lockedLayer(e.layer));
    if (!ents.length) { setPrompt(name + ': selection is on a locked layer'); return true; }
    if (name === 'MOVE') {
      pushUndo();
      applyTranslate(ents, d);
      state.dirty = true; markDirty(); renderAll();
      setPrompt('Moved ' + ents.length + ' object(s) by ' + d[0].toFixed(2) + ',' + d[1].toFixed(2));
      cmdLog('Moved ' + ents.length + ' by ' + d.map(v => v.toFixed(2)).join(','));
    } else {
      pushUndo();
      const copies = ents.map(cloneEnt);
      applyTranslate(copies, d);
      state.doc.entities.push(...copies);
      state.sel = new Set(copies.map(c => c.id));
      state.dirty = true; markDirty(); renderAll();
      setPrompt('Copied ' + copies.length + ' object(s) by ' + d[0].toFixed(2) + ',' + d[1].toFixed(2));
      cmdLog('Copied ' + copies.length + ' by ' + d.map(v => v.toFixed(2)).join(','));
    }
    return true;
  }
  if (name === 'OFFSET') {
    setTool('offset');
    if (!rest.length) { setPrompt('Offset: click an object, then a side point — or OFFSET <entity-index> <distance>'); return true; }
    // numeric form: OFFSET <1-based entity index> <distance>
    const num = rest.map(Number);
    if (num.length === 2 && Number.isInteger(num[0]) && isFinite(num[1]) && num[0] >= 1 && num[0] <= state.doc.entities.length) {
      const e = state.doc.entities[Math.floor(num[0]) - 1];
      if (lockedLayer(e.layer)) { setPrompt('Offset: object is on a locked layer'); return true; }
      if (Math.abs(num[1]) < 1e-9) { setPrompt('Offset: invalid distance'); return true; }
      // Stable signed side: left normal of the first segment; positive expands a circle/arc.
      // Using a bbox centre as a side point degenerates for lines and circles.
      let calc = null;
      if (e.type === 'circle' || e.type === 'arc') {
        if (e.r + num[1] >= 0.01) calc = {newR: e.r + num[1]};
      } else if (['line', 'rect', 'polyline'].includes(e.type)) {
        const a = e.type === 'polyline' ? e.pts[0] : e.p1;
        const b = e.type === 'polyline' ? e.pts[1] : e.type === 'rect' ? [e.p2[0], e.p1[1]] : e.p2;
        if (a && b) {
          const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
          if (len > 1e-9) calc = {ov: [-dy / len * num[1], dx / len * num[1]]};
        }
      }
      if (!calc) { setPrompt('Offset: invalid distance'); return true; }
      pushUndo();
      state.doc.entities.push(applyOffset(e, calc));
      state.dirty = true; markDirty(); renderAll();
      setPrompt('Offset ' + num[0] + ' by ' + num[1] + ' — pick the next object');
      cmdLog('Offset ' + num[0] + ' d=' + num[1]);
    } else {
      setPrompt('Offset: use OFFSET <entity number> <distance>, or click an object then a side point');
    }
    return true;
  }
  return false;
}

function parseCoordEntry(str, ref) {
  const s = (str || '').trim().toLowerCase();
  if (!s) return null;
  const rel = s.startsWith('@');
  const body = rel ? s.slice(1) : s;
  const base = ref || [0, 0];
  let out = null;
  if (body.includes('<')) {
    const m = body.match(/^(-?\d*\.?\d+)\s*<\s*(-?\d*\.?\d+)$/);
    if (!m) return null;
    const d = parseFloat(m[1]);
    const a = parseFloat(m[2]) * Math.PI / 180;
    // polar is always measured from the last point (origin if none)
    out = [base[0] + d * Math.cos(a), base[1] + d * Math.sin(a)];
  } else {
    const m = body.match(/^(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)$/);
    if (!m) return null;
    const x = parseFloat(m[1]), y = parseFloat(m[2]);
    out = rel ? [base[0] + x, base[1] + y] : [x, y];
  }
  if (!out || !isFinite(out[0]) || !isFinite(out[1])) return null;
  return out;
}

cmdInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    const raw = cmdInput.value;
    cmdInput.value = '';
    cmdInput.blur();
    if (raw && raw.trim() && execCommand(raw)) return; // command form: LINE/CIRCLE/RECTANGLE/MOVE/COPY/OFFSET
    const pt = parseCoordEntry(raw, state.lastPt);
    if (!pt) { setPrompt('Command: LINE, RECTANGLE, CIRCLE, MOVE @dx,dy, COPY @dx,dy, OFFSET n dist — or x,y / @x,y / dist<angle'); cmdLog(raw.trim() + ': unknown command'); return; }
    if (!PT_TOOLS.includes(state.tool)) {
      setPrompt('Command: pick a drawing tool first (L, P, R, C, A, D, T)');
      return;
    }
    setPrompt('Command: ' + pt[0].toFixed(2) + ',' + pt[1].toFixed(2));
    pickPoint(pt);
  } else if (ev.key === 'Escape') {
    cmdInput.value = '';
    cmdInput.blur();
  }
});

function keyEnter() {
  if (state.tool === 'polyline') return finishPolyline();
  if (['move', 'copy', 'rotate'].includes(state.tool)) {
    if (!state.phase) {
      if (!state.sel.size) return toast('Select objects first');
      state.phase = 'base';
      setPrompt((state.tool === 'rotate' ? 'Rotate' : state.tool === 'copy' ? 'Copy' : 'Move') +
                ': pick base point');
      return;
    }
    state.phase = null;
    state.pending = [];
    setPrompt(PROMPTS[state.tool]);
    return;
  }
  state.pending = [];
  state.preview = null;
  state.phase = null;
  setPrompt(PROMPTS[state.tool] || 'Ready');
  draw();
}


/* ---------- fillet / chamfer ---------- */
function defaultFilletRadius() { return 10; }

function linePar(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  return { px: a[0], py: a[1], ux: dx / len, uy: dy / len, len };
}
function lineIsect(l1, l2) {
  const den = l1.ux * l2.uy - l1.uy * l2.ux;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((l2.px - l1.px) * l2.uy - (l2.py - l1.py) * l2.ux) / den;
  return [l1.px + t * l1.ux, l1.py + t * l1.uy];
}
function cornerOn(ent, near) {
  // the segment endpoint (corner vertex) closest to the pick point
  if (ent.type === 'line') return ent.p1[0] * ent.p1[0] + ent.p1[1] * ent.p1[1] <= ent.p2[0] * ent.p2[0] + ent.p2[1] * ent.p2[1] ? ent.p1 : ent.p2;
  if (ent.type === 'polyline') {
    let best = null, bd = Infinity;
    for (const q of ent.pts) { const d = (q[0] - near[0]) ** 2 + (q[1] - near[1]) ** 2; if (d < bd) { bd = d; best = q; } }
    return best;
  }
  return null;
}
function filletGeom(e1, e2, near1, r, chamfer) {
  // e1, e2: entities; near1: pick point on e1 (chamfer/fillet side hint for lines)
  // returns { arc, trim1, trim2, inserted } or null
  const segA = segOf(e1, near1), segB = segOf(e2, near1);
  if (!segA || !segB) return null;
  const l1 = linePar(segA[0], segA[1]), l2 = linePar(segB[0], segB[1]);
  const X = lineIsect(l1, l2);
  if (!X) return null;
  const ang = Math.abs(Math.atan2(l1.ux * l2.uy - l1.uy * l2.ux, l1.ux * l2.ux + l1.uy * l2.uy));
  if (ang < 1e-4) return null;
  // direction from corner into the segment bodies (away from the pick ends)
  const d1 = segDirInto(segA, X), d2 = segDirInto(segB, X);
  if (!d1 || !d2) return null;
  const half = ang / 2;
  const bis = [ (d1[0] + d2[0]), (d1[1] + d2[1]) ];
  const bl = Math.hypot(bis[0], bis[1]) || 1;
  bis[0] /= bl; bis[1] /= bl;
  const cdist = r / Math.sin(half);
  const C = [X[0] + bis[0] * cdist, X[1] + bis[1] * cdist];
  // tangent points on each line: foot of perpendicular from C
  const t1 = [X[0] + d1[0] * (r / Math.tan(half)), X[1] + d1[1] * (r / Math.tan(half))];
  const t2 = [X[0] + d2[0] * (r / Math.tan(half)), X[1] + d2[1] * (r / Math.tan(half))];
  if (chamfer) {
    const ch = r; // for v1 chamfer uses the same pick distance
    const c1 = [X[0] + d1[0] * ch, X[1] + d1[1] * ch];
    const c2 = [X[0] + d2[0] * ch, X[1] + d2[1] * ch];
    return { arc: null, trim1: c1, trim2: c2, inserted: { type: 'line', p1: c1, p2: c2 } };
  }
  let a0 = deg(Math.atan2(t1[1] - C[1], t1[0] - C[0]));
  let a1 = deg(Math.atan2(t2[1] - C[1], t2[0] - C[0]));
  // sweep through the bisector direction, away from the corner
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += 360;
  const midAng = deg(Math.atan2(bis[1], bis[0]));
  if (!angleInArc(rad(midAng), a0, a1)) { const tmp = a0; a0 = a1; a1 = tmp; sweep = 360 - sweep; }
  const arc = { type: 'arc', c: C, r, a0, a1 };
  return { arc, trim1: t1, trim2: t2, inserted: arc };
}
function segOf(ent, near) {
  // nearest segment [a, b] on ent, with its adjacent corner vertex
  if (ent.type === 'line') {
    const d1 = (near[0] - ent.p1[0]) ** 2 + (near[1] - ent.p1[1]) ** 2;
    const d2 = (near[0] - ent.p2[0]) ** 2 + (near[1] - ent.p2[1]) ** 2;
    return [ent.p1, ent.p2, d1 <= d2 ? ent.p1 : ent.p2];
  }
  if (ent.type === 'polyline') {
    let best = null, bd = Infinity;
    for (let i = 0; i < ent.pts.length - 1; i++) {
      const a = ent.pts[i], b = ent.pts[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], l2v = dx * dx + dy * dy;
      let tt = l2v ? ((near[0] - a[0]) * dx + (near[1] - a[1]) * dy) / l2v : 0;
      tt = Math.max(0, Math.min(1, tt));
      const px = a[0] + tt * dx, py = a[1] + tt * dy;
      const d = (near[0] - px) ** 2 + (near[1] - py) ** 2;
      if (d < bd) { bd = d; best = [a, b]; }
    }
    if (!best) return null;
    return [best[0], best[1], cornerOn(ent, near)];
  }
  return null;
}
function segDirInto(seg, X) {
  // unit direction from the corner X into the segment body (toward its far endpoint)
  const corner = seg[2];
  const far = (seg[0] === corner) ? seg[1] : seg[0];
  const dx = far[0] - corner[0], dy = far[1] - corner[1];
  const len = Math.hypot(dx, dy) || 1;
  // pick the half-line of the infinite line that goes toward the far end from X
  const dir = [dx / len, dy / len];
  const toX = [X[0] - corner[0], X[1] - corner[1]];
  if (dir[0] * toX[0] + dir[1] * toX[1] > 0) return null; // far end is on the corner side of X: degenerate
  return dir;
}
function applyFillet(e1, e2, near1, r, chamfer) {
  const near2 = near1;
  const res = filletGeom(e1, e2, near1, r, chamfer);
  if (!res) return null;
  if (!chamfer) {
    if (!res.arc || res.arc.r < 0.01) return null;
    if (res.trim1[0] * res.trim1[0] + res.trim1[1] * res.trim1[1] > 1e12) return null;
  }
  const arc = res.inserted;
  arc.id = newId();
  if (!arc.layer) arc.layer = state.doc.currentLayer;
  // trim: replace e1/e2 endpoint at the corner with the tangent/chamfer points
  const trimEnt = (ent, to) => {
    if (ent.type === 'line') {
      const nearEnd = segOf(ent, near1)[2];
      const pts = ent === e1 ? 'p1p2' : 'p1p2';
      if (dist(ent.p1, nearEnd) < 1e-6) ent.p1 = to; else ent.p2 = to;
    } else if (ent.type === 'polyline') {
      const corner = cornerOn(ent, near1);
      const idx = ent.pts.findIndex(q => q === corner);
      if (idx >= 0) ent.pts[idx] = to;
    }
  };
  if (e1 === e2 && e1.type === 'polyline') {
    // not supported in v1 (same-entity corner): skip
    return null;
  }
  trimEnt(e1, res.trim1);
  trimEnt(e2, res.trim2);
  state.doc.entities.push(arc);
  return true;
}

/* ---------- trim / extend ---------- */
function entSegsFlat(ent) {
  if (ent.type === 'line') return [[ent.p1, ent.p2]];
  if (ent.type === 'polyline') {
    const out = [];
    for (let i = 0; i < ent.pts.length - 1; i++) out.push([ent.pts[i], ent.pts[i + 1]]);
    return out;
  }
  return [];
}
function rectCornersOf(e) {
  const x0 = Math.min(e.p1[0], e.p2[0]), x1 = Math.max(e.p1[0], e.p2[0]);
  const y0 = Math.min(e.p1[1], e.p2[1]), y1 = Math.max(e.p1[1], e.p2[1]);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}
function rayIntersectSeg(pa, du, a, b) {
  // infinite ray pa + s*du vs finite segment ab; returns ray distance s or null
  const den = du[0] * (b[1] - a[1]) - du[1] * (b[0] - a[0]);
  if (Math.abs(den) < 1e-9) return null;
  const s = ((a[0] - pa[0]) * (b[1] - a[1]) - (a[1] - pa[1]) * (b[0] - a[0])) / den;
  if (s < -1e-7) return null; // behind the ray origin
  // reject hits beyond the finite segment: segment parameter t
  const ex = b[0] - a[0], ey = b[1] - a[1];
  const el2 = ex * ex + ey * ey || 1;
  const t = ((pa[0] + s * du[0] - a[0]) * ex + (pa[1] + s * du[1] - a[1]) * ey) / el2;
  if (t < -1e-7 || t > 1 + 1e-7) return null;
  return s;
}
function projT(a, b, p) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2v = dx * dx + dy * dy || 1;
  return Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2v));
}
function dist2(a, b) { return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2; }
/* all intersections of the infinite line through seg with entity e (finite shapes) */
function lineEntIsects(a, b, e, out) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const u = [dx / len, dy / len];
  const push = (s) => { if (s !== null && s !== undefined) out.push([a[0] + s * u[0], a[1] + s * u[1]]); };
  if (e.type === 'line') { push(rayIntersectSeg(a, u, e.p1, e.p2)); }
  else if (e.type === 'polyline') { for (const [p, q] of entSegsFlat(e)) push(rayIntersectSeg(a, u, p, q)); }
  else if (e.type === 'rect') {
    const c = rectCornersOf(e);
    for (const [p, q] of [[c[0], c[1]], [c[1], c[2]], [c[2], c[3]], [c[3], c[0]]]) push(rayIntersectSeg(a, u, p, q));
  } else if (e.type === 'circle' || e.type === 'arc') {
    const fx = a[0] - e.c[0], fy = a[1] - e.c[1];
    const bq = 2 * (fx * u[0] + fy * u[1]);
    const cq = fx * fx + fy * fy - e.r * e.r;
    const disc = bq * bq - 4 * cq;
    if (disc >= 0) {
      for (const sol of [(-bq - Math.sqrt(disc)) / 2, (-bq + Math.sqrt(disc)) / 2]) {
        const pt = [a[0] + sol * u[0], a[1] + sol * u[1]];
        if (e.type === 'arc' && !angleInArc(rad(deg(Math.atan2(pt[1] - e.c[1], pt[0] - e.c[0]))), e.a0, e.a1)) continue;
        push(sol);
      }
    }
  }
}
function boundaryCandidates(excludeIds) {
  return state.doc.entities.filter(e =>
    !excludeIds.has(e.id) &&
    (e.type === 'line' || e.type === 'polyline' || e.type === 'circle' || e.type === 'rect' || e.type === 'arc'));
}
function nearestSegOn(ent, nearWorld) {
  const segs = entSegsFlat(ent);
  let seg = null, bd = Infinity;
  for (const [a, b] of segs) {
    const d = Math.min(dist2(a, nearWorld), dist2(b, nearWorld), segPointDist2(a, b, nearWorld));
    if (d < bd) { bd = d; seg = [a, b]; }
  }
  return seg;
}
function segPointDist2(a, b, p) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2v = dx * dx + dy * dy || 1;
  let tt = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2v;
  tt = Math.max(0, Math.min(1, tt));
  return (p[0] - (a[0] + tt * dx)) ** 2 + (p[1] - (a[1] + tt * dy)) ** 2;
}
function endpointNear(ent, nearWorld) {
  if (ent.type === 'line') {
    const d1 = dist2(ent.p1, nearWorld), d2 = dist2(ent.p2, nearWorld);
    return d1 <= d2 ? ent.p1 : ent.p2;
  }
  const p0 = ent.pts[0], p1 = ent.pts[ent.pts.length - 1];
  return dist2(p0, nearWorld) <= dist2(p1, nearWorld) ? p0 : p1;
}
function otherEndpoint(ent, end) {
  if (ent.type === 'line') return end === ent.p1 ? ent.p2 : ent.p1;
  return end === ent.pts[0] ? ent.pts[ent.pts.length - 1] : ent.pts[0];
}
/* BREAK: split an entity into two independent entities at the picked point.
   line -> two collinear lines; polyline -> two polylines; arc -> two arcs.
   Returns { parts: [a, b] } or null. No-op for circle/rect/text/dim (prompt). */
function breakGeom(hit, p) {
  if (hit.type === 'line') {
    if (dist2(hit.p1, p) < 1e-9 || dist2(hit.p2, p) < 1e-9) return null; // no split at an endpoint
    const a = { type: 'line', layer: hit.layer, p1: [hit.p1[0], hit.p1[1]], p2: [p[0], p[1]] };
    const b = { type: 'line', layer: hit.layer, p1: [p[0], p[1]], p2: [hit.p2[0], hit.p2[1]] };
    return { parts: [a, b] };
  }
  if (hit.type === 'polyline') {
    let bi = -1, bd = Infinity;
    for (let i = 0; i < hit.pts.length - 1; i++) {
      const d = segPointDist2(hit.pts[i], hit.pts[i + 1], p);
      if (d < bd) { bd = d; bi = i; }
    }
    if (bi < 0) return null;
    const cut = [p[0], p[1]];
    if (dist2(hit.pts[bi], cut) < 1e-9 || dist2(hit.pts[bi + 1], cut) < 1e-9) return null;
    const a = { type: 'polyline', layer: hit.layer, pts: hit.pts.slice(0, bi + 1).map(q => [q[0], q[1]]).concat([cut]) };
    const b = { type: 'polyline', layer: hit.layer, pts: [cut].concat(hit.pts.slice(bi + 1).map(q => [q[0], q[1]])) };
    return { parts: [a, b] };
  }
  if (hit.type === 'arc') {
    const aDeg = ((deg(Math.atan2(p[1] - hit.c[1], p[0] - hit.c[0])) % 360) + 360) % 360;
    if (!angleInArc(rad(aDeg), hit.a0, hit.a1)) return null; // click on the arc body, not the gap
    let mid = aDeg;
    if (Math.abs(mid - hit.a0) < 1e-6 || Math.abs(mid - hit.a1) < 1e-6) return null;
    const A = { type: 'arc', layer: hit.layer, c: [hit.c[0], hit.c[1]], r: hit.r, a0: hit.a0, a1: mid };
    const B = { type: 'arc', layer: hit.layer, c: [hit.c[0], hit.c[1]], r: hit.r, a0: mid, a1: hit.a1 };
    return { parts: [A, B] };
  }
  return null; // circle: no-op (prompts), same for rect/text/dim
}
/* TRIM: keep the clicked-side run of the picked segment up to the nearest crossing.
   Returns { cut, other } or null. */
function trimGeom(hit, nearWorld) {
  if (hit.type === 'polyline' && hit.pts.length !== 2) return null;
  const seg = nearestSegOn(hit, nearWorld);
  if (!seg) return null;
  const [a, b] = seg;
  const isects = [];
  const bnd = state.trimPick && state.trimPick.id !== hit.id
    ? state.doc.entities.filter(e => e.id === state.trimPick.id)
    : boundaryCandidates(new Set([hit.id]));
  for (const e of bnd) lineEntIsects(a, b, e, isects);
  if (!isects.length) return null;
  const clickT = projT(a, b, nearWorld);
  let best = null;
  for (const pt of isects) {
    const t = projT(a, b, pt);
    if (Math.abs(t - clickT) < 1e-7) continue;
    const d = Math.abs(t - clickT);
    if (!best || d < best.d) best = { pt, t, d };
  }
  if (!best) return null;
  return { cut: best.pt, other: best.other, seg, clickT: clickT };
}
function applyTrim(hit, nearWorld) {
  const res = trimGeom(hit, nearWorld);
  if (!res) return null;
  const end = endpointNear(hit, nearWorld);
  const cut = res.cut;
  if (dist2(end, cut) < 1e-9) return null;
  const keep = { type: 'line', layer: hit.layer, p1: [end[0], end[1]], p2: [cut[0], cut[1]] };
  return { remove: hit, add: keep, other: res.other, cut, keptEnd: [end[0], end[1]] };
}
/* EXTEND: stretch the picked endpoint to the nearest boundary along its own direction. */
function extendGeom(hit, nearWorld) {
  if (hit.type === 'polyline' && hit.pts.length !== 2) return null;
  const moving = endpointNear(hit, nearWorld);
  const anchor = otherEndpoint(hit, moving);
  const du = [moving[0] - anchor[0], moving[1] - anchor[1]];
  const len = Math.hypot(du[0], du[1]) || 1;
  if (len < 1e-9) return null;
  const u = [du[0] / len, du[1] / len];
  let best = null;
  for (const e of boundaryCandidates(new Set([hit.id]))) {
    for (const pt of rayEntIsects(anchor, u, e)) {
      const s = (pt[0] - anchor[0]) * u[0] + (pt[1] - anchor[1]) * u[1];
      if (s <= len + 1e-7) continue;
      if (!best || s < best.s) best = { pt, s, other: e };
    }
  }
  if (!best) return null;
  return { moving: [moving[0], moving[1]], anchor: [anchor[0], anchor[1]], newEnd: best.pt, other: best.other };
}
function rayEntIsects(pa, u, e) {
  const out = [];
  if (e.type === 'line') { const s = rayIntersectSeg(pa, u, e.p1, e.p2); if (s !== null) out.push([pa[0] + s * u[0], pa[1] + s * u[1]]); }
  else if (e.type === 'polyline') { for (const [p, q] of entSegsFlat(e)) { const s = rayIntersectSeg(pa, u, p, q); if (s !== null) out.push([pa[0] + s * u[0], pa[1] + s * u[1]]); } }
  else if (e.type === 'rect') {
    const c = rectCornersOf(e);
    for (const [p, q] of [[c[0], c[1]], [c[1], c[2]], [c[2], c[3]], [c[3], c[0]]]) { const s = rayIntersectSeg(pa, u, p, q); if (s !== null) out.push([pa[0] + s * u[0], pa[1] + s * u[1]]); }
  } else if (e.type === 'circle' || e.type === 'arc') {
    const fx = pa[0] - e.c[0], fy = pa[1] - e.c[1];
    const bq = 2 * (fx * u[0] + fy * u[1]);
    const cq = fx * fx + fy * fy - e.r * e.r;
    const disc = bq * bq - 4 * cq;
    if (disc >= 0) {
      for (const sol of [(-bq - Math.sqrt(disc)) / 2, (-bq + Math.sqrt(disc)) / 2]) {
        const pt = [pa[0] + sol * u[0], pa[1] + sol * u[1]];
        if (e.type === 'arc' && !angleInArc(rad(deg(Math.atan2(pt[1] - e.c[1], pt[0] - e.c[0]))), e.a0, e.a1)) continue;
        out.push(pt);
      }
    }
  }
  return out;
}
function applyExtend(hit, nearWorld) {
  const res = extendGeom(hit, nearWorld);
  if (!res) return null;
  const ent = hit;
  if (ent.type === 'line') {
    if (ent.p1 === res.moving || dist2(ent.p1, res.moving) < dist2(ent.p2, res.moving)) ent.p1 = [res.newEnd[0], res.newEnd[1]];
    else ent.p2 = [res.newEnd[0], res.newEnd[1]];
  } else {
    const i = dist2(ent.pts[0], res.moving) <= dist2(ent.pts[ent.pts.length - 1], res.moving) ? 0 : ent.pts.length - 1;
    ent.pts[i] = [res.newEnd[0], res.newEnd[1]];
  }
  return { other: res.other, newEnd: res.newEnd };
}

function keyEscape() {
  state.pending = [];
  state.preview = null;
  state.phase = null;
  state.drag = null;
  state.rubber = null;
  if (state.tool !== 'select') setTool('select');
  else { state.sel.clear(); renderAll(); }
  setPrompt('Ready');
  draw();
}

function setCommandGuide(open) {
  const panel = document.getElementById('commandGuide');
  const button = document.getElementById('btnCommandGuide');
  if (!panel || !button) return;
  const visible = Boolean(open);
  const wasVisible = panel.classList.contains('show');
  panel.classList.toggle('show', visible);
  panel.setAttribute('aria-hidden', String(!visible));
  button.setAttribute('aria-expanded', String(visible));
  if (visible) document.getElementById('guideSearch').focus();
  else if (wasVisible) button.focus();
}

window.addEventListener('keydown', (ev) => {
  const guide = document.getElementById('commandGuide');
  const guideOpen = guide && guide.classList.contains('show');
  if (guideOpen && ev.key === 'Escape') { ev.preventDefault(); setCommandGuide(false); return; }
  if (guideOpen && ev.target.id !== 'guideSearch') return;
  const tag = (ev.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea';
  if (ev.key === ' ') {
    if (!typing) { spaceDown = true; cv.classList.add('grab'); }
  }
  if (typing) {
    if (ev.key === 'Escape') ev.target.blur();
    return;
  }
  if (ev.key === '?' || (ev.shiftKey && ev.key === '/')) { ev.preventDefault(); setCommandGuide(true); return; }
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && ev.key.toLowerCase() === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
  if (mod && ev.key.toLowerCase() === 'y') { ev.preventDefault(); redo(); return; }
  if (mod && ev.key.toLowerCase() === 'a') { ev.preventDefault(); state.sel = new Set(state.doc.entities.map(e => e.id)); renderAll(); return; }
  if (mod && ev.key.toLowerCase() === 's') { ev.preventDefault(); saveDrawing(); return; }
  if (mod && ev.key.toLowerCase() === 'c') { ev.preventDefault(); copySelection(); return; }
  if (mod && ev.key.toLowerCase() === 'v') { ev.preventDefault(); pasteSelection(); return; }
  if (ev.shiftKey && ev.key.toLowerCase() === 'x') { ev.preventDefault(); mirrorSelection('x', true); return; }
  if (ev.shiftKey && ev.key.toLowerCase() === 'y') { ev.preventDefault(); mirrorSelection('y', true); return; }
  if (ev.shiftKey && ev.key.toLowerCase() === 'a') { ev.preventDefault(); arraySelection(); return; }
  if (ev.shiftKey && ev.key.toLowerCase() === 'p') { ev.preventDefault(); polarArrayDialog(); return; }

  if (ev.key === 'Enter') { ev.preventDefault(); keyEnter(); return; }
  if (ev.key === 'Escape') { ev.preventDefault(); keyEscape(); return; }
  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    ev.preventDefault();
    // vertex-edit mode: delete the active vertex (allow down to 2 points = still a line)
    if (state.tool === 'vertex' && state.vertexEnt && state.vertexIdx != null) {
      const ent = state.doc.entities.find(e => e.id === state.vertexEnt && e.type === 'polyline');
      if (ent && ent.pts.length > 2) {
        pushUndo();
        ent.pts.splice(state.vertexIdx, 1);
        state.vertexIdx = null;
        state.dirty = true; markDirty(); renderAll();
        setPrompt('Vertex deleted (' + ent.pts.length + ' left) — minimum is 2 (a straight line)');
      } else if (ent) {
        setPrompt('Cannot delete: a polyline keeps at least 2 vertices (delete the entity with Erase instead)');
      }
      return;
    }
    deleteSelection();
    return;
  }
  if (ev.key === 'F3') { ev.preventDefault(); toggle('osnap', 'tgSnap'); return; }
  if (ev.key === 'F7') { ev.preventDefault(); toggle('showGrid', 'tgGrid'); return; }
  if (ev.key === 'F8') { ev.preventDefault(); toggle('ortho', 'tgOrtho'); return; }
  if (ev.key === 'F10') { ev.preventDefault(); toggle('polar', 'tgPolar'); return; }
  if (ev.key === 'F9') { ev.preventDefault(); toggle('gridSnap', 'tgGridSnap'); return; }

  // classic CAD feel: start typing a number while a point tool is active -> grab it into the command bar
  if (ev.key.length === 1 && /[\d.,\-@<+]/.test(ev.key) && PT_TOOLS.includes(state.tool)) {
    cmdInput.value = ev.key;
    cmdInput.focus();
    ev.preventDefault();
    return;
  }

  const k = ev.key.toLowerCase();
  const map = { v: 'select', l: 'line', p: 'polyline', r: 'rect', c: 'circle', a: 'arc',
                t: 'text', d: 'dim', u: 'measure', m: 'move', e: 'erase', o: 'rotate', q: 'vertex', b: 'break' };
  if (k === 'f' && !mod) { ev.preventDefault(); fitView(); return; }
  if (map[k] && !ev.altKey) { ev.preventDefault(); setTool(map[k]); }
});

window.addEventListener('keyup', (ev) => {
  if (ev.key === ' ') { spaceDown = false; if (!panning) cv.classList.remove('grab'); }
});

function toggle(prop, btnId) {
  state[prop] = !state[prop];
  document.getElementById(btnId).classList.toggle('on', state[prop]);
  if (prop === 'showGrid') draw();
  if (prop === 'ortho' || prop === 'polar' || prop === 'gridSnap' || prop === 'osnap') {
    // guide line must clear immediately, even mid-drag, when toggled off
    if (state.mouseWorld) snapPoint(state.mouseWorld); // refresh snap/ortho state before redraw
    draw();
    if (prop === 'ortho') setPrompt(state.ortho ? 'Ortho on — draw/move locked to horizontal/vertical (F8 to toggle)'
                                                : 'Ready');
    else if (prop === 'polar') setPrompt(state.polar ? 'Polar on — angles snap to 45° steps (F10 to toggle)'
                                                     : 'Ready');
    else setPrompt('Ready');
  }
}

/* ---------- edit ops ---------- */
function deleteSelection() {
  if (!state.sel.size) return;
  pushUndo();
  const n = state.sel.size;
  state.doc.entities = state.doc.entities.filter(e => !state.sel.has(e.id));
  state.sel.clear();
  state.dirty = true; markDirty(); renderAll();
  setPrompt('Deleted ' + n + ' object(s)');
}

function copySelection() {
  if (!state.sel.size) return;
  state.clipboard = state.doc.entities.filter(e => state.sel.has(e.id)).map(e => JSON.parse(JSON.stringify(e)));
  toast('Copied ' + state.clipboard.length + ' object(s)');
}

function pasteSelection() {
  if (!state.clipboard || !state.clipboard.length) return;
  pushUndo();
  const copies = state.clipboard.map(e => { const c = JSON.parse(JSON.stringify(e)); c.id = newId(); return c; });
  applyTranslate(copies, [20, -20]);
  state.doc.entities.push(...copies);
  state.sel = new Set(copies.map(c => c.id));
  state.dirty = true; markDirty(); renderAll();
  setPrompt('Pasted ' + copies.length + ' object(s)');
}


/* ---------- rectangular array ---------- */
function arraySelection() {
  const ents = state.doc.entities.filter(e => state.sel.has(e.id) && !lockedLayer(e.layer));
  if (!ents.length) { toast('Select objects to array first'); return; }
  document.getElementById('arrRows').value = '2';
  document.getElementById('arrCols').value = '2';
  document.getElementById('arrDx').value = '';
  document.getElementById('arrDy').value = '';
  document.getElementById('arrayModal').classList.add('show');
  document.getElementById('arrRows').focus();
}
function closeArrayModal() { document.getElementById('arrayModal').classList.remove('show'); }
function arrayApply() {
  const rows = Math.max(1, Math.floor(parseFloat(document.getElementById('arrRows').value) || 1));
  const cols = Math.max(1, Math.floor(parseFloat(document.getElementById('arrCols').value) || 1));
  const dx = parseFloat(document.getElementById('arrDx').value);
  const dy = parseFloat(document.getElementById('arrDy').value);
  closeArrayModal();
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) { toast('Enter a spacing for X or Y'); return; }
  const ents = state.doc.entities.filter(e => state.sel.has(e.id) && !lockedLayer(e.layer));
  if (!ents.length) { toast('Select objects to array first'); return; }
  if (rows * cols - 1 > 2000) { toast('Array too large (max 2000 copies)'); return; }
  pushUndo();
  const copies = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r === 0 && c === 0) continue;
      const offs = state.doc.entities.filter(e => state.sel.has(e.id) && !lockedLayer(e.layer)).map(e => {
        const k = JSON.parse(JSON.stringify(e)); k.id = newId(); return k;
      });
      applyTranslate(offs, [dx * c, dy * r]);
      copies.push(...offs);
    }
  }
  state.doc.entities.push(...copies);
  state.sel = new Set(copies.map(c => c.id));
  state.dirty = true; markDirty(); renderAll();
  setPrompt('Arrayed ' + ents.length + ' object(s) into ' + rows + 'x' + cols);
}
document.getElementById('arrCancel').onclick = closeArrayModal;
document.getElementById('arrOk').onclick = arrayApply;
document.getElementById('arrayModal').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') arrayApply();
  if (ev.key === 'Escape') closeArrayModal();
});

/* ---------- polar array ---------- */
function polarArrayDialog() {
  const ents = state.doc.entities.filter(e => state.sel.has(e.id) && !lockedLayer(e.layer));
  if (!ents.length) { toast('Select objects to array first'); return; }
  document.getElementById('polCount').value = '6';
  document.getElementById('polAngle').value = '';
  document.getElementById('polarModal').classList.add('show');
  document.getElementById('polCount').focus();
}
function closePolarModal() { document.getElementById('polarModal').classList.remove('show'); }

function closePrintModal() { document.getElementById('printModal').classList.remove('show'); }
document.getElementById('printClose').onclick = closePrintModal;
document.getElementById('printCancel').onclick = closePrintModal;
document.getElementById('printGo').onclick = () => { closePrintModal(); openPrintWindow(); };
document.getElementById('printModal').onclick = (ev) => { if (ev.target.id === 'printModal') closePrintModal(); };
function polarArrayApply() {
  const count = Math.floor(parseFloat(document.getElementById('polCount').value));
  let step = parseFloat(document.getElementById('polAngle').value);
  closePolarModal();
  const ents = state.doc.entities.filter(e => state.sel.has(e.id) && !lockedLayer(e.layer));
  if (!ents.length) { toast('Select objects to array first'); return; }
  if (!Number.isFinite(count) || count < 2) { toast('Number of items must be at least 2'); return; }
  const full = !Number.isFinite(step);
  if (full) step = 360 / count;
  if (!Number.isFinite(step) || step === 0) { toast('Angle step must be a non-zero number'); return; }
  if ((count - 1) * ents.length > 2000) { toast('Array too large (max 2000 copies)'); return; }
  const ex = extentsOf(ents);
  const at = [(ex.x0 + ex.x1) / 2, (ex.y0 + ex.y1) / 2];
  pushUndo();
  const copies = [];
  for (let i = 1; i < count; i++) {
    const offs = ents.map(e => { const k = JSON.parse(JSON.stringify(e)); k.id = newId(); return k; });
    applyRotate(offs, at, step * i * Math.PI / 180);
    copies.push(...offs);
  }
  state.doc.entities.push(...copies);
  state.sel = new Set(copies.map(c => c.id));
  state.dirty = true; markDirty(); renderAll();
  setPrompt('Polar arrayed ' + ents.length + ' object(s) x' + count + ' step ' + (full ? '(auto)' : step + '°'));
}
document.getElementById('polCancel').onclick = closePolarModal;
document.getElementById('polOk').onclick = polarArrayApply;
document.getElementById('polarModal').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') polarArrayApply();
  if (ev.key === 'Escape') closePolarModal();
});

function mirrorSelection(mode, keepOriginal) {
  const ents = state.doc.entities.filter(e => state.sel.has(e.id) && !lockedLayer(e.layer));
  if (!ents.length) { toast('Select objects to mirror first'); return; }
  const ex = extentsOf(ents);
  const at = [(ex.x0 + ex.x1) / 2, (ex.y0 + ex.y1) / 2];
  pushUndo();
  let mirrored = ents;
  if (keepOriginal) {
    // Mirror copies: keep originals, add mirrored duplicates with fresh ids.
    mirrored = ents.map(e => { const c = JSON.parse(JSON.stringify(e)); c.id = newId(); return c; });
    state.doc.entities.push(...mirrored);
    state.sel = new Set(mirrored.map(m => m.id));
    applyMirror(mirrored, mode, at);
  } else {
    applyMirror(ents, mode, at);
  }
  state.dirty = true; markDirty(); renderAll();
  setPrompt((keepOriginal ? 'Mirror-copied ' : 'Mirrored ') + ents.length + ' object(s) ' + (mode === 'x' ? 'horizontally' : 'vertically') + (keepOriginal ? ' (originals kept)' : ''));
}

/* ---------- view ---------- */
function zoomExtents(ents) {
  const list = ents || state.doc.entities;
  const ex = extentsOf(list);
  if (!ex) { state.view = { x: 0, y: 0, zoom: 1 }; draw(); return; }
  const w = Math.max(1, ex.x1 - ex.x0), h = Math.max(1, ex.y1 - ex.y0);
  const z = Math.min(cvW() / (w * 1.22), cvH() / (h * 1.22));
  state.view.zoom = Math.max(0.02, Math.min(60, z));
  state.view.x = (ex.x0 + ex.x1) / 2;
  state.view.y = (ex.y0 + ex.y1) / 2;
  draw();
  // status readout derived from the same render transform
  setPrompt((ents ? 'Zoomed to selection' : 'Zoomed to extents') + ' — ' + Math.round(state.view.zoom * 100) + '%');
}

/* Fit view to current selection, or to all content when nothing is selected. */
function fitView() {
  if (state.sel && state.sel.size) {
    const picked = state.doc.entities.filter(e => state.sel.has(e.id));
    if (picked.length) { zoomExtents(picked); return; }
  }
  zoomExtents();
}

/* ---------- text modal ---------- */
let textAnchor = null;
function openTextModal() {
  textAnchor = state.pending[0];
  document.getElementById('textInput').value = '';
  document.getElementById('textModal').classList.add('show');
  setTimeout(() => document.getElementById('textInput').focus(), 30);
}
function closeTextModal() {
  document.getElementById('textModal').classList.remove('show');
}
document.getElementById('textCancel').onclick = () => { closeTextModal(); state.pending = []; };
document.getElementById('textOk').onclick = () => {
  const v = document.getElementById('textInput').value.trim();
  closeTextModal();
  if (v && textAnchor) {
    commitEntity({ type: 'text', layer: state.doc.currentLayer, p: textAnchor, text: v, size: 26 });
    setPrompt('Text placed');
  }
  state.pending = [];
};
document.getElementById('textInput').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') document.getElementById('textOk').click();
  if (ev.key === 'Escape') document.getElementById('textCancel').click();
});

/* ===================== persistence, export & UI wiring ===================== */

const LAYER_COLORS = ['#d9dee7', '#7fd1ff', '#ffb454', '#a6e3a1', '#f38ba8', '#cba6f7', '#94e2d5', '#fab387'];

let saveTimer = null;

function pill() { return document.getElementById('savePill'); }

function markDirty() {
  state.dirty = true;
  const p = pill();
  if (p) { p.textContent = 'unsaved'; p.className = 'status-pill dirty'; }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveDrawing(true); }, 2500);
}

function docName() {
  const el = document.getElementById('docName');
  return (el && el.value.trim()) || 'Untitled Drawing';
}

function download(filename, content, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function slug() {
  return docName().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'drawing';
}

function docPayload() {
  return {
    name: docName(),
    data: {
      layers: state.doc.layers,
      entities: state.doc.entities,
      currentLayer: state.doc.currentLayer,
      underlay: state.doc.underlay || null,
    },
  };
}

async function saveDrawing(auto) {
  if (!state.doc) return null;
  const p = pill();
  if (p) { p.textContent = 'saving\\u2026'; p.className = 'status-pill saving'; }
  try {
    const body = JSON.stringify(docPayload());
    let res = null;
    if (state.drawingId) {
      res = await fetch('/api/drawings/' + encodeURIComponent(state.drawingId), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: body,
      });
      if (res.status === 404 || res.status === 403) state.drawingId = null;
    }
    if (!state.drawingId) {
      res = await fetch('/api/drawings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body,
      });
    }
    if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : 'n/a'));
    const json = await res.json();
    if (json.drawing && json.drawing.id) state.drawingId = json.drawing.id;
    state.dirty = false;
    if (p) { p.textContent = 'saved'; p.className = 'status-pill'; }
    if (!auto) toast('Saved "' + docName() + '"');
    return state.drawingId;
  } catch (err) {
    if (p) { p.textContent = 'offline'; p.className = 'status-pill dirty'; }
    if (!auto) toast('Save failed - ' + (err && err.message ? err.message : err));
    return null;
  }
}

function loadDoc(data, id, name) {
  state.doc = {
    layers: (data && data.layers && data.layers.length) ? data.layers : emptyDoc().layers,
    entities: (data && Array.isArray(data.entities)) ? data.entities : [],
    currentLayer: (data && data.currentLayer) || 'Walls',
    underlay: (data && data.underlay) ? data.underlay : null,
  };
  if (state.doc.underlay) ensureUnderlayImage(state.doc.underlay);
  state.drawingId = id || null;
  state.sel.clear();
  state.undo.length = 0;
  state.redo.length = 0;
  state.pending = [];
  state.preview = null;
  state.dirty = false;
  const nm = document.getElementById('docName');
  if (nm) nm.value = name || 'Untitled Drawing';
  const p = pill();
  if (p) { p.textContent = 'saved'; p.className = 'status-pill'; }
  renderAll();
  try { zoomExtents(); } catch (e) { draw(); }
}

function closeOpen() {
  document.getElementById('openModal').classList.remove('show');
}

async function openDrawing(id) {
  try {
    const res = await fetch('/api/drawings/' + encodeURIComponent(id));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const d = json.drawing;
    loadDoc(d.data, d.id, d.name);
    history.replaceState(null, '', '/d/' + d.id);
    closeOpen();
    toast('Opened "' + d.name + '"');
  } catch (err) {
    toast('Open failed - ' + (err && err.message ? err.message : err));
  }
}

function fmtDate(s) {
  try {
    const d = new Date(s);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
           d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch (e) { return ''; }
}

async function showOpen() {
  const modal = document.getElementById('openModal');
  const box = document.getElementById('drawingList');
  modal.classList.add('show');
  box.innerHTML = '<div class="empty">Loading\\u2026</div>';
  try {
    const res = await fetch('/api/drawings');
    const json = await res.json();
    const list = (json && json.drawings) || [];
    if (!list.length) {
      const hint = currentUser
        ? 'No saved drawings yet - hit Save to create one.'
        : 'No saved drawings yet. Sign in to keep drawings on your own account.';
      box.innerHTML = '<div class="empty">' + hint + '</div>';
      return;
    }
    box.innerHTML = '';
    for (const d of list) {
      const row = document.createElement('div');
      row.className = 'drawing-row';
      row.innerHTML = '<div class="dr-main"><strong>' + esc(d.name) + '</strong>' +
        '<span class="dr-meta">' + (d.entity_count || 0) + ' objects / rev ' + d.rev + ' / ' +
        esc(fmtDate(d.updated_at)) + (d.owner ? ' / ' + esc(d.owner) : '') + '</span></div>';
      const open = document.createElement('button');
      open.className = 'mb accent'; open.textContent = 'Open';
      open.onclick = () => openDrawing(d.id);
      const share = document.createElement('button');
      share.className = 'mb'; share.textContent = 'Share'; share.title = 'Copy a read-only link';
      share.onclick = () => copyShareLink(d.id);
      const del = document.createElement('button');
      del.className = 'mb'; del.textContent = '\\u2715'; del.title = 'Delete';
      del.onclick = async () => {
        if (state.drawingId === d.id && !confirm('Delete the drawing that is currently open?')) return;
        await fetch('/api/drawings/' + encodeURIComponent(d.id), { method: 'DELETE' });
        if (state.drawingId === d.id) state.drawingId = null;
        showOpen();
      };
      const dup = document.createElement('button');
      dup.className = 'mb'; dup.textContent = 'Duplicate'; dup.title = 'Create a copy of this drawing';
      dup.onclick = async () => {
        if (dup.dataset.busy === '1') return; // idempotency guard: ignore extra clicks while in flight
        dup.dataset.busy = '1';
        dup.disabled = true;
        const label = dup.textContent;
        dup.textContent = 'Duplicating\u2026';
        try {
          const res = await fetch('/api/drawings/' + encodeURIComponent(d.id) + '/duplicate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
          });
          if (res.status === 401) { toast('Sign in to duplicate drawings'); return; }
          if (!res.ok) throw new Error('HTTP ' + res.status);
          showOpen();
          toast('Duplicated "' + d.name + '"');
        } catch (err) {
          toast('Duplicate failed - ' + (err && err.message ? err.message : err));
        } finally {
          dup.dataset.busy = '0';
          dup.disabled = false;
          dup.textContent = label;
        }
      };
      row.append(open, share, dup, del);
      box.appendChild(row);
    }
  } catch (err) {
    box.innerHTML = '<div class="empty">Could not load drawings: ' + esc(String(err.message || err)) + '</div>';
  }
}

async function newDrawing() {
  if (state.dirty && !confirm('Discard unsaved changes and start a new drawing?')) return;
  loadDoc(emptyDoc(), null, 'Untitled Drawing');
  history.replaceState(null, '', '/');
  setPrompt('New drawing - pick a tool to start');
  toast('New drawing');
}

// Read-only share link: the token grants view access, never edit access.
async function createShareLink(id) {
  const res = await fetch('/api/drawings/' + encodeURIComponent(id) + '/share', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
  });
  if (res.status === 401) { toast('Sign in to create a share link'); return null; }
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) {}
    toast('Share failed - ' + msg);
    return null;
  }
  const json = await res.json();
  return location.origin + (json.share_path || '/s/' + json.share_token);
}

async function copyShareLink(id) {
  const url = await createShareLink(id);
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    toast('Read-only link copied: ' + url);
  } catch (e) {
    window.prompt('Read-only share link (anyone with it can view):', url);
  }
  return url;
}

async function shareDrawing() {
  let id = state.drawingId;
  if (!id || state.dirty) id = await saveDrawing(true);
  if (!id) { toast('Save failed, cannot share'); return; }
  history.replaceState(null, '', '/d/' + id);
  await copyShareLink(id);
}

/* ---------- exporters ---------- */
function exportJSON() {
  const body = Object.assign({ format: 'WebCAD', version: 1, name: docName() }, docPayload().data);
  download(slug() + '.json', JSON.stringify(body, null, 2), 'application/json');
  toast('Exported JSON');
}

function buildSVGString(bg) {
  const ex = extentsOf(state.doc.entities) || { x0: 0, y0: 0, x1: 100, y1: 100 };
  const pad = Math.max(10, Math.max(ex.x1 - ex.x0, ex.y1 - ex.y0) * 0.04);
  const w = (ex.x1 - ex.x0) + pad * 2, h = (ex.y1 - ex.y0) + pad * 2;
  const X = (x) => +(x - ex.x0 + pad).toFixed(3);
  const Y = (y) => +(ex.y1 - y + pad).toFixed(3);
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + w.toFixed(2) + '" height="' + h.toFixed(2) +
           '" viewBox="0 0 ' + w.toFixed(2) + ' ' + h.toFixed(2) + '">');
  out.push('<rect width="100%" height="100%" fill="' + bg + '"/>');
  for (const e of state.doc.entities) {
    const L = layerOf(e.layer);
    if (!L || !L.visible) continue;
    const col = L.color, lw = (L.lineweight || 1);
    if (e.type === 'line') {
      out.push('<line x1="' + X(e.p1[0]) + '" y1="' + Y(e.p1[1]) + '" x2="' + X(e.p2[0]) + '" y2="' + Y(e.p2[1]) +
               '" stroke="' + col + '" stroke-width="' + lw + '"/>');
    } else if (e.type === 'polyline') {
      const pts = e.pts.map(p => X(p[0]) + ',' + Y(p[1])).join(' ');
      out.push('<polyline points="' + pts + '" fill="none" stroke="' + col + '" stroke-width="' + lw + '"/>');
    } else if (e.type === 'rect') {
      const x = X(Math.min(e.p1[0], e.p2[0])), y = Y(Math.max(e.p1[1], e.p2[1]));
      out.push('<rect x="' + x + '" y="' + y + '" width="' + Math.abs(e.p2[0] - e.p1[0]) + '" height="' +
               Math.abs(e.p2[1] - e.p1[1]) + '" fill="none" stroke="' + col + '" stroke-width="' + lw + '"/>');
    } else if (e.type === 'circle') {
      out.push('<circle cx="' + X(e.c[0]) + '" cy="' + Y(e.c[1]) + '" r="' + e.r + '" fill="none" stroke="' + col +
               '" stroke-width="' + lw + '"/>');
    } else if (e.type === 'arc') {
      let sweep = e.a1 - e.a0; while (sweep <= 0) sweep += 360;
      const a0 = rad(e.a0), a1 = rad(e.a0 + sweep);
      const sx = X(e.c[0] + e.r * Math.cos(a0)), sy = Y(e.c[1] + e.r * Math.sin(a0));
      const exx = X(e.c[0] + e.r * Math.cos(a1)), eyy = Y(e.c[1] + e.r * Math.sin(a1));
      const large = sweep > 180 ? 1 : 0;
      out.push('<path d="M ' + sx + ' ' + sy + ' A ' + e.r + ' ' + e.r + ' 0 ' + large + ' 0 ' + exx + ' ' + eyy +
               '" fill="none" stroke="' + col + '" stroke-width="' + lw + '"/>');
    } else if (e.type === 'text') {
      out.push('<text x="' + X(e.p[0]) + '" y="' + Y(e.p[1]) + '" fill="' + col +
               '" font-family="Inter, sans-serif" font-size="' + (e.size || 20) + '" font-weight="600">' +
               esc(e.text) + '</text>');
    } else if (e.type === 'dim') {
      const g = dimGeom(e);
      for (const seg of g.lines) {
        out.push('<line x1="' + X(seg[0][0]) + '" y1="' + Y(seg[0][1]) + '" x2="' + X(seg[1][0]) + '" y2="' +
                 Y(seg[1][1]) + '" stroke="' + col + '" stroke-width="' + lw + '"/>');
      }
      const m = mid(g.a, g.b);
      out.push('<text x="' + X(m[0]) + '" y="' + Y(m[1]) + '" fill="' + col +
               '" font-family="monospace" font-size="11" text-anchor="middle">' + esc(g.txt) + '</text>');
    }
  }
  out.push('</svg>');
  return { svg: out.join('\n'), w: w, h: h, ex: ex };
}

function exportSVG() {
  const r = buildSVGString('#0b1017');
  download(slug() + '.svg', r.svg, 'image/svg+xml');
  toast('Exported SVG');
}

function dxfLine(a, b, layer) {
  return ['0', 'LINE', '8', layer, '10', a[0].toFixed(4), '20', (-a[1]).toFixed(4),
          '11', b[0].toFixed(4), '21', (-b[1]).toFixed(4)].join('\n');
}

function buildDXFExportPlan(units) {
  const insunits = units === 'mm' ? 4 : 1; // AutoCAD INSUNITS: millimeters=4, inches=1
  const unitLabel = insunits === 4 ? 'mm' : 'in';
  const out = [];
  const Ls = state.doc.layers;
  const exported = Object.create(null), omitted = Object.create(null);
  const add = (kind, pairs) => { out.push(pairs); exported[kind] = (exported[kind] || 0) + 1; };
  const omit = (kind) => { omitted[kind] = (omitted[kind] || 0) + 1; };
  out.push(['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', String(insunits), '0', 'ENDSEC'].join('\n'));
  out.push(['0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', String(Ls.length)].join('\n'));
  for (const l of Ls) out.push(['0', 'LAYER', '2', l.name, '70', '0', '62', '7', '6', 'CONTINUOUS'].join('\n'));
  out.push(['0', 'ENDTAB', '0', 'ENDSEC'].join('\n'));
  out.push(['0', 'SECTION', '2', 'ENTITIES'].join('\n'));
  for (const e of state.doc.entities) {
    const ly = e.layer || '0';
    if (e.type === 'dim') { omit('dimensions'); continue; }
    if (e.type === 'line') add('LINE', dxfLine(e.p1, e.p2, ly));
    else if (e.type === 'polyline') {
      for (let i = 0; i + 1 < e.pts.length; i++) add('LINE', dxfLine(e.pts[i], e.pts[i + 1], ly));
    } else if (e.type === 'rect') {
      const a = e.p1, b = e.p2;
      const pts = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
      for (let i = 0; i < 4; i++) add('LINE', dxfLine(pts[i], pts[(i + 1) % 4], ly));
    } else if (e.type === 'circle') {
      add('CIRCLE', ['0', 'CIRCLE', '8', ly, '10', e.c[0].toFixed(4), '20', (-e.c[1]).toFixed(4), '40', e.r.toFixed(4)].join('\n'));
    } else if (e.type === 'arc') {
      let s = e.a1 - e.a0; while (s <= 0) s += 360;
      add('ARC', ['0', 'ARC', '8', ly, '10', e.c[0].toFixed(4), '20', (-e.c[1]).toFixed(4), '40', e.r.toFixed(4), '50', (-(e.a0 + s)).toFixed(4), '51', (-e.a0).toFixed(4)].join('\n'));
    } else if (e.type === 'text') {
      add('TEXT', ['0', 'TEXT', '8', ly, '10', e.p[0].toFixed(4), '20', (-e.p[1]).toFixed(4), '40', (e.size || 20).toFixed(4), '1', String(e.text || '')].join('\n'));
    } else omit(e.type || 'unclassified');
  }
  out.push(['0', 'ENDSEC', '0', 'EOF'].join('\n'));
  const counts = (map) => Object.keys(map).sort().map(k => k + ': ' + map[k]).join(', ');
  const exportedCount = Object.values(exported).reduce((a, b) => a + b, 0);
  const omittedCount = Object.values(omitted).reduce((a, b) => a + b, 0);
  const underlayNote = state.doc.underlay
    ? 'Reference image underlay: omitted (raster tracing reference, not DXF geometry).'
    : null;
  const summary = [
    'Source units: unknown / unset',
    'Output units: ' + unitLabel,
    'Conversion: none — coordinate values exported as-is.',
    exportedCount ? 'Included DXF entities (' + exportedCount + '): ' + counts(exported) : 'Included DXF entities: none',
    omittedCount ? 'Omitted drawing objects (' + omittedCount + '): ' + counts(omitted) : 'Omitted drawing objects: none',
    underlayNote,
  ].filter(Boolean).join('\n');
  return { content: out.join('\n') + '\n', summary, exported, omitted, units: unitLabel };
}

function exportDXF() {
  const choice = window.prompt('DXF output units? Source units are unknown / unset. Coordinates will be exported as-is, without conversion. Enter mm or in.', 'mm');
  if (choice === null) return;
  const selected = String(choice).trim().toLowerCase();
  if (selected !== 'mm' && selected !== 'in' && selected !== 'inch' && selected !== 'inches') {
    toast('DXF export cancelled - choose mm or in');
    return;
  }
  const plan = buildDXFExportPlan(selected === 'mm' ? 'mm' : 'in');
  if (!window.confirm('DXF export review\n\n' + plan.summary + '\n\nExport this file?')) return;
  download(slug() + '.dxf', plan.content, 'application/dxf');
  toast('Exported DXF (ASCII, ' + plan.units + ')' +
    (Object.values(plan.omitted).reduce((a, b) => a + b, 0) ? ' — see export review for omissions' : ''));
}

function exportPNG() {
  const ex = extentsOf(state.doc.entities) || { x0: 0, y0: 0, x1: 100, y1: 100 };
  const pad = Math.max(12, Math.max(ex.x1 - ex.x0, ex.y1 - ex.y0) * 0.05);
  const wWorld = (ex.x1 - ex.x0) + pad * 2, hWorld = (ex.y1 - ex.y0) + pad * 2;
  const scale = Math.max(0.5, Math.min(8, 2000 / Math.max(wWorld, hWorld)));
  const W = Math.max(64, Math.round(wWorld * scale)), H = Math.max(64, Math.round(hWorld * scale));
  const c2 = document.createElement('canvas');
  c2.width = W; c2.height = H;
  const g = c2.getContext('2d');
  g.fillStyle = '#0b1017'; g.fillRect(0, 0, W, H);
  const ox = ex.x0 - pad, oy = ex.y1 + pad;
  const map = (p) => [(p[0] - ox) * scale, (oy - p[1]) * scale];
  g.lineCap = 'round'; g.lineJoin = 'round';
  for (const e of state.doc.entities) {
    const L = layerOf(e.layer);
    if (!L || !L.visible) continue;
    g.strokeStyle = L.color; g.fillStyle = L.color;
    g.lineWidth = Math.max(1, (L.lineweight || 1) * scale * 1.1);
    g.beginPath();
    if (e.type === 'line') {
      const a = map(e.p1), b = map(e.p2);
      g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
    } else if (e.type === 'polyline') {
      const a = map(e.pts[0]); g.moveTo(a[0], a[1]);
      for (let i = 1; i < e.pts.length; i++) { const b = map(e.pts[i]); g.lineTo(b[0], b[1]); }
      g.stroke();
    } else if (e.type === 'rect') {
      const a = map([Math.min(e.p1[0], e.p2[0]), Math.max(e.p1[1], e.p2[1])]);
      g.strokeRect(a[0], a[1], Math.abs(e.p2[0] - e.p1[0]) * scale, Math.abs(e.p2[1] - e.p1[1]) * scale);
    } else if (e.type === 'circle') {
      const c = map(e.c);
      g.arc(c[0], c[1], Math.max(0.5, e.r * scale), 0, TAU); g.stroke();
    } else if (e.type === 'arc') {
      const c = map(e.c);
      let s = e.a1 - e.a0; while (s <= 0) s += 360;
      g.arc(c[0], c[1], Math.max(0.5, e.r * scale), -rad(e.a0), -rad(e.a0 + s), true);
      g.stroke();
    } else if (e.type === 'text') {
      const p = map(e.p);
      const fs = Math.max(6, (e.size || 20) * scale);
      g.font = '600 ' + fs + 'px Inter, sans-serif';
      g.fillText(e.text, p[0], p[1] + fs * 0.16);
    } else if (e.type === 'dim') {
      const dg = dimGeom(e);
      g.lineWidth = 1;
      for (const seg of dg.lines) {
        const a = map(seg[0]), b = map(seg[1]);
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      }
      const m = map(mid(dg.a, dg.b));
      g.font = '600 11px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(dg.txt, m[0], m[1]);
      g.textAlign = 'start'; g.textBaseline = 'alphabetic';
    }
  }
  c2.toBlob((blob) => {
    if (!blob) { toast('PNG export failed'); return; }
    download(slug() + '.png', blob, 'image/png');
    toast('Exported PNG ' + W + 'x' + H);
  }, 'image/png');
}

const EXPORTERS = { svg: exportSVG, dxf: exportDXF, png: exportPNG, json: exportJSON, print: printSheetDialog };

/* ---------- print / PDF sheet (browser print view) ---------- */
const PAPER_MM = { a4: [210, 297], letter: [215.9, 279.4], a3: [297, 420] };

function readPrintOptions() {
  const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
  return {
    paper: val('printPaper') || 'a4',
    landscape: val('printOrient') === 'landscape',
    scaleMode: val('printScaleMode') === 'custom' ? 'custom' : 'fit',
    scalePct: Math.max(1, Math.min(10000, parseFloat(val('printScalePct')) || 100)),
    title: !document.getElementById('printTitle') || document.getElementById('printTitle').checked
  };
}

function printSheetDialog() {
  const m = document.getElementById('printModal');
  if (m) m.classList.add('show');
}

function buildPrintSvgForPrint(opts) {
  const r = buildSVGString('#ffffff');
  const ps = PAPER_MM[opts.paper] || PAPER_MM.a4;
  const pw = opts.landscape ? ps[1] : ps[0], ph = opts.landscape ? ps[0] : ps[1];
  const margin = 12;
  const titleH = opts.title ? 14 : 0;
  const availW = pw - margin * 2, availH = ph - margin * 2 - titleH;
  let scale = Math.min(availW / r.w, availH / r.h);
  if (opts.scaleMode === 'custom' && opts.scalePct > 0) scale = opts.scalePct / 100;
  const drawW = r.w * scale, drawH = r.h * scale;
  const name = (document.getElementById('docName') && document.getElementById('docName').value) || 'Untitled Drawing';
  const date = new Date().toISOString().slice(0, 10);
  const scaleLabel = opts.scaleMode === 'fit' ? 'Fit to page (' + Math.round(scale * 100) + '%)' : opts.scalePct + '%';
  return {
    w: drawW, h: drawH, scaleLabel: scaleLabel, name: name, date: date, paper: opts.paper,
    orientation: opts.landscape ? 'landscape' : 'portrait',
    svg: r.svg
  };
}

function openPrintWindow() {
  const opts = readPrintOptions();
  const p = buildPrintSvgForPrint(opts);
  const mm = (v) => v.toFixed(2) + 'mm';
  const ps = PAPER_MM[opts.paper] || PAPER_MM.a4;
  const pw = opts.landscape ? ps[1] : ps[0], ph = opts.landscape ? ps[0] : ps[1];
  const margin = 12;
  const titleH = opts.title ? 14 : 0;
  const svgInner = p.svg.replace(/^<\?xml[^>]*\?>\s*/, '');
  const html = [
    '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(p.name) + ' — print sheet</title>',
    '<style>',
    '@page { size: ' + mm(pw) + ' ' + mm(ph) + '; margin: 0; }',
    'html,body { margin:0; padding:0; background:#fff; }',
    '.sheet { box-sizing: border-box; width:' + mm(pw) + '; height:' + mm(ph) + '; padding:' + mm(margin) + '; background:#fff; }',
    '.draw { box-sizing: border-box; width:' + mm(pw - margin * 2) + '; height:' + mm(ph - margin * 2 - titleH) + '; display:flex; align-items:center; justify-content:center; }',
    '.draw svg { max-width:100%; max-height:100%; }',
    '.titleblock { height:' + mm(titleH) + '; display:flex; align-items:center; justify-content:space-between; font:9px Inter, Arial, sans-serif; color:#111; border-top:0.4mm solid #333; padding-top:1mm; }',
    '</style></head><body>',
    '<div class="sheet"><div class="draw">' + svgInner + '</div>',
    opts.title ? '<div class="titleblock"><span>' + esc(p.name) + '</span><span>' + esc(p.scaleLabel) + ' · ' + esc(p.orientation) + '</span><span>' + esc(p.date) + '</span></div>' : '',
    '</div>',
    '<script>window.onload = function(){ setTimeout(function(){ window.focus(); window.print(); }, 250); };<' + '/script>',
    '</body></html>'
  ].join('\n');
  const win = window.open('', '_blank');
  if (!win) { toast('Pop-up blocked — allow pop-ups to print'); return; }
  win.document.open(); win.document.write(html); win.document.close();
  toast('Opening print sheet…');
}

function runExport(kind) {
  const fn = EXPORTERS[kind];
  if (fn) fn();
}

/* ---------- drawing health report ---------- */
function healthReport() {
  const H = window.AutoKadHealth;
  if (!H) return null;
  const el = document.getElementById('healthTol');
  const tol = el ? Math.max(0.001, parseFloat(el.value) || 0.01) : 0.01;
  return H.reportJSON(docName(), { layers: state.doc.layers, entities: state.doc.entities }, { tolerance: tol });
}

function renderHealth() {
  const rep = healthReport();
  const body = document.getElementById('healthIssues');
  const sum = document.getElementById('healthSummary');
  if (!body || !sum) return;
  if (!rep) { body.innerHTML = '<div class="empty">Health analysis unavailable</div>'; return; }
  const s = rep.report.summary;
  const badge = (n, cls) => '<span class="health-pill ' + cls + '">' + n + '</span>';
  sum.innerHTML =
    '<div class="health-figs">' +
    badge(s.entities, 'neutral') + '<span>objects</span>' +
    badge(s.layersUsed + '/' + s.layers, 'neutral') + '<span>layers used</span>' +
    badge(s.errors, 'err') + '<span>errors</span>' +
    badge(s.warnings, 'warn') + '<span>warnings</span>' +
    badge(s.infos, 'info') + '<span>notes</span>' +
    '</div>' +
    '<div class="health-ext">' + (rep.report.extents
      ? 'Extents ' + fmt(rep.report.extents.x1 - rep.report.extents.x0) + ' × ' + fmt(rep.report.extents.y1 - rep.report.extents.y0) +
        ' (' + fmt(rep.report.extents.x0) + ', ' + fmt(rep.report.extents.y0) + ') – (' + fmt(rep.report.extents.x1) + ', ' + fmt(rep.report.extents.y1) + ')'
      : 'No geometry') + (s.clean ? ' · <strong class="health-ok">No issues found</strong>' : '') + '</div>';

  if (!rep.report.issues.length) {
    body.innerHTML = '<div class="empty">The drawing is clean at the current tolerance.</div>';
  } else {
    body.innerHTML = rep.report.issues.map((it, i) =>
      '<div class="health-issue ' + it.severity + '" data-i="' + i + '">' +
      '<span class="hi-sev">' + it.severity + '</span>' +
      '<span class="hi-msg">' + esc(it.message) + '</span>' +
      (it.entityIds && it.entityIds.length ? '<span class="hi-count">' + it.entityIds.length + ' obj</span>' : '') +
      '</div>').join('');
    body.querySelectorAll('.health-issue').forEach(row => {
      row.onclick = () => {
        const it = rep.report.issues[parseInt(row.dataset.i, 10)];
        if (!it || !it.entityIds || !it.entityIds.length) { toast('No objects to select for this issue'); return; }
        state.sel = new Set(it.entityIds.filter(id => state.doc.entities.some(e => e.id === id)));
        renderAll(); draw();
        if (state.sel.size) fitView();
        toast('Selected ' + state.sel.size + ' object' + (state.sel.size === 1 ? '' : 's') + ' for this issue');
      };
    });
  }
}

function openHealth() {
  renderHealth();
  const m = document.getElementById('healthModal');
  if (m) m.classList.add('show');
}
function closeHealth() {
  const m = document.getElementById('healthModal');
  if (m) m.classList.remove('show');
}
function healthJSONText() {
  const rep = healthReport();
  return rep ? JSON.stringify(rep, null, 2) : '';
}

/* Apply the health cleanup plan: one undo step, removes only what the report flags. */
function cleanupFromHealth() {
  const H = window.AutoKadHealth;
  if (!H || typeof H.planCleanup !== 'function') { toast('Cleanup unavailable'); return; }
  const el = document.getElementById('healthTol');
  const tol = el ? Math.max(0.001, parseFloat(el.value) || 0.01) : 0.01;
  const plan = H.planCleanup(
    { layers: state.doc.layers, entities: state.doc.entities, currentLayer: state.doc.currentLayer },
    { tolerance: tol }
  );
  const c = plan.counts;
  if (!plan.changes) { toast('Nothing to clean up'); setPrompt('Health cleanup: drawing already clean'); return; }
  const parts = [];
  if (c.zeroLength) parts.push(c.zeroLength + ' zero-length/empty object' + (c.zeroLength === 1 ? '' : 's'));
  if (c.duplicate) parts.push(c.duplicate + ' duplicate' + (c.duplicate === 1 ? '' : 's'));
  if (c.emptyLayers) parts.push(c.emptyLayers + ' empty layer' + (c.emptyLayers === 1 ? '' : 's'));
  if (!window.confirm('Clean up this drawing?\n\nRemove ' + parts.join(', ') +
      '.\n\nThis is a single undo step.')) return;

  pushUndo();
  const gone = new Set(plan.entities);
  if (gone.size) state.doc.entities = state.doc.entities.filter(e => !gone.has(e.id));
  if (plan.layers.length) {
    const drop = new Set(plan.layers);
    state.doc.layers = state.doc.layers.filter(l => !drop.has(l.name));
  }
  for (const id of Array.from(state.sel)) if (gone.has(id)) state.sel.delete(id);
  state.dirty = true; markDirty();
  renderAll();
  renderHealth();
  const msg = 'Cleaned up: ' + (c.entities || 0) + ' object' + (c.entities === 1 ? '' : 's') +
              ', ' + (c.emptyLayers || 0) + ' layer' + (c.emptyLayers === 1 ? '' : 's');
  toast(msg + ' (undo to revert)');
  setPrompt(msg + ' — ' + 'Ctrl+Z to undo');
  cmdLog(msg);
}


/* ---------- import (JSON drag & drop) ---------- */
function importJSONText(text) {
  const obj = JSON.parse(text);
  const data = obj && obj.data ? obj.data : obj;
  if (!data || !Array.isArray(data.entities)) throw new Error('not an WebCAD drawing');
  loadDoc(data, null, (obj && obj.name) || 'Imported Drawing');
  state.dirty = true; markDirty();
  toast('Imported ' + data.entities.length + ' objects');
}

/* ---------- DXF import (ASCII R12 subset) ---------- */
function parseDXF(text) {
  const lines = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    const val = lines[i + 1];
    if (Number.isNaN(code)) continue;
    pairs.push([code, val === undefined ? '' : val.trim()]);
  }
  const ents = [];
  const layers = [];
  const unsupported = Object.create(null);
  let cur = null;
  let skip = 0;
  let lwPts = null, lwX = null, lwY = null, lwPrev = 0;
  const num = (v) => parseFloat(v);
  const UNSUPPORTED_KINDS = ['DIMENSION', 'MTEXT', 'INSERT', 'SPLINE', 'ELLIPSE', 'POINT', 'POLYLINE', 'HATCH', 'LEADER', 'SOLID', 'ATTDEF', 'ATTRIB'];
  for (let i = 0; i < pairs.length; i++) {
    const [c, v] = pairs[i];
    if (c === 0) {
      // flush open entities
      if (cur && (cur.type === 'line' || cur.type === 'circle' || cur.type === 'arc' || cur.type === 'text')) ents.push(cur);
      if (lwPts && lwPts.length >= 2) {
        for (let k = 0; k + 1 < lwPts.length; k++) ents.push({ type: 'line', p1: lwPts[k], p2: lwPts[k + 1], layer: lwPts.layer });
      }
      lwPts = null; lwX = lwY = null; lwPrev = 0;
      cur = null;
      if (UNSUPPORTED_KINDS.indexOf(v) !== -1) {
        unsupported[v] = (unsupported[v] || 0) + 1;
        skip = 1;
      }
      else skip = 0;
      if (v === 'LINE') cur = { type: 'line', p1: null, p2: null, layer: '0' };
      else if (v === 'CIRCLE') cur = { type: 'circle', c: null, r: null, layer: '0' };
      else if (v === 'ARC') cur = { type: 'arc', c: null, r: null, a0: 0, a1: 0, layer: '0' };
      else if (v === 'TEXT') cur = { type: 'text', p: null, size: 20, text: '', layer: '0' };
      else if (v === 'LWPOLYLINE') { lwPts = []; lwPts.layer = '0'; }
      else if (v === 'LAYER') {
        // gather 2-code on following pairs
        let nm = null, col = 7;
        for (let j = i + 1; j < pairs.length && pairs[j][0] !== 0; j++) {
          if (pairs[j][0] === 2) nm = pairs[j][1];
          if (pairs[j][0] === 62) col = Math.abs(parseInt(pairs[j][1], 10)) || 7;
        }
        if (nm) layers.push({ name: nm, color: LAYER_COLORS[layers.length % LAYER_COLORS.length], visible: true, locked: false, lineweight: 1 });
      }
      continue;
    }
    if (skip) continue;
    if (lwPts) {
      if (c === 8) lwPts.layer = v;
      else if (c === 70) lwPts.closed = (parseInt(v,10) & 1) === 1;
      else if (c === 10) { lwX = num(v); lwPrev = 1; }
      else if (c === 20) { if (lwPrev === 1 && lwX !== null) { lwPts.push([lwX, -num(v)]); lwX = null; lwPrev = 0; } }
      continue;
    }
    if (!cur) continue;
    if (c === 8) cur.layer = v;
    else if (cur.type === 'line') {
      if (c === 10) cur.p1 = [num(v), cur.p1 ? cur.p1[1] : 0];
      else if (c === 20) cur.p1 = [cur.p1 ? cur.p1[0] : 0, -num(v)];
      else if (c === 11) cur.p2 = [num(v), cur.p2 ? cur.p2[1] : 0];
      else if (c === 21) cur.p2 = [cur.p2 ? cur.p2[0] : 0, -num(v)];
    } else if (cur.type === 'circle') {
      if (c === 10) cur.c = [num(v), cur.c ? cur.c[1] : 0];
      else if (c === 20) cur.c = [cur.c ? cur.c[0] : 0, -num(v)];
      else if (c === 40) cur.r = num(v);
    } else if (cur.type === 'arc') {
      if (c === 10) cur.c = [num(v), cur.c ? cur.c[1] : 0];
      else if (c === 20) cur.c = [cur.c ? cur.c[0] : 0, -num(v)];
      else if (c === 40) cur.r = num(v);
      else if (c === 50) cur.a0 = -num(v);   // provisional; recompute with 51
      else if (c === 51) cur.a1 = -num(v);
    } else if (cur.type === 'text') {
      if (c === 10) cur.p = [num(v), cur.p ? cur.p[1] : 0];
      else if (c === 20) cur.p = [cur.p ? cur.p[0] : 0, -num(v)];
      else if (c === 40) cur.size = num(v);
      else if (c === 1) cur.text = v;
    }
  }
  if (cur && (cur.type === 'line' || cur.type === 'circle' || cur.type === 'arc' || cur.type === 'text')) ents.push(cur);
  if (lwPts && lwPts.length >= 2) {
    for (let k = 0; k + 1 < lwPts.length; k++) ents.push({ type: 'line', p1: lwPts[k], p2: lwPts[k + 1], layer: lwPts.layer });
  }
  // arc: screen-space a0 = -v51 (start), a1 = -(v50) ... correct mapping done below
  for (const e of ents) {
    if (e.type === 'arc') {
      const v50 = -e.a0, v51 = -e.a1;   // back to DXF values
      e.a0 = -v51; e.a1 = -v50;         // start=-(51), end=-(50)
      let s = e.a1 - e.a0; while (s <= 0) s += 360;
      e.a1 = e.a0 + s;
      e.a0 = ((e.a0 % 360) + 360) % 360;
      e.a1 = e.a0 + s;
    }
  }
  return { layers, entities: ents.filter(e => e.p1 || e.c || e.p), unsupported };
}

/* Build an import preview plan from a parse result without touching the drawing */
function buildDXFImportPlan(parsed) {
  const counts = Object.create(null);
  let total = 0;
  for (const e of parsed.entities) {
    const kind = (e.type || 'unclassified').toUpperCase();
    counts[kind] = (counts[kind] || 0) + 1;
    total++;
  }
  const skippedMap = parsed.unsupported || {};
  let skippedTotal = 0;
  for (const k in skippedMap) skippedTotal += skippedMap[k];
  const fmt = (m) => Object.keys(m).sort().map(k => k + ': ' + m[k]).join(', ');
  const lay = ['0'];
  for (const l of parsed.layers) if (lay.indexOf(l.name) === -1) lay.push(l.name);
  const lines = [
    'Layers: ' + lay.length + ' (' + lay.slice(0, 6).join(', ') + (lay.length > 6 ? ', ...' : '') + ')',
    'Objects to add (' + total + '): ' + (total ? fmt(counts) : 'none'),
  ];
  if (skippedTotal) lines.push('Unsupported entities that will be skipped (' + skippedTotal + '): ' + fmt(skippedMap));
  else lines.push('Unsupported entities that will be skipped: none');
  if (!total && skippedTotal) lines.push('Nothing drawable in this file - importing would replace the drawing with only these layers.');
  if (!total && !skippedTotal) lines.push('No recognizable DXF entities found.');
  return { summary: lines.join('\n'), willAdd: counts, willAddTotal: total, skipped: skippedMap, skippedTotal, layers: lay };
}

function importDXFText(text) {
  const parsed = parseDXF(text);
  const plan = buildDXFImportPlan(parsed);
  if (!plan.willAddTotal && !plan.skippedTotal) throw new Error('no recognizable DXF entities found in file');
  // merge layer list with a default layer 0
  const lay = [{ name: '0', color: '#e6edf3', visible: true, locked: false, lineweight: 1 }];
  for (const l of parsed.layers) if (!lay.some(x => x.name === l.name)) lay.push(l);
  const msg = 'DXF import preview\n\n' + plan.summary +
    '\n\nImporting replaces the current drawing contents.' +
    (plan.willAddTotal ? '' : ' Nothing drawable will be added.');
  if (!window.confirm(msg + '\n\nProceed?')) return null;
  loadDoc({ layers: lay, entities: parsed.entities }, null, 'Imported DXF');
  state.dirty = true; markDirty();
  toast('Imported ' + parsed.entities.length + ' objects from DXF' +
    (plan.skippedTotal ? ' (' + plan.skippedTotal + ' unsupported skipped)' : ''));
  return plan;
}

/* ---------- layers modal prompt ---------- */
function addLayer() {
  const name = window.prompt('New layer name:', 'Layer ' + (state.doc.layers.length + 1));
  if (!name) return;
  const nm = name.trim();
  if (!nm) return;
  if (state.doc.layers.some(l => l.name === nm)) { toast('Layer already exists'); return; }
  state.doc.layers.push({
    name: nm,
    color: LAYER_COLORS[state.doc.layers.length % LAYER_COLORS.length],
    visible: true, locked: false, lineweight: 1,
  });
  state.doc.currentLayer = nm;
  state.dirty = true; markDirty(); renderAll();
  setPrompt('Layer created: ' + nm);
}

function moveSelectionToLayer() {
  if (!state.sel.size) { toast('Select objects first'); return; }
  const name = window.prompt('Move ' + state.sel.size + ' object(s) to layer:',
    state.doc.currentLayer, );
  if (!name) return;
  const nm = name.trim();
  const L = state.doc.layers.find(l => l.name === nm);
  if (!L) { toast('No such layer: ' + nm); return; }
  pushUndo();
  for (const e of state.doc.entities) if (state.sel.has(e.id)) e.layer = L.name;
  state.dirty = true; markDirty(); renderAll();
  setPrompt('Moved to layer ' + nm);
}

/* ---------- auth (login / register / account) ---------- */
let authMode = 'login'; // or 'register'
let currentUser = null;

async function fetchMe() {
  try {
    const res = await fetch('/api/auth/me');
    const json = await res.json();
    currentUser = (json && json.user) || null;
  } catch (e) { currentUser = null; }
}

function renderAuth() {
  const box = document.getElementById('authBox');
  if (!box) return;
  box.innerHTML = '';
  if (currentUser) {
    const tag = document.createElement('span');
    tag.className = 'user-tag';
    tag.textContent = '· ' + currentUser.username;
    tag.title = 'Signed in — your saved drawings are private to you';
    const out = document.createElement('button');
    out.className = 'mb'; out.textContent = 'Sign out';
    out.onclick = signOut;
    box.append(tag, out);
  } else {
    const btn = document.createElement('button');
    btn.className = 'mb accent'; btn.textContent = 'Sign in';
    btn.title = 'Sign in to save drawings to your own account';
    btn.onclick = () => openAuth('login');
    box.append(btn);
  }
}

function openAuth(mode) {
  authMode = mode || 'login';
  const modal = document.getElementById('authModal');
  document.getElementById('authTitle').textContent = authMode === 'login' ? 'Sign in' : 'Create account';
  document.getElementById('authGo').textContent = authMode === 'login' ? 'Sign in' : 'Register';
  document.getElementById('authSwitch').textContent =
    authMode === 'login' ? 'Need an account? Register' : 'Have an account? Sign in';
  document.getElementById('authErr').textContent = '';
  document.getElementById('authUser').value = '';
  document.getElementById('authPass').value = '';
  modal.classList.add('show');
  setTimeout(() => document.getElementById('authUser').focus(), 30);
}

function closeAuth() {
  document.getElementById('authModal').classList.remove('show');
}

async function submitAuth() {
  const u = document.getElementById('authUser').value.trim();
  const p = document.getElementById('authPass').value;
  const errEl = document.getElementById('authErr');
  errEl.textContent = '';
  if (!u || !p) { errEl.textContent = 'Enter a username and password.'; return; }
  try {
    const res = await fetch('/api/auth/' + authMode, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { errEl.textContent = json.error || ('HTTP ' + res.status); return; }
    currentUser = json.user;
    closeAuth();
    renderAuth();
    toast(authMode === 'login' ? ('Signed in as ' + u) : ('Account created — welcome, ' + u));
  } catch (err) {
    errEl.textContent = String(err.message || err);
  }
}

async function signOut() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  currentUser = null;
  renderAuth();
  toast('Signed out');
}

function wireAuth() {
  const modal = document.getElementById('authModal');
  if (!modal) return;
  document.getElementById('authClose').onclick = closeAuth;
  document.getElementById('authSwitch').onclick = () => openAuth(authMode === 'login' ? 'register' : 'login');
  document.getElementById('authGo').onclick = submitAuth;
  modal.onclick = (ev) => { if (ev.target === modal) closeAuth(); };
  const onEnter = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submitAuth(); } };
  document.getElementById('authUser').addEventListener('keydown', onEnter);
  document.getElementById('authPass').addEventListener('keydown', onEnter);
}

/* ---------- toolbar / buttons ---------- */
function wireUI() {
  const guideButton = document.getElementById('btnCommandGuide');
  const guideClose = document.getElementById('closeCommandGuide');
  const guideSearch = document.getElementById('guideSearch');
  const guidePanel = document.getElementById('commandGuide');
  if (guideButton) guideButton.onclick = () => setCommandGuide(!guidePanel.classList.contains('show'));
  if (guideClose) guideClose.onclick = () => setCommandGuide(false);
  if (guideSearch) guideSearch.addEventListener('input', () => {
    const query = guideSearch.value.trim().toLowerCase();
    let visibleCount = 0;
    document.querySelectorAll('[data-guide-item]').forEach(item => {
      const haystack = (item.textContent + ' ' + (item.dataset.search || '')).toLowerCase();
      const visible = !query || haystack.includes(query);
      item.hidden = !visible;
      if (visible) visibleCount++;
    });
    document.querySelectorAll('[data-guide-group]').forEach(group => {
      group.hidden = !group.querySelector('[data-guide-item]:not([hidden])');
    });
    const empty = document.getElementById('guideEmpty');
    if (empty) empty.hidden = visibleCount > 0;
  });
  document.querySelectorAll('.tool').forEach(btn => {
    btn.onclick = () => setTool(btn.dataset.tool);
  });

  const on = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
  };

  on('btnNew', () => newDrawing());
  on('btnOpen', () => showOpen());
  on('btnImport', () => { const inp = document.getElementById('fileImport'); if (inp) inp.click(); });
  const fi = document.getElementById('fileImport');
  if (fi) fi.addEventListener('change', () => {
    const f = fi.files && fi.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try { importDXFText(String(rd.result)); }
      catch (err) { toast('Import failed - ' + (err.message || err)); }
    };
    rd.readAsText(f);
    fi.value = '';
  });
  on('closeOpen', () => closeOpen());
  on('btnSave', () => saveDrawing(false));
  on('btnUndo', () => undo());
  on('btnRedo', () => redo());
  on('btnZoomExt', () => fitView());
  on('btnFit', () => fitView());
  on('btnGrid', () => {
    state.showGrid = !state.showGrid;
    document.getElementById('btnGrid').classList.toggle('on', state.showGrid);
    const tg = document.getElementById('tgGrid');
    if (tg) tg.classList.toggle('on', state.showGrid);
    draw();
  });
  on('btnShare', () => shareDrawing());
  on('btnAddLayer', () => addLayer());
  on('btnSelLayer', () => moveSelectionToLayer());
  on('btnMirrorX', () => mirrorSelection('x'));
  on('btnMirrorY', () => mirrorSelection('y'));
  on('btnMirrorXCopy', () => mirrorSelection('x', true));
  on('btnMirrorYCopy', () => mirrorSelection('y', true));
  on('btnArray', () => arraySelection());
  on('btnArrayPolar', () => polarArrayDialog());
  on('btnHealth', () => openHealth());
  on('healthClose', () => closeHealth());
  on('healthRerun', () => renderHealth());
  on('healthCleanup', () => cleanupFromHealth());
  on('healthDownload', () => {
    const t = healthJSONText();
    if (!t) return;
    download(slug() + '-health.json', t, 'application/json');
    toast('Downloaded health report');
  });
  on('healthCopy', async () => {
    const t = healthJSONText();
    if (!t) return;
    try { await navigator.clipboard.writeText(t); toast('Health report JSON copied'); }
    catch (e) { download(slug() + '-health.json', t, 'application/json'); toast('Clipboard blocked - downloaded instead'); }
  });
  const hm = document.getElementById('healthModal');
  if (hm) hm.onclick = (ev) => { if (ev.target === hm) closeHealth(); };
  const ht = document.getElementById('healthTol');
  if (ht) ht.addEventListener('change', () => renderHealth());

  const exp = document.getElementById('btnExport');
  const menu = document.getElementById('exportMenu');
  const dd = menu ? menu.closest('.dropdown') : null;
  if (exp && menu && dd) {
    exp.onclick = (ev) => { ev.stopPropagation(); dd.classList.toggle('open'); };
    menu.querySelectorAll('button').forEach(b => {
      b.onclick = (ev) => {
        ev.stopPropagation();
        dd.classList.remove('open');
        runExport(b.dataset.exp);
      };
    });
    document.addEventListener('click', () => dd.classList.remove('open'));
  }

  const openModal = document.getElementById('openModal');
  if (openModal) openModal.onclick = (ev) => { if (ev.target === openModal) closeOpen(); };

  const tg = (id, prop) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('on', !!state[prop]);
    el.onclick = () => {
      state[prop] = !state[prop];
      el.classList.toggle('on', state[prop]);
      if (prop === 'showGrid') {
        const g = document.getElementById('btnGrid');
        if (g) g.classList.toggle('on', state.showGrid);
        draw();
      }
      if (prop === 'ortho' || prop === 'polar' || prop === 'gridSnap' || prop === 'osnap') setPrompt('Ready');
    };
  };
  tg('tgSnap', 'osnap');
  tg('tgGridSnap', 'gridSnap');
  tg('tgOrtho', 'ortho');
  tg('tgPolar', 'polar');
  tg('tgGrid', 'showGrid');

  // reference image underlay (round 44)
  const uf = document.getElementById('fileUnderlay');
  if (uf) uf.addEventListener('change', () => {
    const f = uf.files && uf.files[0];
    uf.value = '';
    if (!f) return;
    readUnderlayFile(f).then(r => {
      setUnderlay(r.src, r.name, r.iw, r.ih);
      toast('Reference image added \u2014 use 2-pt calibrate to set the real scale');
    }).catch(err => toast('Reference image: ' + (err.message || err)));
  });
  wireCalibrateModal();
  const dn = document.getElementById('docName');
  if (dn) {
    dn.addEventListener('input', () => { state.dirty = true; markDirty(); });
    dn.addEventListener('blur', () => { if (state.doc) saveDrawing(true); });
    dn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); dn.blur(); } });
  }

  window.addEventListener('resize', () => { resize(); });
  window.addEventListener('beforeunload', (ev) => {
    if (state.dirty) { ev.preventDefault(); ev.returnValue = ''; }
  });

  // drag & drop a JSON drawing onto the canvas
  const wrapEl = document.getElementById('canvasWrap');
  if (wrapEl) {
    wrapEl.addEventListener('dragover', (ev) => { ev.preventDefault(); });
    wrapEl.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          if (/\.dxf$/i.test(f.name)) importDXFText(String(rd.result));
          else importJSONText(String(rd.result));
        }
        catch (err) { toast('Import failed - ' + (err.message || err)); }
      };
      rd.readAsText(f);
    });
  }
}

/* ---------- boot ---------- */
async function boot() {
  state.doc = emptyDoc();
  wireUI();
  wireAuth();
  resize();
  renderAll();
  fetchMe().then(renderAuth);

  const m = location.pathname.match(/\/d\/([A-Za-z0-9_-]+)/);
  try {
    if (m) {
      const res = await fetch('/api/drawings/' + encodeURIComponent(m[1]));
      if (res.ok) {
        const json = await res.json();
        loadDoc(json.drawing.data, json.drawing.id, json.drawing.name);
        setPrompt('Opened "' + json.drawing.name + '"  -  pick a tool');
        return;
      }
    }
    const res = await fetch('/api/drawings');
    const json = await res.json();
    const first = (json && json.drawings && json.drawings[0]) || null;
    if (first) {
      const r2 = await fetch('/api/drawings/' + encodeURIComponent(first.id));
      const j2 = await r2.json();
      loadDoc(j2.drawing.data, j2.drawing.id, j2.drawing.name);
      history.replaceState(null, '', '/d/' + j2.drawing.id);
    } else {
      loadDoc(sampleDoc(), null, 'Untitled Drawing');
      zoomExtents();
    }
  } catch (err) {
    loadDoc(sampleDoc(), null, 'Sample Floor Plan (offline)');
    zoomExtents();
  }
  setPrompt(PROMPTS[state.tool] || 'Ready');
}

window.addEventListener('load', () => { boot(); });

// Debug/test hook: read-only access to view transform + selection internals.
window.__WebCAD = { state, w2s, s2w, entitiesInWindow, parseCoordEntry };
window.__ak = {
  filletGeom, applyFillet, defaultFilletRadius,
  trimGeom, applyTrim, extendGeom, applyExtend, entSegsFlat, rayEntIsects, rectCornersOf,
  parseCoordEntry,
  healthReport, openHealth,
  readUnderlayFile, setUnderlay, clearUnderlay, calibrateUnderlay, startUnderlayCalibrate,
  placeUnderlay, underlayBBox, underlayCorners, triggerUnderlayFile, submitCalibrateModal,
  openCalibrateModal, renderUnderlayPanel, buildSVGString, buildDXFExportPlan, loadDoc, docPayload,
  get state() { return state; },
  get currentUser() { return currentUser; },
  openAuth,
  submitAuth
};

})();
