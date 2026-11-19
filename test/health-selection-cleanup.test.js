// Regression test: selection-scoped health cleanup.
// Run with: node test/health-selection-cleanup.test.js
const { planCleanup } = require('../public/health.js');

let fails = 0;
function check(name, ok, extra) {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name);
  if (!ok) { fails++; if (extra !== undefined) console.log('      got: ' + JSON.stringify(extra)); }
}

function doc(entities, extra) {
  return Object.assign({
    currentLayer: 'A',
    layers: [{ name: '0' }, { name: 'A' }, { name: 'B' }],
    entities: entities
  }, extra || {});
}

const L = (id, layer, p1, p2) => ({ id, type: 'line', layer: layer || 'A', p1: p1 || [0, 0], p2: p2 || [10, 0] });

/* ---- whole-drawing mode (unchanged behaviour) ---- */
{
  const d = doc([L('a'), L('b'), L('c', 'A', [0, 0], [0, 0])]);
  const p = planCleanup(d, {});
  check('drawing mode reports itself', p.mode === 'drawing', p.mode);
  check('drawing mode removes the duplicate', p.entities.includes('b'), p.entities);
  check('drawing mode removes zero-length', p.entities.includes('c'), p.entities);
  check('drawing mode keeps the first of a group', !p.entities.includes('a'), p.entities);
  check('drawing mode still sweeps empty layers', p.layers.includes('B'), p.layers);
}

/* ---- selection mode ---- */
{
  // 'b' duplicates 'a'; only 'b' is selected -> 'b' may go, 'a' survives.
  const d = doc([L('a'), L('b')]);
  const p = planCleanup(d, { selection: ['b'] });
  check('selection mode reports itself', p.mode === 'selection', p.mode);
  check('selection mode removes the selected duplicate', p.entities.length === 1 && p.entities[0] === 'b', p.entities);
  check('selection mode never empties the layer table', p.layers.length === 0, p.layers);
  check('selection mode counts the selected members', p.counts.selected === 1, p.counts);
}
{
  // 'a' is the survivor, 'b' the duplicate; selecting only 'a' must remove nothing.
  const d = doc([L('a'), L('b')]);
  const p = planCleanup(d, { selection: ['a'] });
  check('survivor is kept even when selected', p.entities.length === 0, p.entities);
  check('no-changes flag when survivor selected', p.changes === false, p.changes);
}
{
  // Selecting both members still keeps the first of the group.
  const d = doc([L('a'), L('b'), L('c')]);
  const p = planCleanup(d, { selection: ['a', 'b', 'c'] });
  check('selecting a whole group keeps one', p.entities.length === 2, p.entities);
  check('kept entity is the first', !p.entities.includes('a'), p.entities);
}
{
  // Unselected duplicates are untouched in selection mode.
  const d = doc([L('a'), L('b'), L('x', 'A', [50, 0], [60, 0]), L('y', 'A', [50, 0], [60, 0])]);
  const p = planCleanup(d, { selection: ['x'] });
  check('unselected survivor behind a selected duplicate is untouched', p.entities.length === 0, p.entities);
  const p2 = planCleanup(d, { selection: ['y'] });
  check('selected duplicate is removed when a survivor exists', p2.entities.length === 1 && p2.entities[0] === 'y', p2.entities);
  const p3 = planCleanup(d, { selection: ['a', 'b'] });
  check('unselected duplicates outside the selection are left alone', p3.entities.length === 1 && p3.entities[0] === 'b', p3.entities);
}
{
  // Selection is a Set as well as an array.
  const d = doc([L('a'), L('b')]);
  const p = planCleanup(d, { selection: new Set(['b']) });
  check('accepts a Set for selection', p.entities.length === 1 && p.entities[0] === 'b', p.entities);
}
{
  // An empty selection means "whole drawing", not "do nothing quietly".
  const d = doc([L('a'), L('b')]);
  const p = planCleanup(d, { selection: [] });
  check('empty selection falls back to drawing mode', p.mode === 'drawing', p.mode);
  check('empty selection still cleans duplicates', p.entities.includes('b'), p.entities);
}
{
  // Zero-length objects are only removed when selected.
  const d = doc([L('a'), L('z', 'A', [5, 5], [5, 5])]);
  const p = planCleanup(d, { selection: ['a'] });
  check('unselected zero-length object is kept', p.entities.length === 0, p.entities);
  const p2 = planCleanup(d, { selection: ['z'] });
  check('selected zero-length object is removed', p2.entities.length === 1 && p2.entities[0] === 'z', p2.entities);
}

/* ---- locked layers ---- */
{
  const d = doc([L('a', 'L'), L('b', 'L')], {
    layers: [{ name: '0' }, { name: 'A' }, { name: 'L', locked: true }]
  });
  const p = planCleanup(d, { tolerance: 0.01 });
  check('locked-layer duplicates are kept in drawing mode', p.entities.length === 0, p.entities);
  check('locked-layer skips are counted', p.counts.skippedLocked > 0, p.counts);
  const p2 = planCleanup(d, { selection: ['a', 'b'] });
  check('locked-layer duplicates are kept in selection mode', p2.entities.length === 0, p2.entities);
}
{
  // A locked-layer object must not be deleted even if the duplicate is unlocked.
  const d = doc([L('a', 'A'), L('b', 'A')], {
    layers: [{ name: '0' }, { name: 'A', locked: true }]
  });
  const p = planCleanup(d, { selection: ['b'] });
  check('locked survivor blocks deletion', p.entities.length === 0, p.entities);
}
{
  // Locked empty layers are never swept.
  const d = doc([L('a', 'A')], { layers: [{ name: '0' }, { name: 'A' }, { name: 'Z', locked: true }] });
  const p = planCleanup(d, {});
  check('locked empty layer is kept', !p.layers.includes('Z'), p.layers);
}

/* ---- purity ---- */
{
  const d = doc([L('a'), L('b')]);
  const before = JSON.stringify(d);
  planCleanup(d, { selection: ['b'] });
  check('planner does not mutate the document', JSON.stringify(d) === before);
}

if (fails) {
  console.log('\n' + fails + ' check(s) failed');
  process.exit(1);
}
console.log('\nAll selection-cleanup checks passed');
