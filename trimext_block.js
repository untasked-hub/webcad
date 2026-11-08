
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
  // infinite ray pa + s*du vs finite segment ab; returns ray parameter t (>=0) or null
  const den = du[0] * (b[1] - a[1]) - du[1] * (b[0] - a[0]);
  if (Math.abs(den) < 1e-9) return null;
  const t = ((a[0] - pa[0]) * (b[1] - a[1]) - (a[1] - pa[1]) * (b[0] - a[0])) / den;
  if (t < -1e-7) return null;
  const ex = b[0] - a[0], ey = b[1] - a[1];
  const el2 = ex * ex + ey * ey || 1;
  const snum = (pa[0] + t * du[0] - a[0]) * ex + (pa[1] + t * du[1] - a[1]) * ey;
  const s = snum / el2;
  if (s < -1e-7 || s > 1 + 1e-7) return null;
  return t;
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
/* TRIM: keep the clicked-side run of the picked segment up to the nearest crossing.
   Returns { cut, other } or null. */
function trimGeom(hit, nearWorld) {
  if (hit.type === 'polyline' && hit.pts.length !== 2) return null;
  const seg = nearestSegOn(hit, nearWorld);
  if (!seg) return null;
  const [a, b] = seg;
  const isects = [];
  for (const e of boundaryCandidates(new Set([hit.id]))) lineEntIsects(a, b, e, isects);
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
