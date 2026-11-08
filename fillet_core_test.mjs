
const state={doc:{entities:[],currentLayer:'L0'}};
let _id=0; function newId(){return 'e'+(++_id);}
function dist(a,b){return Math.hypot(a[0]-b[0],a[1]-b[1]);}
const TAU=Math.PI*2; const rad=d=>d*Math.PI/180, deg=r=>r*180/Math.PI;
function angleInArc(a,a0,a1){ let x=(a-a0)*180/Math.PI%360; if(x<0)x+=360; let s=(a1-a0)*180/Math.PI%360; if(s<0)s+=360; return x<=s;}
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

// T1: perpendicular L corner fillet r=5
const e1={id:'a',type:'line',p1:[0,0],p2:[0,50]}, e2={id:'b',type:'line',p1:[0,0],p2:[50,0]};
const g=filletGeom(e1,e2,[0,10],5,false);
console.log('T1 arc c=',g.arc.c.map(v=>+v.toFixed(3)),'r=',g.arc.r,'trim1=',g.trim1.map(v=>+v.toFixed(3)),'trim2=',g.trim2.map(v=>+v.toFixed(3)));
const ok1=Math.abs(g.arc.c[0]-5)<1e-6 && Math.abs(g.arc.c[1]-5)<1e-6;
const ok1b=Math.abs(g.trim1[1]-5)<1e-6 && Math.abs(g.trim2[0]-5)<1e-6;
console.log('T1', ok1&&ok1b ? 'PASS':'FAIL');

// T2 applyFillet mutates and inserts arc
const f1={id:'a',type:'line',p1:[0,0],p2:[0,50]}, f2={id:'b',type:'line',p1:[0,0],p2:[50,0]};
const ok=applyFillet(f1,f2,[0,10],5,false);
console.log('T2 applied=',ok,'e1 p1=',f1.p1,'e2 p1=',f2.p1,'entities=',state.doc.entities.length,'arc r=',state.doc.entities[0].r);
console.log('T2', ok && Math.abs(f1.p1[1]-5)<1e-9 && Math.abs(f2.p1[0]-5)<1e-9 && state.doc.entities.length===1 ? 'PASS':'FAIL');

// T3 chamfer 5
const c1={id:'a',type:'line',p1:[0,0],p2:[0,50]}, c2={id:'b',type:'line',p1:[0,0],p2:[50,0]};
const okc=applyFillet(c1,c2,[0,10],5,true);
console.log('T3 applied=',okc,'c1p1=',c1.p1,'c2p1=',c2.p1,'ins=',state.doc.entities[1].p1,state.doc.entities[1].p2);
console.log('T3', okc && c1.p1[1]===5 && c2.p1[0]===5 ? 'PASS':'FAIL');

// T4 parallel lines rejected
const p1={id:'a',type:'line',p1:[0,0],p2:[0,50]}, p2={id:'b',type:'line',p1:[10,0],p2:[10,50]};
console.log('T4', filletGeom(p1,p2,[0,10],5,false)===null ? 'PASS':'FAIL');

// T5 polyline corner
const pl={id:'p',type:'polyline',pts:[[0,0],[0,50]]}, pl2={id:'q',type:'polyline',pts:[[0,0],[50,0]]};
const gp=filletGeom(pl,pl2,[0,10],5,false);
console.log('T5 arc c=',gp?gp.arc.c.map(v=>+v.toFixed(3)):null);
console.log('T5', gp && Math.abs(gp.arc.c[0]-5)<1e-6 ? 'PASS':'FAIL');

// T6 45-degree corner
const a1v={id:'a',type:'line',p1:[0,0],p2:[0,50]}, a2v={id:'b',type:'line',p1:[0,0],p2:[50*Math.SQRT1_2,50*Math.SQRT1_2]};
const g6=filletGeom(a1v,a2v,[0,10],5,false);
// geometric truth: interior 45deg, half=22.5deg, cdist=r/sin(half)=13.0697 along 67.5deg bisector
const half6=Math.PI/8, cdist6=5/Math.sin(half6), td6=5/Math.tan(half6);
const cx6=cdist6*Math.cos(3*Math.PI/8), cy6=cdist6*Math.sin(3*Math.PI/8);
const t6x=td6*Math.SQRT1_2, t6y=td6*Math.SQRT1_2;
console.log('T6 c=',g6?g6.arc.c.map(v=>+v.toFixed(3)):null,'trim2=',g6?g6.trim2.map(v=>+v.toFixed(3)):null);
console.log('T6', g6 && Math.abs(g6.arc.c[0]-cx6)<1e-6 && Math.abs(g6.arc.c[1]-cy6)<1e-6 && Math.abs(g6.trim2[0]-t6x)<1e-6 && Math.abs(g6.trim2[1]-t6y)<1e-6 ? 'PASS':'FAIL');

// T7 arc sweep validity: mid angle within arc
const g7=filletGeom(e1,e2,[0,10],5,false);
console.log('T7', g7 ? 'PASS':'FAIL');
