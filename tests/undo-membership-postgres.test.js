'use strict';

// Undoing a merge is taking part, so it is for the community's members
// (src/routes/votes.js, POST /api/sessions/:id/undo).
//
// Undo is not a read: it clones the repository, pushes a revert branch,
// opens a pull request and inserts a promoted proposal owned by whoever
// pressed it (checkAndOpenRevert). It used to mount only the same-origin
// check, so on a public community, where the collab guard lets every
// signed-in person through, a passer-by who never joined could put a
// revert up for a vote. It now mounts the same gates as promote:
// drainGuard, requireMembership, sameOriginBrowserOnly. A non-member's 403
// `join_required` is what the client's fetch wrapper
// (frontend/src/lib/join-required.ts) turns into the Join prompt.
//
// Through the real router against the REAL schema in a throwaway PostgreSQL
// database. Skipped when no server is reachable, and required when
// TEST_DATABASE_URL is set, like tests/communities-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('undo mounts the same gates as promote, in the same order', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/routes/votes.js'), 'utf8');
  assert.match(src,
    /router\.post\('\/api\/sessions\/:id\/promote', drainGuard, requireMembership, sameOriginBrowserOnly,/);
  assert.match(src,
    /router\.post\('\/api\/sessions\/:id\/undo', drainGuard, requireMembership, sameOriginBrowserOnly,/,
    'undo opens a revert PR, so it is gated like promote');
  assert.doesNotMatch(src, /Read-only vote\/undo/, 'undo is not described as read-only');
});

test('undo is for members, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'undo_gate_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  const cleanup = [];
  t.after(async () => {
    for (const step of cleanup) await step();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const communities = require('../src/services/communities');

  let seq = 0;
  async function user({ isAdmin = false } = {}) {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_admin)
       VALUES ($1, 'x', TRUE, $2) RETURNING id, username, is_admin`,
      [`undo_${n}`, isAdmin]
    );
    return rows[0];
  }
  async function app({ createdBy, view = 'public', collab = 'public' }) {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, view_visibility, collab_visibility, status, repo_url)
       VALUES ($1, $2, $3, $4, $5, 'running', $6) RETURNING id`,
      [`App ${n}`, `undo-app-${n}`, createdBy, view, collab, `https://github.com/undo-owner/app-${n}`]
    );
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`,
      [rows[0].id, createdBy]);
    return (await pool.query('SELECT * FROM apps WHERE id = $1', [rows[0].id])).rows[0];
  }
  async function merged(appRow, ownerId) {
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, pr_title, merged_at, merge_commit_sha)
       VALUES ($1, $2, 'merged', 12, 'Shorter welcome', NOW(), $3) RETURNING id`,
      [appRow.id, ownerId, 'a'.repeat(40)]
    );
    return rows[0].id;
  }
  const reverts = async (sessionId) => Number((await pool.query(
    'SELECT COUNT(*)::int AS n FROM chat_sessions WHERE revert_of_session_id = $1', [sessionId])).rows[0].n);

  // The router as the server mounts it, with the signed-in person swapped
  // per call.
  const express = require('express');
  const { getPool } = require('../src/db/pool');
  const config = { databaseUrl: String(url), selfAppSlug: 'no-such-self-app', selfAppPublicVoting: true };
  const server = express();
  server.use(express.json());
  let as = null;
  server.use((req, _res, next) => {
    req.user = { id: as.id, username: as.username, isAdmin: !!as.is_admin, hasPlatformAccess: true };
    next();
  });
  server.use(require('../src/routes/votes').voteRoutes(config));
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  cleanup.push(async () => {
    await new Promise((r) => listener.close(r));
    await getPool(config).end().catch(() => {});
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const undo = async (sessionId, headers = { 'sec-fetch-site': 'same-origin' }) => {
    const res = await fetch(`${base}/api/sessions/${sessionId}/undo`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const owner = await user();
  const open = await app({ createdBy: owner.id });
  const change = await merged(open, owner.id);

  await t.test('a non-member is refused with join_required, and no revert is started', async () => {
    as = await user();
    const got = await undo(change);
    assert.equal(got.status, 403);
    assert.equal(got.body.code, 'join_required', 'the answer the client turns into Join');
    assert.equal(got.body.app.slug, open.slug, 'naming the community to join');
    assert.equal(await reverts(change), 0, 'nothing was cloned, pushed or inserted');

    const crossSite = await undo(change, { 'sec-fetch-site': 'cross-site' });
    assert.equal(crossSite.body && crossSite.body.code, 'join_required',
      'membership is asked first, as on promote');
    assert.equal(await reverts(change), 0);
  });

  // A revert already up for a vote makes the route answer 409 before it
  // starts any work, which shows the gate let the caller through without
  // running a real clone.
  await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, revert_of_session_id)
     VALUES ($1, $2, 'promoted', 13, $3)`,
    [open.id, owner.id, change]
  );

  await t.test('a member gets past the gate to the route itself', async () => {
    as = await user();
    assert.equal((await undo(change)).body.code, 'join_required');
    await communities.join(pool, open, as.id);
    const got = await undo(change);
    assert.equal(got.status, 409, JSON.stringify(got.body));
    assert.match(got.body.error, /already exists/);
    assert.equal(got.body.code, undefined);
  });

  await t.test('an admin passes, as they pass every access check', async () => {
    as = await user({ isAdmin: true });
    const got = await undo(change);
    assert.equal(got.status, 409, JSON.stringify(got.body));
  });

  await t.test('a private project stays the collab guard\'s to refuse, without naming it', async () => {
    const secret = await app({ createdBy: owner.id, view: 'private', collab: 'private' });
    const hidden = await merged(secret, owner.id);
    as = await user();
    const got = await undo(hidden);
    assert.equal(got.status, 404);
    assert.notEqual(got.body && got.body.code, 'join_required');
    assert.equal(await reverts(hidden), 0);
  });
});
