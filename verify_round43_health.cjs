
const H = require('./public/health.js');
const doc = {
  layers: [
    { name: '0', color: '#fff', visible: true, locked: false },
    { name: 'Walls', color: '#7fd1ff', visible: true, locked: false },
    { name: 'Empty', color: '#aaa', visible: true, locked: false },
    { name: 'Lock', color: '#aaa', visible: true, locked: true }
  ],
  entities: [
    { id: 'e1', type: 'line', layer: 'Walls', p1: [0,0], p2: [100,0] },
    { id: 'e2', type: 'line', layer: 'Walls', p1: [100,0], p2: [0,0] },
    { id: 'e3', type: 'line', layer: 'Walls', p1: [50,50], p2: [50,50] },
    { id: 'e4', type: 'rect', layer: 'Walls', p1: [0,0], p2: [100,80] },
    { id: 'e5', type: 'circle', layer: 'Lock', c: [5000,5000], r: 10 },
    { id: 'e6', type: 'text', layer: 'Ghost', p: [10,10], text: '', size: 12 },
    { id: 'e7', type: 'circle', layer: '0', c: [20,20], r: 0 }
  ],
  currentLayer: 'Walls'
};
const r = H.analyze(doc, { now: '2026-01-01T00:00:00.000Z' });
console.log(JSON.stringify(r.summary));
console.log(r.issues.map(i=>i.code+' :: '+i.message).join('\n'));
console.log('layerStats ' + JSON.stringify(r.layerStats.map(l=>[l.name,l.count,l.missing||false])));
const clean = { layers: [{name:'0'}], entities: [{id:'a',type:'line',layer:'0',p1:[0,0],p2:[10,0]},{id:'b',type:'circle',layer:'0',c:[0,0],r:5}] };
const c = H.analyze(clean);
console.log('clean ' + c.summary.clean + ' issues=' + c.summary.issues);
const j = H.reportJSON('Demo', doc, {now:'x'});
console.log('json format ' + j.format + ' v' + j.version + ' drawing=' + j.drawing);
