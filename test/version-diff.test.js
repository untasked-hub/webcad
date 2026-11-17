#!/usr/bin/env node
'use strict';

// End-to-end test for the owner-only version diff summary endpoint.
// Needs a running server and a database.
// Usage: WEB_CAD_BASE_URL=https://candidate.example node test/version-diff.test.js
const assert = require('node:assert/strict');
const base = String(process.env.WEB_CAD_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const suffix = `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;

async function request(path, { jar, method = 'GET', body } = {}) {
  const headers = {};
  if (jar && jar.cookie) headers.Cookie = jar.cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const cookie = response.headers.get('set-cookie');
  if (cookie && jar) jar.cookie = cookie.split(';', 1)[0];
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { response, data };
}

const docA = {
  layers: ['0'],
  entities: [
    { id: 1, type: 'line', layer: '0', x1: 0, y1: 0, x2: 10, y2: 0 },
    { id: 2, type: 'circle', layer: '0', cx: 5, cy: 5, r: 2 },
  ],
  currentLayer: '0',
};
// docB: entity 1 moved (changed), entity 2 removed, entity 3 added, new layer 'Walls'
const docB = {
  layers: ['0', 'Walls'],
  entities: [
    { id: 1, type: 'line', layer: '0', x1: 0, y1: 0, x2: 20, y2: 0 },
    { id: 3, type: 'rect', layer: 'Walls', x: 1, y: 1, w: 4, h: 4 },
  ],
  currentLayer: 'Walls',
};

(async () => {
  const owner = { cookie: '' };
  const other = { cookie: '' };
  let drawingId;
  let otherDrawingId;
  let versionId;
  try {
    const reg = await request('/api/auth/register', {
      jar: owner, method: 'POST', body: { username: `diff_${suffix}`.slice(0, 24), password: `T-${suffix}-pw` },
    });
    assert.equal(reg.response.status, 201, `register: HTTP ${reg.response.status}`);

    let r = await request('/api/drawings', { jar: owner, method: 'POST', body: { name: `Diff ${suffix}`, data: docA } });
    assert.equal(r.response.status, 201, 'create drawing');
    drawingId = r.data.drawing.id;

    // checkpoint docA, then move the drawing to docB
    r = await request(`/api/drawings/${drawingId}/versions`, { jar: owner, method: 'POST', body: { label: 'Before edits' } });
    assert.equal(r.response.status, 201, 'owner checkpoint');
    versionId = r.data.version.id;

    r = await request(`/api/drawings/${drawingId}`, { jar: owner, method: 'PUT', body: { data: docB } });
    assert.ok([200, 204].includes(r.response.status), 'owner update drawing');

    // anonymous guard
    let g = await request(`/api/drawings/${drawingId}/versions/diff?a=${versionId}&b=current`, { jar: { cookie: '' } });
    assert.equal(g.response.status, 401, 'anonymous diff -> 401');

    // identical snapshots report no changes
    r = await request(`/api/drawings/${drawingId}/versions/diff?a=current&b=current`, { jar: owner });
    assert.equal(r.response.status, 200, 'owner diff current vs current');
    assert.equal(r.data.counts.added, 0, 'identical: no added');
    assert.equal(r.data.counts.removed, 0, 'identical: no removed');
    assert.equal(r.data.counts.changed, 0, 'identical: no changed');
    assert.match(r.data.summary, /no changes/i, 'identical summary says no changes');

    // checkpoint -> current: 1 added, 1 removed, 1 changed, layer added
    r = await request(`/api/drawings/${drawingId}/versions/diff?a=${versionId}&b=current`, { jar: owner });
    assert.equal(r.response.status, 200, 'owner diff version vs current');
    assert.equal(r.data.counts.entities_before, 2, 'before entity count');
    assert.equal(r.data.counts.entities_after, 2, 'after entity count');
    assert.equal(r.data.counts.added, 1, 'one entity added');
    assert.equal(r.data.counts.removed, 1, 'one entity removed');
    assert.equal(r.data.counts.changed, 1, 'one entity changed');
    assert.equal(r.data.added_by_type.rect, 1, 'added type tally');
    assert.equal(r.data.removed_by_type.circle, 1, 'removed type tally');
    assert.equal(r.data.changed_by_type.line, 1, 'changed type tally');
    assert.deepEqual(r.data.layers_added, ['Walls'], 'layer added');
    assert.deepEqual(r.data.layers_removed, [], 'no layer removed');
    assert.ok(Array.isArray(r.data.lines) && r.data.lines.length > 0, 'diff lines present');
    assert.ok(r.data.lines.length <= 20, 'diff lines capped at 20');
    assert.ok(typeof r.data.summary === 'string' && r.data.summary.length > 0, 'summary present');
    assert.ok(r.data.summary.length <= 140, 'summary <= 140 chars');
    assert.equal(r.data.a_rev, r.data.a_rev, 'a_rev present');
    assert.ok(Number.isInteger(r.data.b_rev), 'b_rev is an integer');

    // reversed direction flips added/removed
    r = await request(`/api/drawings/${drawingId}/versions/diff?a=current&b=${versionId}`, { jar: owner });
    assert.equal(r.response.status, 200, 'reverse diff');
    assert.equal(r.data.counts.added, 1, 'reverse: one added (circle)');
    assert.equal(r.data.counts.removed, 1, 'reverse: one removed (rect)');
    assert.equal(r.data.added_by_type.circle, 1, 'reverse added type tally');
    assert.deepEqual(r.data.layers_removed, ['Walls'], 'reverse layer removed');

    // invalid version id
    g = await request(`/api/drawings/${drawingId}/versions/diff?a=abc&b=current`, { jar: owner });
    assert.equal(g.response.status, 400, 'invalid version id -> 400');
    assert.match(String(g.data && g.data.error), /invalid version id/i, 'invalid id error text');

    // version id that belongs to another drawing
    r = await request('/api/drawings', { jar: owner, method: 'POST', body: { name: `Diff other ${suffix}`, data: docA } });
    assert.equal(r.response.status, 201, 'create second drawing');
    otherDrawingId = r.data.drawing.id;
    r = await request(`/api/drawings/${otherDrawingId}/versions`, { jar: owner, method: 'POST', body: { label: 'Other' } });
    assert.equal(r.response.status, 201, 'checkpoint second drawing');
    const foreignVersionId = r.data.version.id;
    g = await request(`/api/drawings/${drawingId}/versions/diff?a=${foreignVersionId}&b=current`, { jar: owner });
    assert.equal(g.response.status, 400, 'foreign version id -> 400');
    assert.match(String(g.data && g.data.error), /version not found/i, 'foreign version error text');

    // unknown drawing
    g = await request('/api/drawings/999999999/versions/diff?a=current&b=current', { jar: owner });
    assert.equal(g.response.status, 404, 'unknown drawing -> 404');

    // non-owner
    await request('/api/auth/register', {
      jar: other, method: 'POST', body: { username: `doth_${suffix}`.slice(0, 24), password: `T-${suffix}-pw` },
    });
    g = await request(`/api/drawings/${drawingId}/versions/diff?a=${versionId}&b=current`, { jar: other });
    assert.equal(g.response.status, 403, 'non-owner diff -> 403');

    console.log(`PASS version-diff-test against ${base} (drawing ${drawingId})`);
  } catch (err) {
    console.error(`FAIL version-diff-test against ${base} (drawing ${drawingId})`);
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  }
})();
