'use strict';

// #3654: the benchmark lane against the FULL PostgreSQL schema, with the
// stage itself stubbed (tests/bench-runner.test.js covers the stages): a
// launch plans every trial up front (repeats for triage, one build per
// model, a task a model cannot take marked not applicable); the lane runs a
// run's trials a few at a time, waits while the live bot uses every build
// slot, stops scheduling at the dollar cap and skips the rest; spend lands on
// the run; a trial a dead process left running goes back to the queue, and
// fails after a second interruption; a cancelled run claims nothing more.
// After a restart: a trial's session is on its row before its turn runs; an
// interrupted trial is released at once with what it spent charged once; a
// trial nothing holds is released on the next pass, but never one a durable
// build owns, whose slot the lane holds until its build ends; a trial goes on
// with the looks it kept; and a trial is recorded, and charged, once.
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
const durableSteps = require('../src/services/durable-steps');

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

  await t.test('an estimate previews the same plan, per stage, and writes nothing', async () => {
    const body = {
      suiteId: suite.id, models: ['z-ai/glm-5.3-flash', 'moonshotai/kimi-k2.7-code'], stages: ['triage', 'build'], repeats: 3,
    };
    const runsBefore = (await pool.query('SELECT COUNT(*)::int AS n FROM bench_runs')).rows[0].n;
    const trialsBefore = (await pool.query('SELECT COUNT(*)::int AS n FROM bench_trials')).rows[0].n;
    const est = await lane.estimateRun(pool, body);
    assert.equal(est.ok, true);
    assert.equal(est.trials, 15, '24 planned, 9 of them not applicable');
    assert.equal(est.notApplicable, 9);
    assert.deepEqual(Object.keys(est.byStage).sort(), ['build', 'triage']);
    assert.equal(est.byStage.triage.trials, 9, 'GLM only: 3 tasks x 3 attempts');
    assert.equal(est.byStage.triage.notApplicable, 9);
    assert.equal(est.byStage.build.trials, 6, 'one build per task and model');
    assert.ok(est.estimateUsd > 0);
    assert.ok(Math.abs(est.byStage.triage.estimateUsd + est.byStage.build.estimateUsd - est.estimateUsd) < 0.02,
      'the stages add up to the total');
    assert.ok(est.estimatedMs > 0);
    assert.ok(est.likelyUsd > 0 && est.likelyUsd <= est.estimateUsd, 'likely is never more than the most it could cost');
    assert.ok(est.suggestedCapUsd >= Math.ceil(est.likelyUsd), 'the suggested cap covers the likely cost');
    assert.ok(est.lowUsd <= est.highUsd && est.highUsd >= est.estimateUsd - 0.02, 'a range, up to at least the most it could cost');
    assert.ok(['triage', 'build'].every((st) => typeof est.byStage[st].basis === 'string'), 'each stage says what its part rests on');
    assert.equal(est.capUsd, 50);
    assert.equal(est.suiteFrozen, false);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM bench_runs')).rows[0].n, runsBefore, 'no run');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM bench_trials')).rows[0].n, trialsBefore, 'no trial');

    const launched = await lane.launchRun(pool, body);
    assert.equal(launched.estimateUsd, est.estimateUsd, 'the launch records the figure the preview showed');
    await pool.query("UPDATE bench_runs SET status = 'cancelled' WHERE id = $1", [launched.run.id]);
    await pool.query("UPDATE bench_trials SET status = 'cancelled' WHERE run_id = $1 AND status = 'pending'", [launched.run.id]);

    const refused = await lane.estimateRun(pool, { ...body, models: [] });
    assert.equal(refused.ok, false, 'the same validation as a launch');
    assert.equal(refused.status, 400);
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

  await t.test('a provider refusing the bench key for its spending limit: an infra_fail, and nothing new starts for a while', async () => {
    lane._resetForTests();
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 2, concurrency: 1 });
    const refused = 'the build turn failed (the agent exited with code 1); last activity: Failed to authenticate. API Error: 403 Key limit exceeded (weekly limit).';
    runner.runStage = async () => ({ status: 'model_fail', error: refused, cost_usd: 0.04, duration_ms: 5 });
    try {
      assert.equal((await lane.tick(pool, {}, deps)).started, 1);
      await lane._awaitTrialsForTests();
      const [first] = (await trials(run.id)).filter((x) => x.status !== 'pending');
      assert.equal(first.status, 'infra_fail', 'the platform\'s fault, out of the arm\'s build rate');
      assert.match(first.error, /Key limit exceeded/);
      const pause = await lane.providerLimitPause(pool);
      assert.ok(pause && Date.parse(pause.until) > Date.now(), JSON.stringify(pause));
      const held = await lane.tick(pool, {}, deps);
      assert.equal(held.started, 0);
      assert.equal(held.paused, 'provider_limit');
      assert.equal(held.until, pause.until);
      const watched = await require('../src/services/bench/studio').watchRun(pool, run.id);
      assert.deepEqual(watched.run.waiting, { reason: 'provider_limit', until: pause.until });
      // Past the pause, the next trial finds out whether the key works again,
      // and one that ends any other way lifts it.
      await pool.query("UPDATE bench_trials SET finished_at = NOW() - INTERVAL '31 minutes' WHERE id = $1", [first.id]);
      assert.equal(await lane.providerLimitPause(pool), null);
      runner.runStage = async () => ({ status: 'ok', cost_usd: 1.25, parsed: { verdict: 'ready' }, duration_ms: 5 });
      assert.equal((await lane.tick(pool, {}, deps)).started, 1);
      await lane._awaitTrialsForTests();
      assert.equal(await lane.providerLimitPause(pool), null);
      assert.equal((await require('../src/services/bench/studio').watchRun(pool, run.id)).run.waiting, null);
    } finally {
      runner.runStage = async ({ stage, model, trial }) => {
        ran.push(`${stage}:${model}:${trial.id}`);
        return { status: 'ok', cost_usd: 1.25, parsed: { verdict: 'ready' }, duration_ms: 5 };
      };
      await pool.query("UPDATE bench_runs SET status = 'cancelled' WHERE id = $1", [run.id]);
      await pool.query("UPDATE bench_trials SET status = 'cancelled' WHERE run_id = $1 AND status = 'pending'", [run.id]);
    }
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

  // The launcher's range, after trials have run: each stage says what it
  // rests on (catalog.costRange), and one with nothing behind it is a guess.
  await t.test('the estimate is a range that says what each stage rests on', async () => {
    const est = await lane.estimateRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage', 'build'], repeats: 1 });
    assert.equal(est.ok, true);
    assert.deepEqual({ basis: est.byStage.triage.basis, low: est.byStage.triage.lowUsd, high: est.byStage.triage.highUsd },
      { basis: 'own', low: 3.75, high: 3.75 }, 'three triage tasks at the $1.25 its trials cost');
    assert.equal(est.byStage.build.basis, 'fixed', 'no build has run and the model has no price here: a fixed guess, and said so');
    assert.ok(Math.abs(est.lowUsd - (est.byStage.triage.lowUsd + est.byStage.build.lowUsd)) < 0.02);
    assert.ok(est.lowUsd <= est.highUsd);
    assert.ok(est.suggestedCapUsd >= Math.ceil(est.lowUsd), 'the suggested cap covers the low end at least');
    const another = await lane.estimateRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash', 'x/fresh'], stages: ['triage'], repeats: 1 });
    assert.equal(another.byStage.triage.basis, 'stage', 'a model with no triage of its own is priced from the other model\'s');
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

  // ── After a restart ───────────────────────────────────────────────────

  const BASE = 'a'.repeat(40);
  const newSession = async ({ status = 'active', activeTurn = null, specMd = null } = {}) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues, session_title,
                                agent_backend, agent_provider, agent_model, active_turn, spec_md)
     VALUES ($1, $2, NULL, $3, FALSE, '{}', 'bench', 'codex_openrouter', 'openrouter', 'z-ai/glm-5.3-flash', $4::jsonb, COALESCE($5, ''))
     RETURNING id`,
    [app.id, user.id, status, activeTurn ? JSON.stringify(activeTurn) : null, specMd],
  )).rows[0].id;
  const spend = (sessionId, usd) => pool.query(
    `INSERT INTO agent_turns (id, session_id, user_id, backend, status, estimated_cost_usd, input_tokens, output_tokens, routed_model)
     VALUES ($1, $2, $3, 'codex_openrouter', 'completed', $4, 1000, 100, 'z-ai/glm-5.3-flash')`,
    [crypto.randomUUID(), sessionId, user.id, usd],
  );
  const claimAs = (trialId, sessionId, { claims = 1, ago = '10 minutes', baseSha = null } = {}) => pool.query(
    `UPDATE bench_trials
        SET status = 'running', claims = $2, started_at = NOW() - $3::interval, session_id = $4, base_sha = $5,
            build_branch = 'bench/r' || run_id || '-t' || id
      WHERE id = $1`,
    [trialId, claims, ago, sessionId, baseSha],
  );
  const trialRow = async (id) => (await pool.query(
    `SELECT id, status, error, claims, session_id, base_sha, cost_usd::float8 AS cost, parsed, recovered_at, finished_at,
            interrupted_cost_usd::float8 AS interrupted, build_commits, diff
       FROM bench_trials WHERE id = $1`, [id],
  )).rows[0];
  const spent = async (runId) => (await pool.query('SELECT spent_usd::float8 AS s FROM bench_runs WHERE id = $1', [runId])).rows[0].s;
  const debits = [];
  const moneyDeps = {
    limits: { async recordSpend(_p, userId, cents) { debits.push(cents); } },
    managedOpenRouter: { async usesIncludedKey() { return true; } },
  };
  const turnOf = (mode, extra = {}) => ({
    turnId: `turn-${crypto.randomUUID()}`, journal: '/journals/t.log', mode, phase: 'executing',
    backend: 'codex_openrouter', startedAt: new Date().toISOString(), ...extra,
  });
  const fakeGithub = () => {
    const calls = { compared: [], deleted: [] };
    return {
      calls,
      isEnabled: () => true,
      async compareFiles(o, r, range) { calls.compared.push(range); return { files: [{ filename: 'app.js', status: 'modified' }], diff: 'diff --git a/app.js b/app.js\n+x', complete: true, truncated: false }; },
      async deleteBenchBranch(o, r, branch) { calls.deleted.push(branch); return true; },
    };
  };

  await t.test('a trial\'s session is on its row before its turn runs; an interrupted attempt is charged once and the retry only its own', async () => {
    lane._resetForTests();
    debits.length = 0;
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 1 });
    const [a] = await trials(run.id);
    const s1 = await newSession();
    await spend(s1, 0.3);
    await claimAs(a.id, s1);

    // Restart recovery abandoned s1's turn: the trial is back at once.
    assert.equal(await lane.releaseTrialOfSession(pool, s1, { deps: moneyDeps }), 'pending');
    assert.equal(await lane.releaseTrialOfSession(pool, s1, { deps: moneyDeps }), null,
      'a second release of the same interruption changes and charges nothing');
    let row = await trialRow(a.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.session_id, null);
    assert.equal(row.interrupted, 0.3, 'what the interrupted attempt spent is kept on the trial');
    assert.equal(await spent(run.id), 0.3, 'and charged to the run, once');
    assert.deepEqual(debits, [30], 'and to the bench allowance, once');

    // The retry: its session is on the row while its turn runs.
    let during = null;
    let s2 = null;
    runner.runStage = async (ctx) => {
      s2 = await newSession();
      await ctx.onSession(s2, { baseSha: BASE, branch: runner.branchFor(ctx.trial) });
      during = await trialRow(ctx.trial.id);
      await spend(s2, 0.5);
      return { status: 'ok', session_id: s2, parsed: { verdict: 'ready' }, duration_ms: 5 };
    };
    await lane.tick(pool, {}, deps);
    await lane._awaitTrialsForTests();
    assert.equal(during.status, 'running');
    assert.equal(during.session_id, s2, 'the session is recorded before the turn, not at the trial\'s end');
    assert.equal(during.base_sha, BASE);
    row = await trialRow(a.id);
    assert.equal(row.status, 'ok');
    assert.equal(row.cost, 0.5, 'the trial\'s cost is the finishing attempt\'s own');
    assert.equal(row.interrupted, 0.3);
    assert.equal(await spent(run.id), 0.8, 'the run paid for both attempts, each once');
    await pool.query("UPDATE bench_runs SET status = 'cancelled' WHERE id = $1", [run.id]);
  });

  await t.test('a trial records the looks its turns took beside what its build could see; one that never looked records none', async () => {
    lane._resetForTests();
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 2 });
    const [looked, never] = await trials(run.id);
    runner.runStage = async (ctx) => {
      if (ctx.trial.id === looked.id) {
        for (const line of ['Using browser_navigate', 'Using browser_take_screenshot', 'Using browser_take_screenshot', 'Using mcp__playwright__browser_snapshot']) ctx.onActivity(line);
        return { status: 'ok', parsed: { verdict: 'ready', sight: { told: true, passed: true } }, duration_ms: 5 };
      }
      ctx.onActivity('Editing public/app.js');
      return { status: 'ok', parsed: { verdict: 'ready' }, duration_ms: 5 };
    };
    const parsedOf = async (id) => (await pool.query('SELECT parsed FROM bench_trials WHERE id = $1', [id])).rows[0].parsed;
    try {
      // One trial at a time, as the run's concurrency has it.
      for (let i = 0; i < 6 && (!(await parsedOf(looked.id)) || !(await parsedOf(never.id))); i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await lane.tick(pool, {}, deps);
        // eslint-disable-next-line no-await-in-loop
        await lane._awaitTrialsForTests();
      }
      assert.deepEqual((await parsedOf(looked.id)).sight, { told: true, passed: true, screenshots: 2, snapshots: 1, navigations: 1 });
      assert.equal((await parsedOf(never.id)).sight, undefined, 'no build and no look: nothing to say');
    } finally {
      await pool.query("UPDATE bench_runs SET status = 'cancelled' WHERE id = $1", [run.id]);
      await pool.query("UPDATE bench_trials SET status = 'cancelled' WHERE run_id = $1 AND status IN ('pending', 'running')", [run.id]);
    }
  });

  await t.test('a trial keeps its looks as a step while its turns run; the attempt after a restart starts from them, each counted once', async () => {
    lane._resetForTests();
    const token = () => crypto.randomBytes(8).toString('hex');
    const { rows: [snap] } = await pool.query('SELECT id FROM homeroom_bot_run_snapshots ORDER BY id LIMIT 1');
    const { rows: [task] } = await pool.query(
      `INSERT INTO bench_tasks (suite_id, stage, app_id, snapshot_id, reference_source, label_token)
       VALUES ($1, 'first_version', $2, $3, 'authored', $4) RETURNING id`,
      [suite.id, app.id, snap.id, token()],
    );
    const { rows: [run] } = await pool.query(
      `INSERT INTO bench_runs (suite_id, models, baseline_model, stages, repeats, cap_usd, concurrency, status, kind)
       VALUES ($1, ARRAY['z-ai/glm-5.3-flash'], 'z-ai/glm-5.3-flash', ARRAY['first_version'], 1, 50, 1, 'running', 'studio') RETURNING id`,
      [suite.id],
    );
    const { rows: [trial] } = await pool.query(
      `INSERT INTO bench_trials (run_id, task_id, model, attempt, status, item_token)
       VALUES ($1, $2, 'z-ai/glm-5.3-flash', 1, 'pending', $3) RETURNING id`,
      [run.id, task.id, token()],
    );
    await claimAs(trial.id, null);
    // What the attempt before the restart kept: when it started, the skills
    // it reached for, and its looks, a few seconds before the restart.
    const earlier = { screenshots: 4, snapshots: 1, navigations: 3 };
    const saves = [];
    const steps = durableSteps.durable({
      resumeFrom: { started_ms: Date.now() - 60_000, watch: { skills: { invoked: [], read: ['frontend-design'] }, looks: earlier } },
      lostAttempts: 1, checkpoint: async (state) => { saves.push(state); },
    });
    const watched = () => saves.at(-1)?.watch || null;
    const seen = {};
    runner.runStage = async (ctx) => {
      await ctx.onStep('build');
      seen.atStep = watched();
      ctx.onActivity('Using browser_take_screenshot');
      for (let i = 0; i < 100 && (watched()?.looks.screenshots || 0) < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => { setTimeout(r, 10); });
      }
      seen.afterLook = watched();
      // Within the interval: held back, not written on every line.
      ctx.onActivity('Using browser_navigate');
      await new Promise((r) => { setTimeout(r, 50); });
      seen.afterSecond = watched();
      return { status: 'ok', parsed: { built: true, sight: { told: true, passed: false } }, duration_ms: 5 };
    };
    try {
      assert.equal(await lane.executeTrial(pool, {}, { id: trial.id, run_id: run.id }, { ...deps, durable: steps }), 'ok');
      assert.deepEqual(seen.atStep.looks, earlier, 'a step keeps the counts its turn starts from: the kept ones, not added again');
      assert.deepEqual(seen.afterLook.looks, { ...earlier, screenshots: 5 }, 'a look is kept while the turn runs');
      assert.deepEqual(seen.afterSecond.looks, { ...earlier, screenshots: 5 }, 'the next, within the interval, waits');
      const { rows: [done] } = await pool.query(
        'SELECT status, parsed, checkpoint, recovered_at, duration_ms FROM bench_trials WHERE id = $1', [trial.id],
      );
      assert.equal(done.status, 'ok');
      assert.deepEqual(done.parsed.sight, { told: true, passed: false, screenshots: 5, snapshots: 1, navigations: 4 },
        'what it could see, and every look of both attempts, each once');
      assert.deepEqual(done.parsed.skills, { invoked: [], read: ['frontend-design'] }, 'and the skills it reached for before the restart');
      assert.deepEqual(done.checkpoint, { handBacks: 1 }, 'how often a restart carried it on, which the studio shows');
      assert.ok(done.recovered_at);
      assert.ok(done.duration_ms >= 60_000, `its time from its first attempt, the restart included (${done.duration_ms})`);
      assert.equal(saves.at(-1).recorded, 'ok', 'recorded, and kept so');
    } finally {
      await pool.query("UPDATE bench_runs SET status = 'cancelled' WHERE id = $1", [run.id]);
      await pool.query("UPDATE bench_trials SET status = 'cancelled' WHERE run_id = $1 AND status IN ('pending', 'running')", [run.id]);
    }
  });

  await t.test('a second interruption fails the trial; a cancelled run\'s trial is cancelled; both still charged', async () => {
    lane._resetForTests();
    debits.length = 0;
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 1 });
    const [a, b] = await trials(run.id);
    const sa = await newSession();
    await spend(sa, 0.2);
    await claimAs(a.id, sa, { claims: 2 });
    assert.equal(await lane.releaseTrialOfSession(pool, sa, { deps: moneyDeps }), 'infra_fail');
    const row = await trialRow(a.id);
    assert.match(row.error, /restarted during it twice/);
    assert.ok(row.finished_at);
    assert.equal(row.interrupted, 0.2);
    const sb = await newSession();
    await claimAs(b.id, sb);
    await pool.query("UPDATE bench_runs SET status = 'cancelled' WHERE id = $1", [run.id]);
    assert.equal(await lane.releaseTrialOfSession(pool, sb, { deps: moneyDeps }), 'cancelled',
      'never pending in a run nothing will schedule again');
    assert.equal(await spent(run.id), 0.2);
  });

  await t.test('the lane releases a trial nothing holds at once; not one with a turn on record, one a durable build owns, or one just claimed', async () => {
    lane._resetForTests();
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 2 });
    const [noTurn, withTurn, owned, asked, neverOpened, fresh] = await trials(run.id);
    await claimAs(noTurn.id, await newSession({ status: 'paused' }));
    await claimAs(withTurn.id, await newSession({ activeTurn: turnOf('scout') }));
    // Claimed a day ago with no session on record, as an old orphan would
    // be: one a durable build under way owns (services/build-runs.js), and
    // one whose build is asked for and not yet taken up by the kernel.
    // An instance is the kernel's to write (wf_require_writer): written here
    // as its transition pipeline writes one.
    const asKernel = (sql) => pool.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'; ${sql}; COMMIT`);
    await claimAs(owned.id, null, { ago: '1 day' });
    await asKernel(`INSERT INTO wf_instances (machine, key, state, machine_version) VALUES ('bot-build', 'trial:${Number(owned.id)}@c1.x', 'building', 1)`);
    await claimAs(asked.id, null, { ago: '1 day' });
    await pool.query(
      "INSERT INTO wf_events (machine, key, type, source, request_key) VALUES ('bot-build', $1, 'Requested', '{}'::jsonb, $2)",
      [`trial:${asked.id}@c1.y`, `bench-lane-${asked.id}`],
    );
    await claimAs(neverOpened.id, null);
    await claimAs(fresh.id, null, { ago: '0 seconds' });

    assert.equal(await lane.releaseOrphaned(pool, moneyDeps), 2);
    assert.equal((await trialRow(noTurn.id)).status, 'pending', 'a session with no turn left');
    assert.equal((await trialRow(neverOpened.id)).status, 'pending', 'no session ever recorded');
    assert.equal((await trialRow(withTurn.id)).status, 'running', 'a turn record is restart recovery\'s');
    assert.equal((await trialRow(fresh.id)).status, 'running', 'inside the grace');
    assert.equal((await trialRow(owned.id)).status, 'running', 'a durable build carries its trial on itself');
    assert.equal((await trialRow(asked.id)).status, 'running', 'and one asked for owns it already');
    assert.equal(await lane.releaseStale(pool, { turnSeconds: 1200 }), 0, 'releaseStale leaves a durable build\'s trials alone too');
    // Once its build has ended, the trial is no longer its build's.
    await asKernel(`UPDATE wf_instances SET state = 'failed' WHERE machine = 'bot-build' AND key = 'trial:${Number(owned.id)}@c1.x'`);
    assert.equal(await lane.releaseStale(pool, { turnSeconds: 1200 }), 1);
    assert.equal((await trialRow(owned.id)).status, 'pending');

    // The slot of a trial whose durable build is under way, wherever it runs,
    // is held in this process until the build ends, so the caps count it.
    const buildRuns = require('../src/services/build-runs');
    const real = { underWay: buildRuns.underWay, whenEnded: buildRuns.whenEnded };
    let end = null;
    const waited = [];
    buildRuns.underWay = async (target) => (target === 'trial' ? [{ key: `trial:${asked.id}@c1.y`, target: 'trial', id: asked.id, nonce: 'c1.y', appId: app.id }] : []);
    buildRuns.whenEnded = (key) => { waited.push(key); return new Promise((resolve) => { end = () => resolve(null); }); };
    try {
      assert.equal(await lane.holdDurableTrials(pool), 1);
      assert.equal(await lane.holdDurableTrials(pool), 0, 'held once');
      const held = lane._inFlightForTests().get(asked.id);
      const { rows: [{ est }] } = await pool.query('SELECT est_cost_usd::float8 AS est FROM bench_trials WHERE id = $1', [asked.id]);
      assert.deepEqual([held.runId, held.est, held.durable, held.heavy], [run.id, est, true, false], 'in its run\'s slots, at its estimate');
      assert.deepEqual(waited, [`trial:${asked.id}@c1.y`], 'until its own build ends');
      end();
      await held.promise;
      assert.equal(lane._inFlightForTests().has(asked.id), false, 'let go as its build ends');
    } finally {
      Object.assign(buildRuns, real);
    }
    await pool.query("UPDATE bench_runs SET status = 'cancelled' WHERE id = $1", [run.id]);
  });

  await t.test('a trial is recorded once: an attempt a restart caught after it recorded the trial, and before that was saved, charges nothing twice', async () => {
    lane._resetForTests();
    debits.length = 0;
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 1 });
    const [a] = await trials(run.id);
    await claimAs(a.id, null);
    const sid = await newSession();
    await spend(sid, 0.42);
    runner.runStage = async (ctx) => {
      await ctx.onSession(sid, { baseSha: BASE, branch: runner.branchFor(ctx.trial) });
      return { status: 'ok', session_id: sid, base_sha: BASE, build_branch: runner.branchFor(ctx.trial), parsed: { verdict: 'ready' }, duration_ms: 5 };
    };
    const tdeps = { ...deps, ...moneyDeps, github: fakeGithub() };
    const trialRef = { id: a.id, run_id: run.id };
    // The first attempt records the trial, and its claim is gone before that
    // step can be saved.
    const saves = [];
    const first = durableSteps.durable({
      checkpoint: async (state) => {
        if ('recorded' in state) throw new Error('the claim is gone');
        saves.push(state);
      },
    });
    await assert.rejects(lane.executeTrial(pool, {}, trialRef, { ...tdeps, durable: first }), { code: 'steps_stopped' });
    let row = await trialRow(a.id);
    assert.equal(row.status, 'ok', 'recorded');
    assert.equal(row.cost, 0.42, 'its cost from its session\'s ledger');
    assert.equal(await spent(run.id), 0.42);
    assert.deepEqual(debits, [42]);

    // The next attempt carries it on from the last step saved and records it
    // again: the record changes nothing, and charges nothing.
    const again = durableSteps.durable({ resumeFrom: saves.at(-1), lostAttempts: 1, checkpoint: async (state) => { saves.push(state); } });
    assert.equal(await lane.executeTrial(pool, {}, trialRef, { ...tdeps, durable: again }), 'ok');
    row = await trialRow(a.id);
    assert.equal(row.status, 'ok');
    assert.equal(row.cost, 0.42);
    assert.equal(await spent(run.id), 0.42, 'the run charged once');
    assert.deepEqual(debits, [42], 'and the bench allowance debited once');
    assert.equal(saves.at(-1).recorded, 'ok', 'kept as recorded this time');

    // An attempt after that returns what was recorded, and runs nothing.
    runner.runStage = async () => { throw new Error('the stage does not run again'); };
    const third = durableSteps.durable({ resumeFrom: saves.at(-1), lostAttempts: 2, checkpoint: async () => {} });
    assert.equal(await lane.executeTrial(pool, {}, trialRef, { ...tdeps, durable: third }), 'ok');
    assert.equal(await spent(run.id), 0.42);
    assert.deepEqual(debits, [42]);
    await pool.query("UPDATE bench_runs SET status = 'cancelled' WHERE id = $1", [run.id]);
  });

  // ── Parallelism ───────────────────────────────────────────────────────

  const gated = () => {
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    const started = [];
    runner.runStage = async ({ stage, trial }) => {
      started.push({ stage, id: trial.id });
      await gate;
      return { status: 'ok', cost_usd: 0.01, parsed: {}, duration_ms: 1 };
    };
    return { started, open };
  };
  const finishAll = async (g, runIds) => {
    g.open();
    await lane._awaitTrialsForTests();
    for (const id of runIds) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query("UPDATE bench_runs SET status = 'cancelled' WHERE id = $1", [id]);
    }
  };

  await t.test('a run takes up to eight trials at once', async () => {
    lane._resetForTests();
    const g = gated();
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 3, concurrency: 8 });
    assert.equal(run.concurrency, 8);
    const first = await lane.tick(pool, {}, deps);
    assert.equal(first.started, 8);
    assert.equal(lane._inFlightForTests().size, 8);
    assert.equal((await lane.tick(pool, {}, deps)).started, 0, 'the ninth waits for a slot');
    await finishAll(g, [run.id]);
  });

  await t.test('at most three heavy trials of a run at once; the lane takes its light ones meanwhile', async () => {
    lane._resetForTests();
    const g = gated();
    const { run } = await lane.launchRun(pool, {
      suiteId: suite.id, models: ['z-ai/glm-5.3-flash', 'moonshotai/kimi-k2.7-code'], stages: ['triage', 'build'], repeats: 1, concurrency: 8,
    });
    const out = await lane.tick(pool, {}, deps);
    const flying = [...lane._inFlightForTests().values()];
    assert.equal(flying.filter((f) => f.heavy).length, 3, 'three builds, not six');
    assert.equal(flying.filter((f) => !f.heavy).length, 3, 'every triage trial, including the one ordered after the fourth build');
    assert.equal(out.started, 6);
    const { rows: waiting } = await pool.query(
      `SELECT t.stage FROM bench_trials tr JOIN bench_tasks t ON t.id = tr.task_id
        WHERE tr.run_id = $1 AND tr.status = 'pending'`, [run.id],
    );
    assert.deepEqual(waiting.map((r) => r.stage), ['build', 'build', 'build'], 'the other builds wait for a heavy slot');
    await finishAll(g, [run.id]);
  });

  await t.test('at most eleven trials in flight across every run', async () => {
    lane._resetForTests();
    const g = gated();
    assert.equal(lane.MAX_IN_FLIGHT, 11, 'a full studio run of nine and two beside it');
    const a = (await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 3, concurrency: 7 })).run;
    const b = (await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 3, concurrency: 7 })).run;
    const out = await lane.tick(pool, {}, deps);
    assert.equal(out.started, 11);
    assert.equal(out.paused, 'lane_full');
    const flying = [...lane._inFlightForTests().values()];
    assert.equal(flying.filter((f) => f.runId === a.id).length, 7);
    assert.equal(flying.filter((f) => f.runId === b.id).length, 4, 'the second run gets what is left of the eleven');
    await finishAll(g, [a.id, b.id]);
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
