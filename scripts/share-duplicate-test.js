#!/usr/bin/env node
'use strict';
// End-to-end ownership isolation test for share duplication.
// Usage: WEB_CAD_BASE_URL=https://candidate.example node scripts/share-duplicate-test.js
const assert = require('node:assert/strict');
const base = String(process.env.WEB_CAD_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const suffix = `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
async function request(path, { jar, method = 'GET', body } = {}) {
  const headers = {};
  if (jar && jar.cookie) headers.Cookie = jar.cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const cookie = response.headers.get('set-cookie');
  if (cookie && jar) jar.cookie = cookie.split(';', 1)[0];
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { response, data };
}
(async () => {
  const owner = { cookie: '' }, recipient = { cookie: '' }, stranger = { cookie: '' };
  let sourceId, copyId, token;
  const original = { layers: [{ name: '0', visible: true }, { name: 'Walls', visible: true }], entities: [{ id: 1, type: 'line', layer: 'Walls', p1: [0, 0], p2: [100, 50] }], currentLayer: 'Walls', units: 'mm' };
  try {
    for (const [prefix, jar] of [['dupowner', owner], ['dupuser', recipient]]) {
      const r = await request('/api/auth/register', { jar, method: 'POST', body: { username: `${prefix}_${suffix}`.slice(0, 24), password: `T-${suffix}-pw` } });
      assert.equal(r.response.status, 201, 'register test user');
    }
    let r = await request('/api/drawings', { jar: owner, method: 'POST', body: { name: `Shared ${suffix}`, data: original } });
    assert.equal(r.response.status, 201); sourceId = r.data.drawing.id;
    r = await request(`/api/drawings/${sourceId}/share`, { jar: owner, method: 'POST' });
    assert.equal(r.response.status, 200); token = r.data.share_token;
    r = await request(`/api/share/${token}/duplicate`, { jar: stranger, method: 'POST', body: {} });
    assert.equal(r.response.status, 401, 'anonymous duplication requires authentication');
    r = await request('/api/share/0000000000000000/duplicate', { jar: recipient, method: 'POST', body: {} });
    assert.equal(r.response.status, 404, 'invalid token does not duplicate anything');
    r = await request(`/api/share/${token}/duplicate`, { jar: recipient, method: 'POST', body: {} });
    assert.equal(r.response.status, 201, 'recipient can duplicate a valid share');
    copyId = r.data.drawing.id;
    assert.notEqual(copyId, sourceId, 'copy has distinct drawing id');
    assert.equal(r.data.drawing.name, `Copy of Shared ${suffix}`);
    assert.equal(r.data.edit_path, `/d/${encodeURIComponent(copyId)}`);
    assert.match(r.data.message, /saved separately/i);
    assert.deepEqual(r.data.data, original, 'geometry, layers, and document settings are identical');
    assert.equal(r.data.drawing.owner, undefined, 'response does not need owner metadata');
    r = await request(`/api/drawings/${copyId}`, { jar: recipient });
    assert.equal(r.response.status, 200, 'recipient owns and can open copy');
    assert.deepEqual(r.data.drawing.data, original);
    r = await request(`/api/drawings/${copyId}`, { jar: owner });
    assert.equal(r.response.status, 403, 'source owner cannot edit recipient copy');
    r = await request(`/api/drawings/${sourceId}`, { jar: owner });
    assert.equal(r.response.status, 200, 'original remains available');
    assert.deepEqual(r.data.drawing.data, original, 'original is unchanged');
    assert.equal(r.data.drawing.rev, 1, 'duplication does not increment original revision');
    r = await request(`/api/drawings/${copyId}`, { jar: recipient, method: 'PUT', body: { data: { ...original, entities: [...original.entities, { id: 2, type: 'circle', c: [5, 5], r: 2 }] } } });
    assert.ok([200, 204].includes(r.response.status), 'new copy is editable');
    r = await request(`/api/drawings/${sourceId}`, { jar: owner });
    assert.equal(r.data.drawing.data.entities.length, 1, 'editing copy does not mutate original');
    console.log(`PASS share duplication preserves source and creates independent editable copy (${base})`);
  } finally {
    if (copyId) await request(`/api/drawings/${copyId}`, { jar: recipient, method: 'DELETE' }).catch(() => {});
    if (sourceId) await request(`/api/drawings/${sourceId}`, { jar: owner, method: 'DELETE' }).catch(() => {});
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
