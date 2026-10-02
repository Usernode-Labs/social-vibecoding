'use strict';

// #3654: the benchmark lane against the FULL PostgreSQL schema, with the
// stage itself stubbed (tests/bench-runner.test.js covers the stages): a
// launch plans every trial up front (repeats for triage, one build per
// model, a task a model cannot take marked not applicable); the lane runs a
// run's trials a few at a time, waits while the live bot uses every build
// slot, stops scheduling at the dollar cap and skips the rest; spend lands on
// the run; a trial a dead process left running goes back to the queue, and
// fails after a second interruption; a cancelled run claims nothing more.
//
// Skips when no database is reachable, unless TEST_DATABASE_URL insists.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const lane = require('../src/services/bench/lane');
const runner = require('../src/services/bench/runner');
const suites = require('../src/services/bench/suites');
const snapshots = require('../src/services/homeroom-bot-snapshots');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the benchmark lane against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bench_lane_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const realRunStage = runner.runStage;
  t.after(async () => {
    runner.runStage = realRunStage;
    lane._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema);

  const { rows: [app] } = await pool.query(
    "INSERT INTO apps (name, slug, status, repo_url) VALUES ('Todo', 'todo', 'running', 'https://github.com/o/todo') RETURNING id",
  );
  const { rows: [user] } = await pool.query(
    "INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bench', 'x', TRUE) RETURNING id, username",
  );
  const { suite } = await suites.createSuite(pool, { name: 'lane' });
  for (let i = 1; i <= 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { rows: [r] } = await pool.query(
      "INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict) VALUES ($1, $2, 'shadow', 'ready') RETURNING id", [app.id, i],
    );
    for (const stage of ['triage', 'build']) {
      // eslint-disable-next-line no-await-in-loop
      await snapshots.recordSnapshot(pool, { runId: r.id, stage, appId: app.id, issueNumber: i, baseSha: 'a'.repeat(40), texts: { seed: `s${i}`, prompt: `p${i}` } });
    }
    // eslint-disable-next-line no-await-in-loop
    await suites.addTaskFromRun(pool, { suiteId: suite.id, runId: r.id, stage: 'triage' });
    // eslint-disable-next-line no-await-in-loop
    await suites.addTaskFromRun(pool, { suiteId: suite.id, runId: r.id, stage: 'build' });
  }

  let saturated = false;
  const ran = [];
  runner.runStage = async ({ stage, model, trial }) => {
    ran.push(`${stage}:${model}:${trial.id}`);
    return { status: 'ok', cost_usd: 1.25, parsed: { verdict: 'ready' }, duration_ms: 5 };
  };
  const deps = {
    user,
    limits: { async checkBudget() { return { ok: true }; }, async recordSpend() {} },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    isLiveLaneSaturated: () => saturated,
    github: { isEnabled: () => true },
    worker: { async stopTurn() {} },
    afterTrial: async () => {},
  };
  const trials = async (runId) => (await pool.query(
    'SELECT id, status, model, attempt, task_id, error, cost_usd::float8 AS cost FROM bench_trials WHERE run_id = $1 ORDER BY id', [runId],
  )).rows;

  await t.test('a launch plans every trial: repeats for triage, one build per model, not-applicable named', async () => {
    const out = await lane.launchRun(pool, {
      suiteId: suite.id, models: ['z-ai/glm-5.3-flash', 'moonshotai/kimi-k2.7-code'], stages: ['triage', 'build'], repeats: 3,
    });
    assert.equal(out.ok, true);
    // 3 triage tasks x 2 models x 3 attempts + 3 build tasks x 2 models x 1.
    assert.equal(out.trials, 18 + 6);
    assert.equal(out.notApplicable, 9, 'Kimi is entered for builds only: its 9 triage trials are not applicable');
    assert.equal(out.run.cap_usd, '50.0000', 'the default cap is $50');
    assert.equal(out.run.baseline_model, 'z-ai/glm-5.3-flash');
    const rows = await trials(out.run.id);
    const na = rows.filter((r) => r.status === 'not_applicable');
    assert.ok(na.every((r) => r.model === 'moonshotai/kimi-k2.7-code' && /builds? and spec only|build and spec only/.test(r.error)));
    await pool.query("UPDATE bench_runs SET status = 'cancelled' WHERE id = $1", [out.run.id]);
  });

  await t.test('the lane waits for the live bot, runs a run\'s trials, debits the run, and finishes it', async () => {
    lane._resetForTests();
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 1, concurrency: 2 });
    saturated = true;
    const waiting = await lane.tick(pool, {}, deps);
    assert.equal(waiting.started, 0);
    assert.equal(waiting.paused, 'live_bot_busy');
    saturated = false;
    const first = await lane.tick(pool, {}, deps);
    assert.equal(first.started, 2, 'two at once: the run\'s concurrency');
    await lane._awaitTrialsForTests();
    await lane.tick(pool, {}, deps);
    await lane._awaitTrialsForTests();
    const done = await lane.tick(pool, {}, deps);
    assert.deepEqual(done.finished, [run.id]);
    const rows = await trials(run.id);
    assert.deepEqual(rows.map((r) => r.status), ['ok', 'ok', 'ok']);
    const { rows: [r] } = await pool.query('SELECT status, spent_usd::float8 AS spent FROM bench_runs WHERE id = $1', [run.id]);
    assert.equal(r.status, 'done');
    assert.equal(r.spent, 3.75);
  });

  await t.test('the cap: no trial starts that would cross it, and the rest are skipped', async () => {
    lane._resetForTests();
    const { run } = await lane.launchRun(pool, {
      suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 3, capUsd: 3,
    });
    // Each trial is estimated at $1 and costs $1.25.
    await pool.query('UPDATE bench_trials SET est_cost_usd = 1 WHERE run_id = $1', [run.id]);
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await lane.tick(pool, {}, deps);
      // eslint-disable-next-line no-await-in-loop
      await lane._awaitTrialsForTests();
    }
    const rows = await trials(run.id);
    const ok = rows.filter((x) => x.status === 'ok').length;
    const skipped = rows.filter((x) => x.status === 'skipped_cap').length;
    assert.equal(ok, 2, 'two trials fit: $1.25 + $1.25 spent, and a third estimated at $1 would make $3.50');
    assert.equal(skipped, 7);
    const { rows: [r] } = await pool.query('SELECT status, spent_usd::float8 AS spent FROM bench_runs WHERE id = $1', [run.id]);
    assert.equal(r.status, 'capped');
    assert.ok(r.spent <= 3, `spent ${r.spent} is inside the $3 cap`);
  });

  await t.test('a trial a dead process left running is retried once, then failed', async () => {
    lane._resetForTests();
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['build'] });
    const [a, b] = await trials(run.id);
    await pool.query(
      "UPDATE bench_trials SET status = 'running', claims = 1, started_at = NOW() - INTERVAL '1 day' WHERE id = $1", [a.id],
    );
    await pool.query(
      "UPDATE bench_trials SET status = 'running', claims = 2, started_at = NOW() - INTERVAL '1 day' WHERE id = $1", [b.id],
    );
    assert.equal(await lane.releaseStale(pool, { turnSeconds: 1200 }), 2);
    const rows = await trials(run.id);
    assert.equal(rows.find((x) => x.id === a.id).status, 'pending');
    const failed = rows.find((x) => x.id === b.id);
    assert.equal(failed.status, 'infra_fail');
    assert.match(failed.error, /restarted during it twice/);
    await pool.query("UPDATE bench_runs SET status = 'cancelled' WHERE id = $1", [run.id]);
  });

  await t.test('a cancelled run claims nothing more and its waiting trials are cancelled', async () => {
    lane._resetForTests();
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 2 });
    assert.equal((await lane.cancelRun(pool, run.id, deps)).ok, true);
    assert.equal((await lane.cancelRun(pool, run.id, deps)).status, 409);
    const before = ran.length;
    await lane.tick(pool, {}, deps);
    assert.equal(ran.length, before);
    assert.ok((await trials(run.id)).every((x) => x.status === 'cancelled'));
  });
});
