'use strict';

// Run six: the time a first version still has to go, from the first
// versions that went live lately (services/first-version-eta.js). What only
// a real database can show: the samples' query finds each finished first
// version's build among its runs, times its steps from the records the App
// tab's step list counts from, prefers the build's own bot configuration,
// and leaves out what is not a finished first version.
//
// tests/first-version-eta.test.js pins the arithmetic and the screen.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const eta = require('../src/services/first-version-eta');

const MIN = 60000;

test('the estimate, from the first versions that went live lately', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `first_version_eta_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    eta.forget(pool);
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { rows: [maker] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ('ada_eta', 'x', TRUE) RETURNING id`,
  );
  const config = async (key, role) => (await pool.query(
    `INSERT INTO bot_config_versions (key, label, recipe, role, scope) VALUES ($1, $1, '{}'::jsonb, $2, 'first_version') RETURNING id`,
    [key, role],
  )).rows[0].id;
  const current = await config('fast', 'current');
  const older = await config('slow', 'side');

  const base = Date.now() - 2 * 86400000;
  const at = (n, min) => new Date(base + n * 3600000 + min * MIN);
  let seq = 0;

  /**
   * A project whose first version went live: decided at 0, first look at
   * `screens`, review at +`build`, proposal at +`check`, merged at +`test`,
   * live at +`live` (minutes). `review: false`: no review ran.
   */
  async function finished({ screens = 4, build = 9, check = 5, test: testing = 3, live = 1, cfg = current, review = true, firstLook = true, status = 'merged', liveAt = true, extraRuns = 0 } = {}) {
    seq += 1;
    const n = seq;
    const { rows: [app] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by) VALUES ($1, $1, 'running', $2) RETURNING id`,
      [`eta-${n}`, maker.id],
    );
    let m = 0;
    const decided = at(n, m); m += screens;
    const look = at(n, m); m += build;
    const reviewAt = review ? at(n, m) : null; m += review ? check : 0;
    const proposalAt = at(n, m); m += testing;
    const mergedAt = at(n, m); m += live;
    const liveAtTime = at(n, m);
    await pool.query(
      `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, status, issue_number, answered_at)
       VALUES ($1, $2, 'A club to vote on things', 'filed', 1, $3)`,
      [app.id, maker.id, decided],
    );
    // A run that went nowhere first, as a restart leaves one.
    for (let i = 0; i < extraRuns; i += 1) {
      await pool.query(`INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict) VALUES ($1, 1, 'live', 'question')`, [app.id]);
    }
    const { rows: [build_] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, created_at) VALUES ($1, $2, $3) RETURNING id`,
      [app.id, maker.id, at(n, 1)],
    );
    const { rows: [proposal] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, created_at, promoted_at, checks_checked_at, merged_at, live_at)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7) RETURNING id`,
      [app.id, maker.id, status, proposalAt, new Date(mergedAt.getTime() - 30000), status === 'merged' ? mergedAt : null,
        status === 'merged' && liveAt ? liveAtTime : null],
    );
    // Merged and not live yet: the insert trigger reads a merged row as live
    // (schema.sql chat_sessions_inserted_merged_live), so it is taken back.
    if (status === 'merged' && !liveAt) await pool.query('UPDATE chat_sessions SET live_at = NULL WHERE id = $1', [proposal.id]);
    const { rows: [run] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_ok, build_session_id, proposal_session_id, bot_config_version_id, review)
       VALUES ($1, 1, 'live', 'ready', TRUE, $2, $3, $4, $5::jsonb) RETURNING id`,
      [app.id, build_.id, proposal.id, cfg, JSON.stringify(reviewAt ? { state: 'done', startedAt: reviewAt.toISOString(), rounds: [{}] } : {})],
    );
    // A later fix of its checks on the same proposal is not the build.
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id, bot_config_version_id)
       VALUES ($1, 1, 'live', 'revise', $2, $3)`,
      [app.id, proposal.id, cfg],
    );
    if (firstLook) {
      await pool.query(
        `INSERT INTO first_version_screens (id, bot_run_id, kind, position, content_type, data, bytes, created_at)
         VALUES ($1, $2, 'first_look', 0, 'image/png', '\\x89'::bytea, 1, $3)`,
        [crypto.randomBytes(16).toString('hex'), run.id, look],
      );
    }
    await pool.query(
      `INSERT INTO homeroom_bot_posts (app_id, issue_number, run_id, kind, created_at) VALUES ($1, 1, $2, 'spec', $3)`,
      [app.id, run.id, firstLook ? new Date(look.getTime() + 2 * MIN) : look],
    );
    return { app, run };
  }

  await t.test('too few first versions: no estimate', async () => {
    await finished();
    await finished();
    eta.forget(pool);
    const steps = [{ key: 'plan', state: 'done' }, { key: 'screens', state: 'done' }, { key: 'build', state: 'now', since: new Date().toISOString() }];
    assert.equal(await eta.estimateFor(pool, 1, steps), null);
  });

  let building = null;
  await t.test('each finished first version is timed from its build, and the estimate counts from the step under way', async () => {
    await finished({ build: 10 });
    await finished({ build: 12, review: false, firstLook: false });
    // Not finished, or not one to count: none of these is read.
    await finished({ status: 'promoted' });
    await finished({ liveAt: false });
    // A slower configuration's, older and side by side with the current one's.
    for (let i = 0; i < 3; i += 1) await finished({ build: 40, cfg: older, extraRuns: 1 });
    eta.forget(pool);
    const read = await eta.samplesFor(pool);
    assert.equal(read.currentConfigId, current);
    assert.equal(read.samples.length, 7, 'the merged and live ones');
    const mine = read.samples.filter((s) => s.configId === current);
    assert.equal(mine.length, 4);
    assert.deepEqual(mine.map((s) => s.steps.build / MIN).sort((a, b) => a - b), [9, 9, 10, 12]);
    const unreviewed = mine.find((s) => s.steps.check === 0);
    assert.ok(unreviewed, 'no review: the check took no time');
    assert.equal(unreviewed.steps.screens, 4 * MIN, 'no first look: the screens end with the plan posted');
    for (const s of mine) {
      assert.equal(s.steps.screens, 4 * MIN);
      assert.equal(s.steps.test, 3 * MIN);
      assert.equal(s.steps.live, 1 * MIN);
    }
    // The project being built now, on the current configuration: its run
    // names it. Four of its own is too few, so all seven count.
    const { rows: [app] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by) VALUES ('Club Votes', 'club-votes', 'running', $1) RETURNING id`,
      [maker.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, status, issue_number) VALUES ($1, $2, 'Votes', 'filed', 1)`,
      [app.id, maker.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, bot_config_version_id) VALUES ($1, 1, 'live', 'ready', $2)`,
      [app.id, current],
    );
    building = app;
    const since = new Date(Date.now() - 3 * MIN).toISOString();
    const steps = [{ key: 'plan', state: 'done' }, { key: 'screens', state: 'done' }, { key: 'build', state: 'now', since },
      { key: 'check', state: 'next' }, { key: 'test', state: 'next' }, { key: 'live', state: 'next' }];
    const e = await eta.estimateFor(pool, app.id, steps);
    assert.equal(e.step, 'build');
    assert.equal(e.sameConfig, false);
    assert.equal(e.samples, 7);
    // Builds 9, 9, 10, 12, 40, 40, 40: the median is 12. Then check (5, 5,
    // 5, 0, 5, 5, 5: 5), test 3 and live 1.
    assert.equal(Date.parse(e.stepEtaAt) - Date.parse(since), 12 * MIN);
    assert.equal(Date.parse(e.etaAt) - Date.parse(since), 21 * MIN);
  });

  await t.test('once its own configuration has enough, only those count', async () => {
    await finished({ build: 9 });
    eta.forget(pool);
    const since = new Date(Date.now() - 3 * MIN).toISOString();
    const steps = [{ key: 'build', state: 'now', since }, { key: 'check', state: 'next' }, { key: 'test', state: 'next' }, { key: 'live', state: 'next' }];
    const e = await eta.estimateFor(pool, building.id, steps);
    assert.equal(e.sameConfig, true);
    assert.equal(e.samples, 5);
    // Builds 9, 9, 9, 10, 12: 9.
    assert.equal(Date.parse(e.stepEtaAt) - Date.parse(since), 9 * MIN);
    // A project with no run yet is built with the current configuration.
    const { rows: [fresh] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by) VALUES ('Fresh', 'fresh', 'running', $1) RETURNING id`, [maker.id],
    );
    const screens = [{ key: 'plan', state: 'done' }, { key: 'screens', state: 'now', since }, { key: 'build', state: 'next' }];
    const early = await eta.estimateFor(pool, fresh.id, screens);
    assert.equal(early.sameConfig, true);
    assert.equal(early.step, 'screens');
  });
});
