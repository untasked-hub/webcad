'use strict';

// Pure document-diff helpers for WebCAD version comparison.
// Kept out of server.js so they can be unit-tested without a database.

// ---- Owner-only version diff summary ---------------------------------------
// Read-only: compares two saved snapshots (or a snapshot vs. the current
// drawing) and returns counts plus a short human-readable summary. No payload
// diff is returned, so a large drawing stays cheap to inspect.
function diffPointsOf(entity) {
  const pts = [];
  const push = (v) => {
    if (Array.isArray(v) && v.length >= 2 && Number.isFinite(v[0]) && Number.isFinite(v[1])) pts.push([v[0], v[1]]);
  };
  if (!entity || typeof entity !== 'object') return pts;
  push(entity.p1); push(entity.p2); push(entity.p); push(entity.c);
  if (Array.isArray(entity.points)) entity.points.forEach(push);
  if (Array.isArray(entity.pts)) entity.pts.forEach(push);
  return pts;
}

function boundsOfDoc(doc) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const consider = (x, y, r) => {
    const rad = Number.isFinite(r) ? Math.abs(r) : 0;
    x0 = Math.min(x0, x - rad); y0 = Math.min(y0, y - rad);
    x1 = Math.max(x1, x + rad); y1 = Math.max(y1, y + rad);
  };
  const ents = doc && Array.isArray(doc.entities) ? doc.entities : [];
  for (const e of ents) {
    const r = e && e.type === 'circle' ? e.r : 0;
    for (const [x, y] of diffPointsOf(e)) consider(x, y, e && e.type === 'arc' ? e.r : r);
    if (e && e.type === 'rect' && Array.isArray(e.p1) && Array.isArray(e.p2)) {
      consider(e.p2[0], e.p1[1], 0); consider(e.p1[0], e.p2[1], 0);
    }
  }
  if (!Number.isFinite(x0)) return null;
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

function entityKey(entity, index) {
  if (entity && typeof entity === 'object' && entity.id !== undefined && entity.id !== null && entity.id !== '') return 'id:' + String(entity.id);
  // Snapshots saved before entity ids existed still line up positionally.
  return 'idx:' + index + ':' + String(entity && entity.type);
}

function summarizeDocDiff(docA, docB, labelA, labelB) {
  const entsA = docA && Array.isArray(docA.entities) ? docA.entities : [];
  const entsB = docB && Array.isArray(docB.entities) ? docB.entities : [];
  const mapA = new Map(), mapB = new Map();
  entsA.forEach((e, i) => mapA.set(entityKey(e, i), e));
  entsB.forEach((e, i) => mapB.set(entityKey(e, i), e));
  const added = [], removed = [], changed = [];
  for (const [k, e] of mapB) if (!mapA.has(k)) added.push(e);
  for (const [k, e] of mapA) {
    if (!mapB.has(k)) { removed.push(e); continue; }
    if (JSON.stringify(e) !== JSON.stringify(mapB.get(k))) changed.push(e);
  }
  const typeTally = (list) => {
    const out = {};
    for (const e of list) {
      const t = String((e && e.type) || 'object');
      out[t] = (out[t] || 0) + 1;
    }
    return out;
  };
  // Layers are normally {name, ...} objects, but older snapshots and API
  // clients may send bare layer-name strings; accept both.
  const layerName = (l) => String(l && typeof l === 'object' ? l.name : l);
  const layersA = new Set((Array.isArray(docA && docA.layers) ? docA.layers : []).map(layerName));
  const layersB = new Set((Array.isArray(docB && docB.layers) ? docB.layers : []).map(layerName));
  const layersAdded = [...layersB].filter((n) => !layersA.has(n)).sort();
  const layersRemoved = [...layersA].filter((n) => !layersB.has(n)).sort();
  const perLayer = {};
  for (const e of entsA) {
    const n = String((e && e.layer) || '0');
    perLayer[n] = perLayer[n] || { before: 0, after: 0 };
    perLayer[n].before += 1;
  }
  for (const e of entsB) {
    const n = String((e && e.layer) || '0');
    perLayer[n] = perLayer[n] || { before: 0, after: 0 };
    perLayer[n].after += 1;
  }
  const boundsA = boundsOfDoc(docA), boundsB = boundsOfDoc(docB);
  const boundsShift = (boundsA && boundsB)
    ? { dw: +(boundsB.w - boundsA.w).toFixed(3), dh: +(boundsB.h - boundsA.h).toFixed(3) }
    : null;

  const typeLine = (tally) => Object.keys(tally || {}).sort().map((t) => tally[t] + ' ' + t).join(', ');
  const lines = [];
  if (!added.length && !removed.length && !changed.length && !layersAdded.length && !layersRemoved.length) {
    lines.push('No drawing changes between ' + labelA + ' and ' + labelB + '.');
  } else {
    if (added.length) lines.push('+' + added.length + ' added' + (typeLine(typeTally(added)) ? ' (' + typeLine(typeTally(added)) + ')' : ''));
    if (removed.length) lines.push('-' + removed.length + ' removed' + (typeLine(typeTally(removed)) ? ' (' + typeLine(typeTally(removed)) + ')' : ''));
    if (changed.length) lines.push('~' + changed.length + ' changed' + (typeLine(typeTally(changed)) ? ' (' + typeLine(typeTally(changed)) + ')' : ''));
    if (layersAdded.length) lines.push('Layers added: ' + layersAdded.slice(0, 6).join(', '));
    if (layersRemoved.length) lines.push('Layers removed: ' + layersRemoved.slice(0, 6).join(', '));
    const movedLayers = Object.keys(perLayer)
      .filter((n) => perLayer[n].before !== perLayer[n].after)
      .sort()
      .slice(0, 8)
      .map((n) => n + ' ' + perLayer[n].before + '→' + perLayer[n].after);
    if (movedLayers.length) lines.push('Per layer: ' + movedLayers.join('; '));
    if (boundsShift && (Math.abs(boundsShift.dw) > 0.001 || Math.abs(boundsShift.dh) > 0.001)) {
      lines.push('Extents change: ' + (boundsShift.dw >= 0 ? '+' : '') + boundsShift.dw + ' x ' +
        (boundsShift.dh >= 0 ? '+' : '') + boundsShift.dh);
    }
  }

  const bits = [];
  if (added.length) bits.push('+' + added.length);
  if (removed.length) bits.push('-' + removed.length);
  if (changed.length) bits.push('~' + changed.length);
  const oneLine = bits.length
    ? labelA + ' → ' + labelB + ': ' + bits.join(' ') + ' entities' +
      (layersAdded.length ? ', +layers ' + layersAdded.slice(0, 3).join('/') : '') +
      (layersRemoved.length ? ', -layers ' + layersRemoved.slice(0, 3).join('/') : '')
    : labelA + ' → ' + labelB + ': no changes';

  return {
    counts: {
      entities_before: entsA.length,
      entities_after: entsB.length,
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      layers_before: layersA.size,
      layers_after: layersB.size,
    },
    added_by_type: typeTally(added),
    removed_by_type: typeTally(removed),
    changed_by_type: typeTally(changed),
    layers_added: layersAdded,
    layers_removed: layersRemoved,
    per_layer: perLayer,
    bounds_before: boundsA,
    bounds_after: boundsB,
    bounds_shift: boundsShift,
    lines: lines.slice(0, 20),
    summary: oneLine.slice(0, 140),
  };
}

module.exports = { diffPointsOf, boundsOfDoc, entityKey, summarizeDocDiff };
