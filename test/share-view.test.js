// Saved-view share payload and renderer isolation regression tests.
// Run with: node test/share-view.test.js
'use strict';
const assert = require('node:assert/strict');
const { parseShareView, applyShareView } = require('../lib/share-view');

const parsed = parseShareView({ x: 125.5, y: -42, zoom: 2.5, hiddenLayers: ['Walls', 'Walls', ''] });
assert.equal(parsed.ok, true);
assert.deepEqual(parsed.view, { x: 125.5, y: -42, zoom: 2.5, hiddenLayers: ['Walls'] });
assert.equal(parseShareView({ x: 1e8, y: 0, zoom: 1 }).ok, false);
assert.equal(parseShareView({ x: 0, y: 0, zoom: 100 }).ok, false);
assert.equal(parseShareView({ x: 0, y: 0, zoom: 1, hiddenLayers: new Array(41).fill('x') }).ok, false);

const original = { layers: [{ name: 'Walls', visible: true }, { name: 'Dims', visible: true }], entities: [{ layer: 'Walls' }] };
const result = applyShareView(original, parsed.view);
assert.notEqual(result.data, original);
assert.equal(result.data.layers[0].visible, false);
assert.equal(result.data.layers[1], original.layers[1]);
assert.equal(original.layers[0].visible, true, 'share view must not mutate source document');
assert.equal(result.data.entities, original.entities, 'render copy should preserve geometry');
console.log('PASS saved view validation and non-mutating layer visibility');
