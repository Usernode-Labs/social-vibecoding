const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const path = require('path');

const initialUsers = () => [
  { id: 1, username: 'alice', profile_published: false, profile_display_name: null, profile_bio: null, profile_avatar_url: null, profile_disabled_at: null, email: 'alice@example.test', usernode_pubkey: 'ut1secret' },
  { id: 2, username: 'bob', profile_published: true, profile_display_name: 'Bob Builder', profile_bio: 'Ships useful things.', profile_avatar_url: 'https://images.example.test/bob.png', profile_disabled_at: null, email: 'bob@example.test', usernode_pubkey: 'ut1private' },
  { id: 9, username: 'admin', profile_published: false, profile_display_name: null, profile_bio: null, profile_avatar_url: null, profile_disabled_at: null },
];

function makePool() {
  const state = { users: initialUsers(), reports: [], calls: [] };
  const query = async (sql, params = []) => {
    const s = String(sql); state.calls.push({ sql: s, params });
    if (/SELECT username, profile_display_name/.test(s) && /profile_published = TRUE/.test(s)) {
      const u = state.users.find((x) => x.username === params[0] && x.profile_published && !x.profile_disabled_at);
      return { rows: u ? [{ ...u }] : [] };
    }
    if (/SELECT username, profile_published/.test(s) && /WHERE id = \$1/.test(s)) {
      const u = state.users.find((x) => x.id === params[0]); return { rows: u ? [{ ...u }] : [] };
    }
    if (/UPDATE users/.test(s) && /profile_published = \$1/.test(s)) {
      const u = state.users.find((x) => x.id === params[4]);
      Object.assign(u, { profile_published: params[0], profile_display_name: params[1], profile_bio: params[2], profile_avatar_url: params[3] });
      return { rows: [{ ...u }] };
    }
    if (/UPDATE users/.test(s) && /profile_display_name = NULL/.test(s)) {
      const u = state.users.find((x) => x.id === params[0]);
      Object.assign(u, { profile_published: false, profile_display_name: null, profile_bio: null, profile_avatar_url: null });
      return { rows: [] };
    }
    if (/SELECT id FROM users/.test(s) && /FOR KEY SHARE/.test(s)) {
      const target = state.users.find((x) => x.username === params[0] && x.profile_published && !x.profile_disabled_at);
      return { rows: target ? [{ id: target.id }] : [] };
    }
    if (/INSERT INTO profile_reports/.test(s)) {
      const target = state.users.find((x) => x.id === params[0]);
      if (target && !state.reports.some((r) => r.profile_user_id === target.id && r.reporter_user_id === params[1] && r.status === 'pending')) {
        state.reports.push({ id: state.reports.length + 1, profile_user_id: target.id, reporter_user_id: params[1], reason: params[2], detail: params[3], status: 'pending' });
      }
      return { rows: [], rowCount: target ? 1 : 0 };
    }
    if (/FROM profile_reports pr/.test(s)) {
      return { rows: state.reports.filter((r) => r.status === params[0]).map((r) => ({ ...r, profile_username: state.users.find((u) => u.id === r.profile_user_id).username, reporter_username: state.users.find((u) => u.id === r.reporter_user_id).username })) };
    }
    if (/profile_disabled_at = CASE/.test(s)) {
      const u = state.users.find((x) => x.username === params[3]);
      if (!u) return { rows: [] };
      u.profile_disabled_at = params[0] ? new Date().toISOString() : null;
      return { rows: [{ id: u.id, username: u.username }] };
    }
    if (/UPDATE profile_reports SET status = 'resolved'/.test(s)) {
      for (const r of state.reports) if (r.profile_user_id === params[1] && r.status === 'pending') r.status = 'resolved';
      return { rows: [] };
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(s.trim())) return { rows: [] };
    throw new Error(`Unhandled SQL: ${s.slice(0, 120)}`);
  };
  return { state, query, connect: async () => ({ query, release() {} }) };
}

async function start(pool) {
  const poolPath = require.resolve('../src/db/pool');
  const old = require.cache[poolPath];
  require.cache[poolPath] = { exports: { getPool: () => pool }, loaded: true, id: poolPath, filename: poolPath, paths: old?.paths || [] };
  delete require.cache[require.resolve('../src/routes/profiles')];
  const { profileRoutes } = require('../src/routes/profiles');
  if (old) require.cache[poolPath] = old; else delete require.cache[poolPath];
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    const name = req.headers['x-test-user'];
    if (name === 'alice') req.user = { id: 1, username: 'alice', isAdmin: false, canAdminWrite: false };
    if (name === 'bob') req.user = { id: 2, username: 'bob', isAdmin: false, canAdminWrite: false };
    if (name === 'admin') req.user = { id: 9, username: 'admin', isAdmin: true, canAdminWrite: true };
    if (name === 'viewer') req.user = { id: 8, username: 'viewer', isAdmin: true, canAdminWrite: false };
    next();
  });
  app.use(profileRoutes({}));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function request(srv, route, options = {}) {
  const res = await fetch(srv.url + route, options);
  return { status: res.status, headers: res.headers, body: await res.json() };
}

