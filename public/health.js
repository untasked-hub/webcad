/* AutoKad drawing health report - pure analysis, no DOM.
   Used in the browser as window.AutoKadHealth and in Node tests via module.exports. */
(function (root) {
  'use strict';

  function r3(v) { return Math.round(v * 1000) / 1000; }
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  function vlen(a) { return Math.hypot(a[0], a[1]); }

  function arcPts(e, n) {
    var sweep = e.a1 - e.a0;
    while (sweep <= 0) sweep += 360;
    var out = [];
    for (var i = 0; i <= n; i++) {
      var a = (e.a0 + sweep * i / n) * Math.PI / 180;
      out.push([e.c[0] + Math.cos(a) * e.r, e.c[1] + Math.sin(a) * e.r]);
    }
    return out;
  }

  function dimLines(e) {
    var d = [e.p2[0] - e.p1[0], e.p2[1] - e.p1[1]];
    var L = vlen(d) || 1;
    var n = [-d[1] / L, d[0] / L];
    var o = e.offset || 0;
    var a = [e.p1[0] + n[0] * o, e.p1[1] + n[1] * o];
    var b = [e.p2[0] + n[0] * o, e.p2[1] + n[1] * o];
    return [
      [e.p1, [e.p1[0] + n[0] * o * 1.14, e.p1[1] + n[1] * o * 1.14]],
      [e.p2, [e.p2[0] + n[0] * o * 1.14, e.p2[1] + n[1] * o * 1.14]],
      [a, b]
    ];
  }

  function points(e) {
    switch (e.type) {
      case 'line': return [e.p1, e.p2];
      case 'polyline': return e.pts || [];
      case 'rect': return [[e.p1[0], e.p1[1]], [e.p2[0], e.p1[1]], e.p2, [e.p1[0], e.p2[1]]];
      case 'circle': {
        var out = [];
        for (var i = 0; i < 32; i++) {
          var a = Math.PI * 2 * i / 32;
          out.push([e.c[0] + Math.cos(a) * e.r, e.c[1] + Math.sin(a) * e.r]);
        }
        return out;
      }
      case 'arc': return arcPts(e, 24);
      case 'text': {
        var h = e.size || 0;
        var w = String(e.text || '').length * h * 0.62;
        return [e.p, [e.p[0] + w, e.p[1]], [e.p[0] + w, e.p[1] + h], [e.p[0], e.p[1] + h]];
      }
      case 'dim': return dimLines(e).reduce(function (a, s) { return a.concat(s); }, []);
      default: return [];
    }
  }

  function bbox(e) {
    var pts = points(e);
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (!p) continue;
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
    if (!isFinite(x0)) return null;
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  function unionBox(a, b) {
    if (!a) return b ? { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 } : null;
    if (!b) return a;
    return {
      x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
      x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1)
    };
  }

  function boxesOverlap(a, b) {
    return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
  }

  function geomKey(e, tol) {
    var q = function (v) { return r3(Math.round(v / tol) * tol); };
    var pt = function (p) { return q(p[0]) + ',' + q(p[1]); };
    switch (e.type) {
      case 'line': {
        var a = pt(e.p1), b = pt(e.p2);
        return 'line:' + (a < b ? a + '|' + b : b + '|' + a);
      }
      case 'polyline': return 'polyline:' + (e.pts || []).map(pt).join('|');
      case 'rect': {
        var x0 = q(Math.min(e.p1[0], e.p2[0])), x1 = q(Math.max(e.p1[0], e.p2[0]));
        var y0 = q(Math.min(e.p1[1], e.p2[1])), y1 = q(Math.max(e.p1[1], e.p2[1]));
        return 'rect:' + [x0, y0, x1, y1].join(',');
      }
      case 'circle': return 'circle:' + pt(e.c) + ':' + q(e.r);
      case 'arc': return 'arc:' + pt(e.c) + ':' + q(e.r) + ':' + q(e.a0) + ':' + q(e.a1);
      case 'text': return 'text:' + pt(e.p) + ':' + q(e.size || 0) + ':' + String(e.text || '');
      case 'dim': {
        var a2 = pt(e.p1), b2 = pt(e.p2);
        return 'dim:' + (a2 < b2 ? a2 + '|' + b2 : b2 + '|' + a2) + ':' + q(e.offset || 0);
      }
      default: return String(e.type) + ':' + JSON.stringify(e);
    }
  }

  function isZeroLength(e, eps) {
    switch (e.type) {
      case 'line': return dist(e.p1, e.p2) <= eps;
      case 'circle': return !(e.r > eps);
      case 'arc': return !(e.r > eps);
      case 'rect': return Math.abs(e.p2[0] - e.p1[0]) <= eps || Math.abs(e.p2[1] - e.p1[1]) <= eps;
      case 'polyline': {
        var pts = e.pts || [];
        if (pts.length < 2) return true;
        var total = 0;
        for (var i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
        return total <= eps;
      }
      case 'text': return !String(e.text || '').trim();
      case 'dim': return dist(e.p1, e.p2) <= eps;
      default: return false;
    }
  }

  function describe(e) {
    var t = String(e.type || 'object');
    if (e.type === 'text' && e.text) t += ' "' + String(e.text).slice(0, 20) + '"';
    return t;
  }

  function analyze(doc, opts) {
    opts = opts || {};
    var tol = opts.tolerance > 0 ? opts.tolerance : 0.01;
    var eps = 1e-6;
    var entities = (doc && Array.isArray(doc.entities)) ? doc.entities : [];
    var layers = (doc && Array.isArray(doc.layers)) ? doc.layers : [];
    var perLayer = {};
    layers.forEach(function (l) {
      perLayer[l.name] = {
        name: l.name, color: l.color, visible: l.visible !== false,
        locked: !!l.locked, count: 0, types: {}
      };
    });
    entities.forEach(function (e) {
      var k = e.layer;
      if (!perLayer[k]) {
        perLayer[k] = {
          name: k, color: null, visible: true, locked: false,
          count: 0, types: {}, missing: true
        };
      }
      perLayer[k].count++;
      perLayer[k].types[e.type] = (perLayer[k].types[e.type] || 0) + 1;
    });

    var issues = [];

    entities.forEach(function (e) {
      if (isZeroLength(e, eps)) {
        var empty = e.type === 'text';
        issues.push({
          code: empty ? 'empty-text' : 'zero-length',
          severity: empty ? 'info' : 'warning',
          message: empty
            ? 'Empty text object on layer "' + e.layer + '"'
            : 'Zero-length ' + e.type + ' on layer "' + e.layer + '"',
          entityIds: [e.id],
          layer: e.layer
        });
      }
    });

    var byKey = {};
    entities.forEach(function (e) {
      var k = geomKey(e, tol);
      if (!byKey[k]) byKey[k] = [];
      byKey[k].push(e);
    });
    Object.keys(byKey).forEach(function (k) {
      var group = byKey[k];
      if (group.length < 2) return;
      issues.push({
        code: 'duplicate',
        severity: 'warning',
        message: group.length + ' identical ' + describe(group[0]) + ' objects on layer "' + group[0].layer + '"',
        entityIds: group.map(function (e) { return e.id; }),
        layer: group[0].layer
      });
    });

    var boxes = entities.map(bbox);
    var totalBox = null;
    boxes.forEach(function (b) { totalBox = unionBox(totalBox, b); });
    entities.forEach(function (e, i) {
      var b = boxes[i];
      if (!b || entities.length < 2) return;
      var rest = null;
      for (var j = 0; j < boxes.length; j++) {
        if (j !== i) rest = unionBox(rest, boxes[j]);
      }
      if (rest && !boxesOverlap(b, rest)) {
        issues.push({
          code: 'isolated',
          severity: 'info',
          message: describe(e) + ' on layer "' + e.layer + '" sits away from all other objects',
          entityIds: [e.id],
          layer: e.layer
        });
      }
    });

    Object.keys(perLayer).forEach(function (name) {
      var L = perLayer[name];
      if (!L.count) {
        issues.push({
          code: 'empty-layer',
          severity: 'info',
          message: 'Layer "' + name + '" has no objects',
          entityIds: [],
          layer: name
        });
      }
      if (L.missing) {
        issues.push({
          code: 'missing-layer',
          severity: 'warning',
          message: 'Objects reference a layer "' + name + '" that is not defined',
          entityIds: [],
          layer: name
        });
      }
      if (L.locked && L.count) {
        issues.push({
          code: 'locked-layer',
          severity: 'info',
          message: 'Layer "' + name + '" is locked and holds ' + L.count + ' object' + (L.count === 1 ? '' : 's'),
          entityIds: [],
          layer: name
        });
      }
      if (L.visible === false && L.count) {
        issues.push({
          code: 'hidden-layer',
          severity: 'info',
          message: 'Layer "' + name + '" is hidden and holds ' + L.count + ' object' + (L.count === 1 ? '' : 's'),
          entityIds: [],
          layer: name
        });
      }
    });

    var counts = { error: 0, warning: 0, info: 0 };
    issues.forEach(function (i) { counts[i.severity] = (counts[i.severity] || 0) + 1; });

    var ext = totalBox;
    return {
      generatedAt: opts.now || new Date().toISOString(),
      tolerance: tol,
      summary: {
        entities: entities.length,
        layers: layers.length,
        layersUsed: Object.keys(perLayer).filter(function (n) { return perLayer[n].count > 0; }).length,
        issues: issues.length,
        errors: counts.error || 0,
        warnings: counts.warning || 0,
        infos: counts.info || 0,
        clean: issues.length === 0
      },
      extents: ext ? { x0: r3(ext.x0), y0: r3(ext.y0), x1: r3(ext.x1), y1: r3(ext.y1) } : null,
      layerStats: Object.keys(perLayer).map(function (n) { return perLayer[n]; }),
      issues: issues
    };
  }

  /* Cleanup planner: pure, returns exactly what a one-click cleanup would remove.
     Nothing is mutated here. Keeps the first occurrence of each duplicate group,
     never removes layer "0", the current layer, or the last remaining layer. */
  function planCleanup(doc, opts) {
    opts = opts || {};
    var tol = opts.tolerance > 0 ? opts.tolerance : 0.01;
    var eps = 1e-6;
    var entities = (doc && Array.isArray(doc.entities)) ? doc.entities : [];
    var layers = (doc && Array.isArray(doc.layers)) ? doc.layers : [];
    var currentLayer = doc && doc.currentLayer;

    var removeIds = [];
    var seenId = {};
    function mark(e, why) {
      if (!e || seenId[e.id]) return;
      seenId[e.id] = why;
      removeIds.push(e.id);
    }

    entities.forEach(function (e) { if (isZeroLength(e, eps)) mark(e, 'zero-length'); });

    var byKey = {};
    entities.forEach(function (e) {
      if (seenId[e.id]) return;
      var k = geomKey(e, tol);
      if (!byKey[k]) byKey[k] = [];
      byKey[k].push(e);
    });
    Object.keys(byKey).forEach(function (k) {
      var group = byKey[k];
      for (var i = 1; i < group.length; i++) mark(group[i], 'duplicate');
    });

    var used = {};
    entities.forEach(function (e) {
      if (seenId[e.id]) return;
      used[e.layer] = (used[e.layer] || 0) + 1;
    });
    var defined = {};
    layers.forEach(function (l) { defined[l.name] = true; });

    var removeLayers = [];
    layers.forEach(function (l) {
      if (l.name === '0') return;
      if (l.name === currentLayer) return;
      if (used[l.name]) return;
      removeLayers.push(l.name);
    });
    // never strip every layer: keep at least one defined layer behind
    var keepFloor = 1;
    while (layers.length - removeLayers.length < keepFloor && removeLayers.length) removeLayers.pop();

    var counts = {};
    Object.keys(seenId).forEach(function (id) {
      var why = seenId[id];
      counts[why] = (counts[why] || 0) + 1;
    });

    return {
      entities: removeIds,
      layers: removeLayers,
      counts: {
        zeroLength: counts['zero-length'] || 0,
        duplicate: counts.duplicate || 0,
        entities: removeIds.length,
        emptyLayers: removeLayers.length
      },
      changes: removeIds.length + removeLayers.length > 0
    };
  }

  function reportJSON(name, doc, opts) {
    var r = analyze(doc, opts);
    return {
      format: 'AutoKadHealth',
      version: 1,
      drawing: name || 'Untitled Drawing',
      report: r
    };
  }

  var api = { analyze: analyze, reportJSON: reportJSON, planCleanup: planCleanup, bbox: bbox, geomKey: geomKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AutoKadHealth = api;
})(typeof window !== 'undefined' ? window : null);
