#!/usr/bin/env node
'use strict';

// End-to-end smoke test for owner-only version history and checkpoint restore.
// Usage: WEB_CAD_BASE_URL=https://candidate.example node scripts/history-restore-test.js
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

const docA = { layers: ['0'], entities: [{ id: 1, type: 'line' }], currentLayer: '0' };
const docB = { layers: ['0'], entities: [{ id: 1, type: 'line' }, { id: 2, type: 'circle' }], currentLayer: '0' };

(async () => {
  const owner = { cookie: '' };
  const other = { cookie: '' };
  let drawingId;
  try {
    const reg = await request('/api/auth/register', {
      jar: owner, method: 'POST', body: { username: `hist_${suffix}`.slice(0, 24), password: `T-${suffix}-pw` },
    });
    assert.equal(reg.response.status, 201, `register: HTTP ${reg.response.status}`);

    let r = await request('/api/drawings', { jar: owner, method: 'POST', body: { name: `History ${suffix}`, data: docA } });
    assert.equal(r.response.status, 201, 'create drawing');
    drawingId = r.data.drawing.id;

    // guards: anonymous and (later) non-owner
    let g = await request(`/api/drawings/${drawingId}/versions`, { jar: { cookie: '' } });
    assert.equal(g.response.status, 401, 'anonymous versions list -> 401');

    r = await request(`/api/drawings/${drawingId}/versions`, { jar: owner });
    assert.equal(r.response.status, 200, 'owner list versions');
    assert.ok(Array.isArray(r.data.versions), 'versions is an array');

    r = await request(`/api/drawings/${drawingId}/versions`, { jar: owner, method: 'POST', body: { label: 'First checkpoint' } });
    assert.equal(r.response.status, 201, 'owner checkpoint');
    const versionId = r.data.version.id;
    assert.equal(r.data.version.label, 'First checkpoint');

    // mutate the drawing, then restore the checkpoint
    r = await request(`/api/drawings/${drawingId}`, { jar: owner, method: 'PUT', body: { data: docB } });
    assert.ok([200, 204].includes(r.response.status), 'owner update drawing');

    r = await request(`/api/drawings/${drawingId}/versions`, { jar: owner });
    assert.ok(r.data.versions.length >= 1, 'at least one version listed');
    assert.ok(r.data.versions.every((v) => !('data' in v)), 'version list omits full data');

    r = await request(`/api/drawings/${drawingId}/versions/${versionId}/restore`, { jar: owner, method: 'POST' });
    assert.equal(r.response.status, 200, 'owner restore');
    assert.equal(r.data.entity_count, 1, 'restored doc has 1 entity');
    assert.equal(r.data.restored_from_rev, r.data.restored_from_rev || 0 + 0, 'restore reports rev');

    r = await request(`/api/drawings/${drawingId}`, { jar: owner });
    assert.equal(r.response.status, 200, 'read detail after restore');
    assert.equal(r.data.drawing.data.entities.length, 1, 'detail reflects restored data');

    // non-owner
    await request('/api/auth/register', {
      jar: other, method: 'POST', body: { username: `othr_${suffix}`.slice(0, 24), password: `T-${suffix}-pw` },
    });
    g = await request(`/api/drawings/${drawingId}/versions`, { jar: other });
    assert.equal(g.response.status, 403, 'non-owner versions list -> 403');
    g = await request(`/api/drawings/${drawingId}/versions`, { jar: other, method: 'POST', body: { label: 'x' } });
    assert.equal(g.response.status, 403, 'non-owner checkpoint -> 403');
    g = await request(`/api/drawings/${drawingId}/versions/${versionId}/restore`, { jar: other, method: 'POST' });
    assert.equal(g.response.status, 403, 'non-owner restore -> 403');

    g = await request(`/api/drawings/${drawingId}/versions/999999/restore`, { jar: owner, method: 'POST' });
    assert.equal(g.response.status, 404, 'restore unknown version -> 404');

    console.log(`PASS history-restore-test against ${base} (drawing ${drawingId})`);
  } catch (err) {
    console.error(`FAIL history-restore-test against ${base} (drawing ${drawingId})`);
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  }
})();
