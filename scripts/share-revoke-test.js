#!/usr/bin/env node
'use strict';

// End-to-end regression test for owner-only drawing share links.
// Usage: WEB_CAD_BASE_URL=https://candidate.example node scripts/share-revoke-test.js
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
  try { data = text ? JSON.parse(text) : null; } catch { /* endpoint returned non-JSON */ }
  return { response, data };
}

async function register(username, jar) {
  const { response, data } = await request('/api/auth/register', {
    jar,
    method: 'POST',
    body: { username, password: `T-${suffix}-test-password` },
  });
  assert.equal(response.status, 201, `register ${username}: HTTP ${response.status} ${JSON.stringify(data)}`);
}

(async () => {
  const owner = { cookie: '' };
  const other = { cookie: '' };
  const anonymous = { cookie: '' };
  let drawingId;
  try {
    await register(`owner_${suffix}`.slice(0, 24), owner);
    await register(`other_${suffix}`.slice(0, 24), other);

    let result = await request('/api/drawings', {
      jar: owner,
      method: 'POST',
      body: { name: `Share test ${suffix}`, data: { layers: [], entities: [], currentLayer: '0' } },
    });
    assert.equal(result.response.status, 201, `create drawing: HTTP ${result.response.status}`);
    drawingId = result.data.drawing.id;

    result = await request(`/api/drawings/${encodeURIComponent(drawingId)}/share`, { jar: owner, method: 'POST' });
    assert.equal(result.response.status, 200, 'owner can create a share link');
    const firstToken = result.data.share_token;
    assert.ok(firstToken && /^[a-f0-9]{32}$/.test(firstToken), 'share token has expected format');

    result = await request('/api/drawings', { jar: owner });
    const ownerRow = result.data.drawings.find((drawing) => drawing.id === drawingId);
    assert.ok(ownerRow, 'owner list contains the drawing');
    assert.equal(ownerRow.is_shared, true, 'owner list reports shared state');
    assert.equal(Object.hasOwn(ownerRow, 'share_token'), false, 'owner list never returns raw token');

    result = await request(`/api/drawings/${encodeURIComponent(drawingId)}`, { jar: owner });
    assert.equal(result.response.status, 200, 'owner can read detail');
    assert.equal(result.data.drawing.is_shared, true, 'owner detail reports shared state');
    assert.equal(Object.hasOwn(result.data.drawing, 'share_token'), false, 'owner detail never returns raw token');

    result = await request(`/api/share/${firstToken}`, { jar: anonymous });
    assert.equal(result.response.status, 200, 'old share URL works before revocation');

    result = await request(`/api/drawings/${encodeURIComponent(drawingId)}/share`, { jar: other, method: 'DELETE' });
    assert.equal(result.response.status, 403, 'non-owner cannot revoke');

    result = await request(`/api/drawings/${encodeURIComponent(drawingId)}/share`, { jar: owner, method: 'DELETE' });
    assert.equal(result.response.status, 200, 'owner can revoke');
    assert.deepEqual(result.data, { ok: true, share_token: null });

    result = await request(`/api/share/${firstToken}`, { jar: anonymous });
    assert.equal(result.response.status, 404, 'revoked share URL is unavailable');

    result = await request('/api/drawings', { jar: owner });
    const revokedRow = result.data.drawings.find((drawing) => drawing.id === drawingId);
    assert.equal(revokedRow.is_shared, false, 'owner list reports unshared state');

    result = await request(`/api/drawings/${encodeURIComponent(drawingId)}/share`, { jar: owner, method: 'POST' });
    assert.equal(result.response.status, 200, 'owner can share again');
    assert.notEqual(result.data.share_token, firstToken, 're-sharing issues a distinct token');
    result = await request(`/api/share/${result.data.share_token}`, { jar: anonymous });
    assert.equal(result.response.status, 200, 'new share URL works');

    result = await request('/api/drawings', { jar: anonymous });
    assert.ok(!result.data.drawings.some((drawing) => drawing.id === drawingId), 'anonymous list does not reveal owner drawing');
    assert.ok(result.data.drawings.every((drawing) => drawing.is_shared === false), 'anonymous list never discloses share status');

    console.log(`PASS: owner-only sharing, token privacy, revoke, old-link invalidation, re-share (${base})`);
  } finally {
    if (drawingId && owner.cookie) {
      await request(`/api/drawings/${encodeURIComponent(drawingId)}`, { jar: owner, method: 'DELETE' }).catch(() => {});
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
