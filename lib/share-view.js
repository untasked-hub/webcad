// Saved-view payloads for read-only share links.
//
// A share link may carry a small, owner-chosen viewport plus the set of layer
// names the owner had hidden when creating the link. The payload is stored
// beside the share metadata (its own column), never inside the drawing data, so
// the editable document is untouched by sharing. Everything here is pure and
// bounded so it can be reused by the server, the tests, and (via duplication of
// the same constants) the read-only viewer.

const MIN_ZOOM = 0.02;      // matches the editor's own zoom clamp
const MAX_ZOOM = 60;
const MAX_COORD = 1e7;      // world-units bound for the viewport centre
const MAX_HIDDEN_LAYERS = 40;
const MAX_LAYER_NAME = 64;

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

// Returns null when the payload is absent/invalid; otherwise a small normalized
// object { x, y, zoom, hiddenLayers }. Throwing is left to the caller so a bad
// payload can be reported as a 400 instead of silently ignored.
function parseShareView(raw) {
  if (raw === undefined || raw === null) return { ok: true, view: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'view must be an object with x, y and zoom' };
  }
  const x = Number(raw.x);
  const y = Number(raw.y);
  const zoom = Number(raw.zoom);
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
    return { ok: false, error: 'view.x and view.y must be finite numbers' };
  }
  if (Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) {
    return { ok: false, error: 'view centre is outside the supported range' };
  }
  if (!isFiniteNumber(zoom) || zoom < MIN_ZOOM || zoom > MAX_ZOOM) {
    return { ok: false, error: 'view.zoom must be between ' + MIN_ZOOM + ' and ' + MAX_ZOOM };
  }
  let hidden = raw.hiddenLayers;
  if (hidden === undefined || hidden === null) hidden = [];
  if (!Array.isArray(hidden)) {
    return { ok: false, error: 'view.hiddenLayers must be an array of layer names' };
  }
  if (hidden.length > MAX_HIDDEN_LAYERS) {
    return { ok: false, error: 'view.hiddenLayers may name at most ' + MAX_HIDDEN_LAYERS + ' layers' };
  }
  const seen = new Set();
  const hiddenLayers = [];
  for (const name of hidden) {
    if (typeof name !== 'string') {
      return { ok: false, error: 'view.hiddenLayers entries must be strings' };
    }
    const trimmed = name.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_LAYER_NAME) {
      return { ok: false, error: 'a layer name in view.hiddenLayers is too long' };
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    hiddenLayers.push(trimmed);
  }
  return { ok: true, view: { x, y, zoom, hiddenLayers } };
}

// Apply a stored view to a drawing for rendering without mutating the source
// document. Returns { data, hiddenLayers } where data is a shallow copy whose
// layers reflect the saved visibility.
function applyShareView(data, view) {
  if (!data || typeof data !== 'object') return { data, hiddenLayers: [] };
  const hidden = view && Array.isArray(view.hiddenLayers) ? view.hiddenLayers : [];
  if (!hidden.length) return { data, hiddenLayers: [] };
  const hiddenSet = new Set(hidden);
  const layers = Array.isArray(data.layers) ? data.layers.map((l) => {
    if (!l || typeof l !== 'object') return l;
    if (!hiddenSet.has(l.name)) return l;
    return Object.assign({}, l, { visible: false });
  }) : data.layers;
  return { data: Object.assign({}, data, { layers }), hiddenLayers: hidden.slice() };
}

module.exports = { parseShareView, applyShareView, MIN_ZOOM, MAX_ZOOM, MAX_HIDDEN_LAYERS, MAX_LAYER_NAME };
