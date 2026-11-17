// Unit regression tests for the version-diff helpers (lib/doc-diff.js).
// Run with: node test/doc-diff.test.js
const { summarizeDocDiff, boundsOfDoc } = require('../lib/doc-diff');

let fails = 0;
function check(name, ok, extra) {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name);
  if (!ok) { fails++; if (extra !== undefined) console.log('      got: ' + JSON.stringify(extra)); }
}

const docA = {
  layers: [{ name: '0' }],
  entities: [
    { id: 1, type: 'line', layer: '0', p1: [0, 0], p2: [10, 0] },
    { id: 2, type: 'circle', layer: '0', c: [5, 5], r: 2 },
  ],
};
const docB = {
  layers: [{ name: '0' }, { name: 'Walls' }],
  entities: [
    { id: 1, type: 'line', layer: '0', p1: [0, 0], p2: [20, 0] },
    { id: 3, type: 'rect', layer: 'Walls', p1: [1, 1], p2: [5, 5] },
  ],
};

// Regression: the summary line builder used to pass an entity array where a
// type tally was expected and threw "Cannot convert undefined or null to
// object", turning every non-empty diff into an HTTP 500.
{
  let out = null, err = null;
  try { out = summarizeDocDiff(docA, docB, 'A', 'B'); } catch (e) { err = e; }
  check('non-empty diff does not throw', err === null, err && err.message);
  check('added tally is a rect', out && out.added_by_type && out.added_by_type.rect === 1, out && out.added_by_type);
  check('removed tally is a circle', out && out.removed_by_type && out.removed_by_type.circle === 1, out && out.removed_by_type);
  check('changed tally is a line', out && out.changed_by_type && out.changed_by_type.line === 1, out && out.changed_by_type);
  check('counts add up', out && out.counts.added === 1 && out.counts.removed === 1 && out.counts.changed === 1, out && out.counts);
  check('layer Walls reported added', out && Array.isArray(out.layers_added) && out.layers_added.includes('Walls'), out && out.layers_added);
  check('summary mentions the tallies', out && /added/.test(out.lines.join(' ')), out && out.lines);
  check('summary one-liner is short', out && out.summary.length <= 140, out && out.summary);
}

// Identical documents report no changes and never throw.
{
  const same = summarizeDocDiff(docA, docA, 'A', 'B');
  check('identical docs: no changes', same.counts.added === 0 && same.counts.removed === 0 && same.counts.changed === 0, same.counts);
  check('identical docs: no-changes wording', /no drawing changes/i.test(same.lines.join(' ')), same.lines);
}

// Adding-only and removing-only diffs both exercise the tally formatter.
{
  const added = summarizeDocDiff({ entities: [] }, docA, 'A', 'B');
  check('add-only diff tallies both types', added.added_by_type.line === 1 && added.added_by_type.circle === 1, added.added_by_type);
  const removed = summarizeDocDiff(docA, { entities: [] }, 'A', 'B');
  check('remove-only diff tallies both types', removed.removed_by_type.line === 1 && removed.removed_by_type.circle === 1, removed.removed_by_type);
}

// Malformed / partial documents must degrade instead of crashing.
{
  let err = null;
  try { summarizeDocDiff(null, undefined, 'A', 'B'); } catch (e) { err = e; }
  check('null documents do not throw', err === null, err && err.message);
  const b = boundsOfDoc({ entities: [{ type: 'circle', c: [0, 0], r: 3 }] });
  check('bounds include circle radius', b && b.x0 === -3 && b.x1 === 3, b);
  check('bounds of empty doc are null', boundsOfDoc({ entities: [] }) === null);
}

// Layer arrays may hold {name,...} objects (app format) or bare strings
// (API clients / early snapshots); both must report layer adds/removes.
{
  const objLayers = summarizeDocDiff({ layers: [{ name: '0' }], entities: [] }, { layers: [{ name: '0' }, { name: 'Walls' }], entities: [] }, 'A', 'B');
  check('object layers report layer added', objLayers.layers_added.includes('Walls'), objLayers.layers_added);
  const strLayers = summarizeDocDiff({ layers: ['0'], entities: [] }, { layers: ['0', 'Walls'], entities: [] }, 'A', 'B');
  check('string layers report layer added', strLayers.layers_added.includes('Walls'), strLayers.layers_added);
  const strRemoved = summarizeDocDiff({ layers: ['0', 'Walls'], entities: [] }, { layers: ['0'], entities: [] }, 'A', 'B');
  check('string layers report layer removed', strRemoved.layers_removed.includes('Walls'), strRemoved.layers_removed);
}

console.log(fails === 0 ? 'ALL PASS doc-diff' : fails + ' FAILED doc-diff');
process.exitCode = fails === 0 ? 0 : 1;
