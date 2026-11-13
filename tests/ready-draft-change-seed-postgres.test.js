'use strict';

// #6599: the staging fixture the before & after shots need.
//
// A built draft of the shots' member fixture (usernode-capture), its checks
// passing on its current head and nothing working on it, on its request's
// page. A fresh staging copy cannot reach that state (a draft comes from a
// coding agent's build, and nothing there builds or runs checks), so
// src/db/migrate.js seeds it; the thread card's Put it up for a vote reads it
// through services/threads.js `ready` and `mine`.
//
// Its ids sit above every real session id because the declared start path
// names the request, and a production clone that already held the old id
// would silently skip the whole fixture.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/ready-draft-change-seed-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the staging ready-draft fixture reaches the state the shots need', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `ready_draft_seed_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  const previousEnv = process.env.USERNODE_ENV;
  t.after(async () => {
    if (previousEnv === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = previousEnv;
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);

  // What a preview already holds before the seed runs: the platform's app
  // and the member the shots sign in as.
  const { rows: [app] } = await pool.query(
    "INSERT INTO apps (name, slug, self_hosted) VALUES ('Homeroom', 'usernode-2d5619', TRUE) RETURNING id",
  );
  const { rows: [member] } = await pool.query(
    "INSERT INTO users (username, password) VALUES ('usernode-capture', 'staging-demo-not-a-login') RETURNING id",
  );

  process.env.USERNODE_ENV = 'staging';
  const migrate = require('../src/db/migrate');
  await migrate.seedStagingReadyDraftChange(pool);

  const { rows: [change] } = await pool.query(
    `SELECT id, app_id, user_id, status, check_state, checks_commit_sha, pr_number, linked_issues
       FROM chat_sessions WHERE branch_name = 'staging-fixture/ready-draft'`,
  );
  assert.ok(change, 'the fixture change exists');
  const { rows: [fixtureApp] } = await pool.query(
    "SELECT id, slug FROM apps WHERE id = 900099",
  );
  assert.equal(fixtureApp?.slug, 'staging-demo-ready-draft', 'its own demo project');
  assert.equal(Number(change.app_id), Number(fixtureApp.id));
  assert.equal(Number(change.user_id), Number(member.id), 'the shots\' member made it');
  assert.deepEqual([change.status, change.check_state], ['active', 'passing']);
  assert.match(change.checks_commit_sha, /^[0-9a-f]{40}$/, 'a verdict about a head');
  assert.deepEqual(change.linked_issues, [900001], 'answers the fixture request');

  // The request's page finds its thread by the request number, and the card
  // reads as a built draft of the viewer's: what draws Put it up for a vote.
  const threads = require('../src/services/threads');
  const thread = await threads.threadForNumber(pool, { appId: fixtureApp.id, number: 900001 });
  assert.ok(thread, 'the request\'s thread');
  const page = await threads.threadPage(pool, { thread, viewerId: member.id });
  const item = page.items.find((row) => row.type === 'change' && Number(row.id) === 999_999_990);
  assert.ok(item, 'the change is on the request\'s page');
  assert.equal(item.state, 'underway');
  assert.equal(item.ready, true, 'built, checks passing, nothing working on it');
  assert.equal(item.mine, true, 'the member\'s own, so its card offers the action');
  assert.equal(page.thread.number, 900001);

  // Anybody else's read: the draft is not theirs to propose, and (not
  // shared) not on their page at all.
  const { rows: [other] } = await pool.query(
    "INSERT INTO users (username, password) VALUES ('staging-demo-someone', 'staging-demo-not-a-login') RETURNING id",
  );
  const theirs = await threads.threadPage(pool, { thread, viewerId: other.id });
  assert.equal(theirs.items.some((row) => Number(row.id) === 999_999_990), false);

  // A second boot adds nothing.
  await migrate.seedStagingReadyDraftChange(pool);
  const { rows: [{ n }] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM chat_sessions WHERE branch_name = 'staging-fixture/ready-draft'`,
  );
  assert.equal(n, 1, 'idempotent');
  const { rows: [{ m }] } = await pool.query(
    'SELECT COUNT(*)::int AS m FROM requests WHERE app_id = $1 AND number = 900001', [fixtureApp.id],
  );
  assert.equal(m, 1);
});