test('public exact lookup is opt-in, no-store, and returns only allowlisted fields', async () => {
  const pool = makePool(); const srv = await start(pool);
  try {
    const found = await request(srv, '/api/public/profiles/bob');
    assert.equal(found.status, 200);
    assert.match(found.headers.get('cache-control'), /no-store/);
    assert.deepEqual(Object.keys(found.body.profile).sort(), ['avatarUrl', 'bio', 'displayName', 'url', 'username']);
    assert.equal(JSON.stringify(found.body).includes('ut1private'), false);
    assert.equal(JSON.stringify(found.body).includes('example.test'), true); // avatar only
    const hidden = await request(srv, '/api/public/profiles/alice');
    const missing = await request(srv, '/api/public/profiles/nobody');
    assert.deepEqual({ status: hidden.status, body: hidden.body }, { status: missing.status, body: missing.body });
  } finally { await srv.close(); }
});

test('owner writes are isolated and validation rejects unsafe avatar/text/input shape', async () => {
  const pool = makePool(); const srv = await start(pool);
  const put = (body) => request(srv, '/api/me/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-test-user': 'alice' }, body: JSON.stringify(body) });
  try {
    for (const body of [
      { published: true, displayName: null, bio: null, avatarUrl: null },
      { published: true, displayName: 'A', bio: null, avatarUrl: 'http://example.test/a.png' },
      { published: true, displayName: 'A', bio: null, avatarUrl: 'https://127.0.0.1/a.png' },
      { published: true, displayName: 'A', bio: null, avatarUrl: 'https://example.test/a.png?token=x' },
      { published: true, displayName: 'A\u0000', bio: null, avatarUrl: null },
      { published: true, displayName: 'A', bio: null, avatarUrl: null, wallet: 'ut1leak' },
    ]) assert.equal((await put(body)).status, 400);
    const saved = await put({ published: true, displayName: 'Alice', bio: 'Hello\nworld', avatarUrl: 'https://cdn.example.test/a.png' });
    assert.equal(saved.status, 200); assert.equal(saved.body.published, true);
    assert.equal(pool.state.users.find((u) => u.username === 'bob').profile_display_name, 'Bob Builder');
  } finally { await srv.close(); }
});

test('reports are generic/idempotent and moderation hides then restores the exact profile', async () => {
  const pool = makePool(); const srv = await start(pool);
  try {
    const opts = { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': 'alice' }, body: JSON.stringify({ reason: 'spam', detail: 'Repeated links' }) };
    assert.equal((await request(srv, '/api/profiles/bob/report', opts)).status, 202);
    assert.equal((await request(srv, '/api/profiles/bob/report', opts)).status, 202);
    assert.equal((await request(srv, '/api/profiles/nobody/report', opts)).status, 202);
    assert.equal(pool.state.reports.length, 1);
    const viewDenied = await request(srv, '/api/admin/profiles/bob/moderation', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': 'viewer' }, body: JSON.stringify({ disabled: true, reason: 'reviewed' }) });
    assert.equal(viewDenied.status, 403);
    const disabled = await request(srv, '/api/admin/profiles/bob/moderation', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': 'admin' }, body: JSON.stringify({ disabled: true, reason: 'confirmed spam' }) });
    assert.equal(disabled.status, 200);
    assert.equal((await request(srv, '/api/public/profiles/bob')).status, 404);
    const enabled = await request(srv, '/api/admin/profiles/bob/moderation', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': 'admin' }, body: JSON.stringify({ disabled: false, reason: null }) });
    assert.equal(enabled.status, 200);
    assert.equal((await request(srv, '/api/public/profiles/bob')).status, 200);
  } finally { await srv.close(); }
});

test('schema, routing and rendering pin deletion, privacy, XSS and avatar protections', () => {
  const root = path.join(__dirname, '..');
  const schema = fs.readFileSync(path.join(root, 'src/db/schema.sql'), 'utf8');
  const profile = fs.readFileSync(path.join(root, 'public/js/profile.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  assert.match(schema, /profile_user_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(schema, /reporter_user_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(schema, /COMMENT ON TABLE profile_reports IS 'staging:private'/);
  assert.match(profile, /textContent = text/);
  assert.match(profile, /img\.referrerPolicy = 'no-referrer'/);
  assert.doesNotMatch(profile, /innerHTML\s*=/);
  assert.match(app, /publicProfileRoute/);
  assert.match(app, /Profile\.open\(username\)/);
});
