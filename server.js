const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '12mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

// Strip sslmode from the connection string so pg does not override our ssl option.
function cleanConnectionString(raw) {
  return String(raw || '')
    .replace(/[?&]sslmode=[^&]*/g, '')
    .replace(/\?&/, '?')
    .replace(/\?$/, '');
}

function makePool(url, useSsl) {
  return new Pool({
    connectionString: cleanConnectionString(url),
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    max: 6,
  });
}

let pool = makePool(process.env.DATABASE_URL, false);

// Probe both TLS and plain connections once, then keep whichever works.
async function pickPool(url) {
  const candidates = [makePool(url, true), makePool(url, false)];
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    try {
      await candidates[i].query('SELECT 1');
      const chosen = candidates.splice(i, 1)[0];
      candidates.forEach((p) => p.end().catch(() => {}));
      return chosen;
    } catch (err) {
      lastErr = err; // try the next transport
    }
  }
  throw new Error('could not connect to database over TLS or plain TCP: ' + (lastErr && lastErr.message));
}

const EMPTY_DOC = {
  layers: [
    { name: '0', color: '#d9dee7', visible: true, locked: false, lineweight: 1 },
    { name: 'Walls', color: '#7fd1ff', visible: true, locked: false, lineweight: 2 },
    { name: 'Dims', color: '#ffb454', visible: true, locked: false, lineweight: 1 },
    { name: 'Text', color: '#a6e3a1', visible: true, locked: false, lineweight: 1 },
  ],
  entities: [],
  currentLayer: 'Walls',
};

