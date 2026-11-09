'use strict';

// The leaderboard's profile picture against the REAL schema in a throwaway
// PostgreSQL database (#6125). `rankedUsers` adds `avatar_url` through a LEFT
// JOIN of user_avatars (display-only, dropped in slim), and the profile route
// reads the same picture for its `user` block. A moderation-disabled profile
// gets null, matching the public profile card.
//
// Skipped when no server is reachable, and required when TEST_DATABASE_URL
// is set: the same contract as tests/active-users-invitees-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || process.env.INLOOP_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a member\'s picture reaches the leaderboard and the person page', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'leaderboard_avatar_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    // The route's own pool (src/db/pool) is process-wide and has no close
    // export, so end its idle backends before dropping the database.
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]
    );
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { rows: users } = await pool.query(
    `INSERT INTO users (username, password) VALUES
       ('alice', 'x'), ('bob', 'x'), ('dana', 'x')
     RETURNING id, username`
  );
  const id = (u) => users.find((r) => r.username === u).id;
  // alice and dana have uploaded pictures; dana's profile is moderation-disabled.
  await pool.query(
    `INSERT INTO user_avatars (id, user_id, content_type, size_bytes, data, sha256)
     VALUES ('av_alice', $1, 'image/png', 1, '\\x00', repeat('a', 64)),
            ('av_dana', $2, 'image/png', 1, '\\x00', repeat('b', 64))`,
    [id('alice'), id('dana')]
  );
  await pool.query('UPDATE users SET profile_disabled_at = NOW() WHERE id = $1', [id('dana')]);

  // ── the service query ────────────────────────────────────────────
  const { rankedUsers } = require('../src/services/leaderboard-users');
  const byName = (rows) => Object.fromEntries(rows.map((r) => [r.username, r]));
  const full = byName(await rankedUsers(pool, {}));
  assert.equal(full.alice.avatar_url, '/avatars/av_alice');
  assert.equal(full.bob.avatar_url, null, 'no picture → null');
  assert.equal(full.dana.avatar_url, null, 'a disabled profile shows no picture');

  const slim = await rankedUsers(pool, { slim: true });
  for (const row of slim) {
    assert.ok(!('avatar_url' in row), 'slim pays for no avatar');
  }

  // ── the person page's route ──────────────────────────────────────
  // Drive the real route against this database. `ws` is stubbed the same way
  // the route's unit suites do, so a required service is not what is under
  // test here.
  const wsPath = require.resolve('../src/services/ws');
  require.cache[wsPath] = {
    exports: { pushNotificationToUser: () => 0, pushKudosUpdate: () => {} },
    loaded: true,
    id: wsPath,
    filename: wsPath,
    paths: [],
  };
  const express = require('express');
  const { kudosRoutes } = require('../src/routes/kudos');
  const app = express();
  app.use(express.json());
  app.use(kudosRoutes({ databaseUrl: String(url) }));
  const server = app.listen(0);
  t.after(() => new Promise((r) => server.close(r)));
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const aliceBody = await (await fetch(`${base}/api/leaderboard/users/alice/prs`)).json();
  assert.equal(aliceBody.user.avatar_url, '/avatars/av_alice');
  const bobBody = await (await fetch(`${base}/api/leaderboard/users/bob/prs`)).json();
  assert.equal(bobBody.user.avatar_url, null);
  const danaBody = await (await fetch(`${base}/api/leaderboard/users/dana/prs`)).json();
  assert.equal(danaBody.user.avatar_url, null);
});
