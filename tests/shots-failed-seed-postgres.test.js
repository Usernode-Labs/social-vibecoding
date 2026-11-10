'use strict';

// The staging fixture that puts a change whose before & after screenshots
// could not be taken on the Workshop board (src/db/migrate.js
// seedStagingShotsFailed), against the REAL schema in a throwaway PostgreSQL
// database: a promoted proposal on the demo app, authored by the shots' own
// member fixture, with a failed run on its reviewed head. Pinned here: it
// writes nothing outside staging; a second boot adds nothing; the run reads
// as a failure with a retake available; and the change's own author is the
// one `_canRetakeShots` offers it to (issue #6551). Skipped when no server is
// reachable, and required when TEST_DATABASE_URL is set, the same contract as
// the other *-postgres suites.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client, Pool } = require('pg');

const { seedStagingShotsFailed } = require('../src/db/migrate');
const shotsView = require('../src/services/shots-view');
globalThis.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
const AppView = require('../public/js/app-view.js');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SESSION_ID = 900161;

const savedEnvironment = process.env.USERNODE_ENV;
test.after(() => {
  if (savedEnvironment === undefined) delete process.env.USERNODE_ENV;
  else process.env.USERNODE_ENV = savedEnvironment;
});

test('the failed-shots fixture never writes outside staging', async () => {
  process.env.USERNODE_ENV = 'production';
  await seedStagingShotsFailed({ query() { assert.fail('must not seed production'); } });
});

test('a staging preview shows the shots member a change whose screenshots failed (PostgreSQL)', async (t) => {
  const root = new Client({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await root.connect(); }
  catch (err) {
    await root.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`Local test database unavailable: ${err.code}`);
  }
  const database = `shots_failed_${crypto.randomBytes(6).toString('hex')}`;
  let pool;
  try {
    await root.query(`CREATE DATABASE ${database}`);
    const url = new URL(DSN); url.pathname = `/${database}`;
    pool = new Pool({ connectionString: url.toString() });
    pool.on('error', () => {});
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
    const owner = (await pool.query(
      `INSERT INTO users (username, password) VALUES ('staging-demo-user', 'staging-demo-not-a-login') RETURNING id`
    )).rows[0];
    const member = (await pool.query(
      `INSERT INTO users (username, password) VALUES ('usernode-capture', 'x') RETURNING id, username`
    )).rows[0];
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, view_visibility, created_by)
       VALUES (900001, 'Staging demo app', 'staging-demo-app', 'running', 'public', $1)`,
      [owner.id]
    );
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status) VALUES (900001, $1, 'member')`,
      [member.id]
    );

    process.env.USERNODE_ENV = 'staging';
    await seedStagingShotsFailed(pool);
    await seedStagingShotsFailed(pool);
    const counts = (await pool.query(
      `SELECT (SELECT COUNT(*) FROM chat_sessions WHERE id = $1)::int AS sessions,
              (SELECT COUNT(*) FROM shot_runs WHERE session_id = $1)::int AS runs`,
      [SESSION_ID]
    )).rows[0];
    assert.deepEqual(counts, { sessions: 1, runs: 1 }, 'a second boot adds nothing');

    const row = (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [SESSION_ID])).rows[0];
    assert.equal(row.status, 'promoted');
    assert.equal(row.user_id, member.id, 'the shots member authored it, so the author retake is reachable');
    assert.match(row.pr_title, /^\[Mock\] Staging demo/);

    // The run reads as a failure that can be taken again, with no automatic
    // retry coming, through the same view every reviewer surface reads.
    const view = await shotsView.getForSession(pool, row, 'staging-demo-app', { viewer: member });
    assert.equal(view.state, 'failed');
    assert.equal(view.failureCode, 'shots_capture_incomplete');
    assert.match(view.failureReason, /could not reach the dialog/);
    assert.equal(view.repairAvailable, true);
    assert.equal(view.automaticRetryPending, false);
    assert.equal(view.claims.length, 1);

    // Only its author (the member the shots agent is signed in as) is offered
    // the retake; another member reading the same change is not.
    const item = { id: SESSION_ID, user_id: row.user_id, shots: view };
    const previous = globalThis.App;
    globalThis.App = { user: { id: member.id } };
    try {
      assert.equal(AppView._canRetakeShots(item), true);
      globalThis.App = { user: { id: owner.id } };
      assert.equal(AppView._canRetakeShots(item), false);
    } finally { globalThis.App = previous; }
  } finally {
    await pool?.end().catch(() => {});
    await root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => {});
    await root.end().catch(() => {});
  }
});
