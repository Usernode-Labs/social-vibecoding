'use strict';

// #6287: a change's page asks "Still yes?" from the row GET
// /api/apps/:slug/proposals/:id returns. That read is mergedRowSelect(), and
// it must carry the viewer's vote on an earlier version exactly as the
// /promoted list does — the Votes card's "Your yes was on an earlier version"
// line comes from a different read, so without this the card knew about the
// earlier yes while its button offered a fresh "Vote".
//
// Against the REAL schema in a throwaway PostgreSQL database, through the
// real route, so the subquery's epoch comparison is the one that ships.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/proposal-prior-vote-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the single-change read carries the viewer\'s vote on an earlier version', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 10000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `proposal_prior_vote_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4, connectionTimeoutMillis: 10000 });
  const cleanup = [];
  t.after(async () => {
    for (const step of cleanup) await step();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const user = async (username) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`,
    [username],
  )).rows[0];
  const ada = await user('ada_prior');
  const sam = await user('sam_prior');

  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, repo_url)
     VALUES ('prior-vote', 'prior-vote', 'running', $1, 'private', 'private', 'https://github.com/example/prior-vote') RETURNING id`,
    [ada.id],
  );
  const app = (await pool.query('SELECT id, slug, community_id FROM apps WHERE id = $1', [inserted.id])).rows[0];
  for (const m of [ada, sam]) {
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, m.id]);
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status, accepted_at) VALUES ($1, $2, 'member', NOW()) ON CONFLICT DO NOTHING`, [app.id, m.id]);
    await pool.query('INSERT INTO app_favorites (app_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.id, m.id]);
  }

  // Sam said yes to the version he was shown; the bot then pushed a revision,
  // which moved the approval epoch past his vote.
  const { rows: [session] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, promoted_at, branch_name, pr_number, check_state, approval_epoch)
     VALUES ($1, $2, 'promoted', NOW(), $3, 6277, 'passing', 1) RETURNING id`,
    [app.id, ada.id, `test/${crypto.randomBytes(4).toString('hex')}`],
  );
  await pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch) VALUES ($1, $2, 'yes', 0)`,
    [session.id, sam.id],
  );

  const express = require('express');
  const { getPool } = require('../src/db/pool');
  const config = { databaseUrl: String(url) };

  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    req.user = { id: sam.id, username: sam.username, isAdmin: false, hasPlatformAccess: true };
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

  const res = await fetch(`${base}/api/apps/${app.slug}/proposals/${session.id}`, {
    headers: { 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.proposal.my_vote, null, 'his yes is not on the current version');
  assert.equal(body.proposal.my_prior_vote, 'yes', 'but the card can offer "Still yes?" for it');
});