async function init() {
  pool = await pickPool(process.env.DATABASE_URL);
  // DDL/seed uses the migration role when present: the runtime role cannot CREATE in schema app.
  if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required');
  const admin = await pickPool(process.env.MIGRATION_DATABASE_URL);
  const db = admin;
  await db.query(`
    CREATE TABLE IF NOT EXISTS drawings (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data JSONB NOT NULL,
      rev INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS drawing_versions (
      id SERIAL PRIMARY KEY,
      drawing_id TEXT NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
      rev INTEGER NOT NULL,
      data JSONB NOT NULL,
      label TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query('ALTER TABLE drawing_versions ADD COLUMN IF NOT EXISTS label TEXT');
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      pass_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);
  await db.query('ALTER TABLE drawings ADD COLUMN IF NOT EXISTS owner TEXT');
  await db.query('ALTER TABLE drawings ADD COLUMN IF NOT EXISTS share_token TEXT');
  await db.query('ALTER TABLE drawings ADD COLUMN IF NOT EXISTS share_expires_at TIMESTAMPTZ');
  await db.query('CREATE UNIQUE INDEX IF NOT EXISTS drawings_share_token_idx ON drawings (share_token) WHERE share_token IS NOT NULL');
  const { rows } = await db.query('SELECT count(*)::int AS n FROM drawings');
  if (rows[0].n === 0) await seed(db);
  if (admin !== pool) await admin.end().catch(() => {});
}

function newId() {
  return 'd' + crypto.randomBytes(6).toString('hex');
}

function sampleDoc() {
  const doc = JSON.parse(JSON.stringify(EMPTY_DOC));
  const e = doc.entities;
  const push = (o) => { o.id = 'e' + (e.length + 1); e.push(o); };
  // simple floor plan sketch
  push({ type: 'rect', layer: 'Walls', p1: [0, 0], p2: [720, 480] });
  push({ type: 'line', layer: 'Walls', p1: [420, 0], p2: [420, 480] });
  push({ type: 'line', layer: 'Walls', p1: [420, 260], p2: [720, 260] });
  push({ type: 'arc', layer: 'Walls', c: [520, 105], r: 70, a0: 180, a1: 0 });
  push({ type: 'line', layer: 'Walls', p1: [450, 105], p2: [450, 150] });
  push({ type: 'line', layer: 'Walls', p1: [590, 105], p2: [590, 150] });
  push({ type: 'circle', layer: '0', c: [200, 330], r: 46 });
  push({ type: 'text', layer: 'Text', p: [150, 240], text: 'LIVING', size: 34 });
  push({ type: 'text', layer: 'Text', p: [520, 400], text: 'BED', size: 34 });
  push({ type: 'text', layer: 'Text', p: [470, 200], text: 'BATH', size: 26 });
  push({ type: 'dim', layer: 'Dims', p1: [0, 0], p2: [720, 0], offset: -70, text: null });
  push({ type: 'dim', layer: 'Dims', p1: [720, 0], p2: [720, 480], offset: 70, text: null });
  return doc;
}

async function seed(db) {
  const id = newId();
  await db.query('INSERT INTO drawings (id, name, data) VALUES ($1, $2, $3)', [
    id,
    'Sample Floor Plan',
    JSON.stringify(sampleDoc()),
  ]);
}

// ---- Auth: users, sessions, cookie login --------------------------------------
const COOKIE_NAME = 'WebCAD_session';
const SESSION_MAX_AGE_S = 30 * 24 * 3600;

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(password), s, 64).toString('hex');
  return s + ':' + h;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 2) return false;
  const h = crypto.scryptSync(String(password), parts[0], 64).toString('hex');
  const a = Buffer.from(h, 'utf8');
  const b = Buffer.from(parts[1], 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    COOKIE_NAME + '=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_MAX_AGE_S);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

async function createSession(res, username) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query("INSERT INTO sessions (token, username, expires_at) VALUES ($1, $2, now() + ($3 * interval '1 second'))", [
    token, username, SESSION_MAX_AGE_S,
  ]);
  setSessionCookie(res, token);
}

// Attach req.user when a valid session cookie is present. Registered BEFORE
// every route so drawing endpoints can scope rows to the logged-in user.
app.use(async (req, res, next) => {
  try {
    const token = parseCookies(req)[COOKIE_NAME];
    if (token) {
      const { rows } = await pool.query(
        `SELECT s.username AS u FROM sessions s
          WHERE s.token = $1 AND s.expires_at > now()`, [token]
      );
      if (rows.length) req.user = rows[0].u;
    }
  } catch (err) {
    console.warn('session lookup failed:', err.message);
  }
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to save drawings to your account' });
  next();
}

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'up' });
  } catch (err) {
    res.status(500).json({ ok: false, db: 'down', error: String(err.message || err) });
  }
});

app.get('/api/drawings', async (req, res) => {
  try {
    const { rows } = await pool.query(
      req.user
        ? `SELECT id, name, owner, rev, created_at, updated_at,
                  (owner IS NOT NULL AND owner = $1 AND share_token IS NOT NULL AND
                    (share_expires_at IS NULL OR share_expires_at > now())) AS is_shared,
                  (owner IS NOT NULL AND owner = $1 AND share_token IS NOT NULL) AS has_share_link,
                  share_expires_at,
                  jsonb_array_length(COALESCE(data->'entities', '[]'::jsonb)) AS entity_count
             FROM drawings
            WHERE owner IS NULL OR owner = $1
            ORDER BY updated_at DESC LIMIT 100`
        : `SELECT id, name, owner, rev, created_at, updated_at,
                  FALSE AS is_shared, FALSE AS has_share_link, NULL AS share_expires_at,
                  jsonb_array_length(COALESCE(data->'entities', '[]'::jsonb)) AS entity_count
             FROM drawings
            WHERE owner IS NULL
            ORDER BY updated_at DESC LIMIT 100`,
      req.user ? [req.user] : []
    );
    res.json({ drawings: rows });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/drawings', requireAuth, async (req, res) => {
  try {
    const doc = req.body && req.body.data ? req.body.data : EMPTY_DOC;
    const name = (req.body && req.body.name) || 'Untitled Drawing';
    const id = newId();
    const { rows } = await pool.query(
      'INSERT INTO drawings (id, name, data, owner) VALUES ($1, $2, $3, $4) RETURNING id, name, rev, updated_at',
      [id, name, JSON.stringify(doc), req.user]
    );
    res.status(201).json({ drawing: rows[0], data: doc });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/drawings/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, data, rev, created_at, updated_at, owner,
              (owner IS NOT NULL AND owner = $2 AND share_token IS NOT NULL AND
               (share_expires_at IS NULL OR share_expires_at > now())) AS is_shared,
              (owner IS NOT NULL AND owner = $2 AND share_token IS NOT NULL) AS has_share_link,
              share_expires_at
         FROM drawings WHERE id = $1`,
      [req.params.id, req.user || null]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    if (rows[0].owner && rows[0].owner !== req.user) {
      return res.status(403).json({ error: 'This drawing belongs to another user' });
    }
    res.json({ drawing: rows[0] });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.put('/api/drawings/:id', async (req, res) => {
  try {
    const { rows: found } = await pool.query(
      'SELECT id, owner FROM drawings WHERE id = $1',
      [req.params.id]
    );
    if (!found.length) return res.status(404).json({ error: 'not found' });
    if (found[0].owner && found[0].owner !== req.user) {
      return res.status(403).json({ error: 'This drawing belongs to another user' });
    }
    const doc = req.body && req.body.data;
    if (!doc || !Array.isArray(doc.entities)) return res.status(400).json({ error: 'data.entities required' });
    const name = (req.body && req.body.name) || 'Untitled Drawing';
    const { rows } = await pool.query(
      `UPDATE drawings SET name = $2, data = $3, rev = rev + 1, updated_at = now()
        WHERE id = $1 RETURNING id, name, rev, updated_at`,
      [req.params.id, name, JSON.stringify(doc)]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    if (rows[0].rev % 10 === 0) {
      await pool.query('INSERT INTO drawing_versions (drawing_id, rev, data) VALUES ($1, $2, $3)', [
        req.params.id, rows[0].rev, JSON.stringify(doc),
      ]);
    }
    res.json({ drawing: rows[0] });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---- Owner-only version history: list, checkpoint, restore -------------------
async function ownedDrawingOr(req, res) {
  if (!req.user) { res.status(401).json({ error: 'Sign in to manage version history' }); return null; }
  const { rows } = await pool.query('SELECT id, owner FROM drawings WHERE id = $1', [req.params.id]);
  if (!rows.length) { res.status(404).json({ error: 'not found' }); return null; }
  if (rows[0].owner !== req.user) { res.status(403).json({ error: 'Only the owner can manage version history' }); return null; }
  return rows[0];
}

function entityCountOf(doc) {
  return doc && Array.isArray(doc.entities) ? doc.entities.length : 0;
}

app.get('/api/drawings/:id/versions', async (req, res) => {
  try {
    if (!(await ownedDrawingOr(req, res))) return;
    const { rows } = await pool.query(
      `SELECT id, rev, label, created_at, jsonb_array_length(COALESCE(data->'entities', '[]'::jsonb)) AS entity_count
         FROM drawing_versions WHERE drawing_id = $1 ORDER BY id DESC LIMIT 50`,
      [req.params.id]
    );
    res.json({ versions: rows });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/drawings/:id/versions', async (req, res) => {
  try {
    if (!(await ownedDrawingOr(req, res))) return;
    const label = String((req.body && req.body.label) || 'Checkpoint').slice(0, 80);
    const { rows } = await pool.query(
      `INSERT INTO drawing_versions (drawing_id, rev, data, label)
       SELECT id, rev, data, $2 FROM drawings WHERE id = $1
       RETURNING id, rev, label, created_at`,
      [req.params.id, label]
    );
    res.status(201).json({ version: rows[0] });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/drawings/:id/versions/:versionId/restore', async (req, res) => {
  const client = await pool.connect();
  try {
    if (!(await ownedDrawingOr(req, res))) { client.release(); return; }
    const versionId = Number(req.params.versionId);
    if (!Number.isInteger(versionId)) { client.release(); return res.status(400).json({ error: 'invalid version id' }); }
    await client.query('BEGIN');
    const { rows: lock } = await client.query('SELECT id, data, rev FROM drawings WHERE id = $1 FOR UPDATE', [req.params.id]);
    const { rows: ver } = await client.query(
      'SELECT id, rev, data FROM drawing_versions WHERE id = $1 AND drawing_id = $2',
      [versionId, req.params.id]
    );
    if (!lock.length || !ver.length) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ error: 'version not found' });
    }
    // Keep the pre-restore state so the restore itself is recoverable.
    await client.query(
      'INSERT INTO drawing_versions (drawing_id, rev, data, label) VALUES ($1, $2, $3, $4)',
      [req.params.id, lock[0].rev, JSON.stringify(lock[0].data), 'Before restore to rev ' + ver[0].rev]
    );
    const { rows } = await client.query(
      `UPDATE drawings SET data = $2, rev = rev + 1, updated_at = now()
        WHERE id = $1 RETURNING id, name, rev, updated_at`,
      [req.params.id, JSON.stringify(ver[0].data)]
    );
    await client.query('COMMIT');
    client.release();
    res.json({ drawing: rows[0], data: ver[0].data, restored_from_rev: ver[0].rev, entity_count: entityCountOf(ver[0].data) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.delete('/api/drawings/:id', async (req, res) => {
  try {
    const { rows: found } = await pool.query(
      'SELECT id, owner FROM drawings WHERE id = $1',
      [req.params.id]
    );
    if (!found.length) return res.status(404).json({ error: 'not found' });
    if (found[0].owner && found[0].owner !== req.user) {
      return res.status(403).json({ error: 'This drawing belongs to another user' });
    }
    await pool.query('DELETE FROM drawings WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Auto-number a copy name among this user's drawings: 'X (copy)', then 'X (copy 2)', etc.
async function nextCopyName(baseName, owner) {
  const base = String(baseName || 'Drawing');
  const { rows } = await pool.query(
    "SELECT name FROM drawings WHERE owner = $1 AND (name = $2 OR name LIKE $2 || ' (copy%')",
    [owner, base]
  );
  const used = new Set(rows.map((r) => r.name));
  let n = 1;
  let candidate = base + ' (copy)';
  while (used.has(candidate)) {
    n += 1;
    candidate = base + ' (copy ' + n + ')';
  }
  return candidate;
}

app.post('/api/drawings/:id/duplicate', requireAuth, async (req, res) => {
  try {
    const { rows: found } = await pool.query('SELECT id, name, data, owner FROM drawings WHERE id = $1', [
      req.params.id,
    ]);
    if (!found.length) return res.status(404).json({ error: 'not found' });
    if (found[0].owner !== req.user) {
      return res.status(403).json({ error: 'Only the owner can duplicate this drawing' });
    }
    const id = newId();
    // Optional custom name from the request body; otherwise auto-number against the owner's drawings.
    let name = null;
    const wanted = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (wanted) name = wanted.slice(0, 120);
    if (!name) name = await nextCopyName(found[0].name, req.user);
    const { rows } = await pool.query(
      'INSERT INTO drawings (id, name, data, owner) VALUES ($1, $2, $3, $4) RETURNING id, name, rev, updated_at',
      [id, name, JSON.stringify(found[0].data), req.user]
    );
    res.status(201).json({ drawing: rows[0] });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

/* ---------- read-only share links ---------- */

app.post('/api/drawings/:id/share', requireAuth, async (req, res) => {
  try {
    const { rows: found } = await pool.query('SELECT id, owner, share_token FROM drawings WHERE id = $1', [
      req.params.id,
    ]);
    if (!found.length) return res.status(404).json({ error: 'not found' });
    if (found[0].owner !== req.user) {
      return res.status(403).json({ error: 'Only the owner can share this drawing' });
    }
    // Omitted/null/empty ttl means "keep it until revoked" (no expiry).
    const rawTtl = req.body ? req.body.ttl : undefined;
    const ttl = rawTtl === undefined || rawTtl === null || rawTtl === '' ? 'never' : rawTtl;
    const allowed = { '24h': 24, '7d': 168, '30d': 720, never: null };
    let hours;
    if (req.body && req.body.ttl_hours !== undefined) {
      hours = Number(req.body.ttl_hours);
      if (!Number.isFinite(hours) || hours <= 0 || hours > 8760) {
        return res.status(400).json({ error: 'ttl_hours must be greater than 0 and no more than 8760' });
      }
    } else {
      if (!Object.prototype.hasOwnProperty.call(allowed, ttl)) {
        return res.status(400).json({ error: 'ttl must be 24h, 7d, 30d, or never' });
      }
      hours = allowed[ttl];
    }
    const token = found[0].share_token || crypto.randomBytes(16).toString('hex');
    const { rows } = await pool.query(
      `UPDATE drawings SET share_token = $2,
         share_expires_at = CASE WHEN $3::double precision IS NULL THEN NULL
           ELSE now() + ($3::double precision * interval '1 hour') END
       WHERE id = $1 RETURNING share_expires_at`,
      [req.params.id, token, hours]
    );
    res.json({ share_token: token, share_path: '/s/' + token, share_expires_at: rows[0].share_expires_at });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.delete('/api/drawings/:id/share', requireAuth, async (req, res) => {
  try {
    const { rows: found } = await pool.query('SELECT id, owner FROM drawings WHERE id = $1', [req.params.id]);
    if (!found.length) return res.status(404).json({ error: 'not found' });
    if (found[0].owner !== req.user) {
      return res.status(403).json({ error: 'Only the owner can revoke this share link' });
    }
    await pool.query('UPDATE drawings SET share_token = NULL, share_expires_at = NULL WHERE id = $1', [req.params.id]);
    res.json({ ok: true, share_token: null });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Public, unauthenticated: a shared drawing is readable by anyone holding the token.
app.get('/api/share/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{16,64}$/.test(token)) return res.status(404).json({ error: 'not found' });
    const { rows } = await pool.query(
      'SELECT id, name, data, updated_at, share_expires_at FROM drawings WHERE share_token = $1',
      [token]
    );
    if (!rows.length) return res.status(404).json({ error: 'This share link is no longer available' });
    const d = rows[0];
    if (d.share_expires_at && new Date(d.share_expires_at).getTime() <= Date.now()) {
      return res.status(410).json({ error: 'This share link has expired', expired: true });
    }
    res.json({ drawing: { id: d.id, name: d.name, data: d.data, updated_at: d.updated_at }, readonly: true, share_expires_at: d.share_expires_at });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,24}$/;

app.post('/api/auth/register', async (req, res) => {
  try {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-24 letters, digits, - or _' });
    }
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const dupe = await pool.query('SELECT 1 FROM users WHERE username = $1', [username]);
    if (dupe.rows.length) return res.status(409).json({ error: 'That username is taken' });
    await pool.query('INSERT INTO users (username, pass_hash) VALUES ($1, $2)', [
      username, hashPassword(password),
    ]);
    await createSession(res, username);
    res.status(201).json({ user: { username } });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    const { rows } = await pool.query('SELECT pass_hash FROM users WHERE username = $1', [username]);
    if (!rows.length || !verifyPassword(password, rows[0].pass_hash)) {
      return res.status(401).json({ error: 'Wrong username or password' });
    }
    await createSession(res, username);
    res.json({ user: { username } });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = parseCookies(req)[COOKIE_NAME];
    if (token) await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  } catch (err) { /* still clear the cookie */ }
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.user ? { username: req.user } : null });
});

// ---- Agent tools (HMAC-signed) -------------------------------------------------
const AGENT_SECRET = process.env.UNTASKED_AGENT_TOOL_SECRET || '';

function verifyAgentRequest(req, res, next) {
  if (!AGENT_SECRET) return res.status(503).json({ error: 'agent tools not configured' });
  const sig = String(req.get('X-Untasked-Signature') || '');
  const ts = String(req.get('X-Untasked-Timestamp') || '');
  if (!sig || !ts) return res.status(401).json({ error: 'missing signature' });
  const tsMs = Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000;
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > 5 * 60 * 1000) {
    return res.status(401).json({ error: 'stale or invalid timestamp' });
  }
  const expected = crypto
    .createHmac('sha256', AGENT_SECRET)
    .update(ts + '\n')
    .update(req.rawBody || Buffer.alloc(0))
    .digest('hex');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'bad signature' });
  }
  next();
}

function normalizeAgentEntities(raw, layer) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (let i = 0; i < raw.length && i < 2000; i++) {
    const s = raw[i];
    if (!s || typeof s !== 'object' || typeof s.type !== 'string') continue;
    const e = Object.assign({}, s);
    e.type = s.type.toLowerCase();
    // The renderer reads `pts`; accept the `points` spelling the tool schema advertises.
    if (e.type === 'polyline' && !Array.isArray(e.pts) && Array.isArray(e.points)) {
      e.pts = e.points;
      delete e.points;
    }
    e.layer = s.layer || layer || 'Walls';
    e.id = s.id || 'e' + Date.now().toString(36) + i;
    out.push(e);
  }
  return out;
}

app.post('/agent/create-drawing', verifyAgentRequest, async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || 'Agent Drawing').slice(0, 120);
    const doc = JSON.parse(JSON.stringify(EMPTY_DOC));
    const layer = body.layer ? String(body.layer).slice(0, 60) : null;
    if (layer && !doc.layers.some((l) => l.name === layer)) {
      doc.layers.push({ name: layer, color: '#7fd1ff', visible: true, locked: false, lineweight: 1 });
    }
    const entities = normalizeAgentEntities(body.entities, layer);
    if (!entities) return res.status(400).json({ error: 'entities must be an array' });
    doc.entities = entities;
    const id = newId();
    const { rows } = await pool.query(
      'INSERT INTO drawings (id, name, data) VALUES ($1, $2, $3) RETURNING id, name, rev, updated_at',
      [id, name, JSON.stringify(doc)]
    );
    res.status(201).json({
      drawing: rows[0],
      entity_count: entities.length,
      view_url: '/d/' + id,
      api_url: '/api/drawings/' + id,
      note: 'Coordinates are in drawing units (mm). Supported types: line{p1,p2}, rect{p1,p2}, circle{c,r}, arc{c,r,a0,a1}, polyline{pts[]} (points[] also accepted), text{p,text,size}, dim{p1,p2,offset}.',
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/agent/append-entities', verifyAgentRequest, async (req, res) => {
  try {
    const body = req.body || {};
    const targetId = String((req.body && req.body.id) || '');
    if (!targetId) return res.status(400).json({ error: 'id required' });
    const { rows } = await pool.query('SELECT data FROM drawings WHERE id = $1', [targetId]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const doc = rows[0].data;
    const layer = body.layer ? String(body.layer).slice(0, 60) : null;
    if (layer && !doc.layers.some((l) => l.name === layer)) {
      doc.layers.push({ name: layer, color: '#7fd1ff', visible: true, locked: false, lineweight: 1 });
    }
    const entities = normalizeAgentEntities(body.entities, layer);
    if (!entities) return res.status(400).json({ error: 'entities must be an array' });
    doc.entities = (doc.entities || []).concat(entities);
    const upd = await pool.query(
      'UPDATE drawings SET data = $2, rev = rev + 1, updated_at = now() WHERE id = $1 RETURNING id, name, rev, updated_at',
      [targetId, JSON.stringify(doc)]
    );
    res.json({ drawing: upd.rows[0], entity_count: doc.entities.length, view_url: '/d/' + targetId });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.get('/d/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/s/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

init()
  .then(() => {
    app.listen(PORT, () => console.log('WebCAD listening on ' + PORT));
  })
  .catch((err) => {
    console.error('startup failed', err);
    process.exit(1);
  });
