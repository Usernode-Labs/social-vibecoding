'use strict';

// #3654: the App bench against the FULL PostgreSQL schema, its lane the
// bench-lane machine (src/workflow/bench-lane/) and each trial a bot-build,
// both run by a kernel runtime here, the stage itself stubbed
// (tests/bench-runner.test.js covers the stages): a launch plans every trial
// up front; the lane grants a run's trials a few at a time, waits while the
// live bot uses every live slot, stops at the dollar cap and skips the rest;
// spend lands on the run, once, in the write that records the trial; a
// cancel lands whenever it is sent; and a trial's own build records it.
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
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const benchLaneMod = require('../src/workflow/bench-lane/machine.ts');
const { benchLaneServices } = require('../src/workflow/bench-lane/services.ts');
const { botBuild } = require('../src/workflow/bot-build/machine.ts');
const { botBuildServices } = require('../src/workflow/bot-build/services.ts');

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
  // What a trial's build reaches beyond the stage: stubbed on the modules
  // themselves, as the build runs them (no deps reach a durable build).
  const stubbed = [
    [runner, 'ensureBenchUser'], [require('../src/services/openrouter-managed-keys'), 'usesIncludedKey'],
    [require('../src/services/limits'), 'recordSpend'], [require('../src/services/session-lifecycle'), 'closeOwnSession'],
    [require('../src/services/bench/graders'), 'gradeTrial'], [lane, 'allowanceGate'],
  ].map(([mod, key]) => [mod, key, mod[key]]);
  const runtimes = [];
  t.after(async () => {
    runner.runStage = realRunStage;
    for (const [mod, key, real] of stubbed) mod[key] = real;
    for (const r of runtimes) await r.stop();
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

  const ran = [];
  runner.runStage = async ({ stage, model, trial }) => {
    ran.push(`${stage}:${model}:${trial.id}`);
    return { status: 'ok', cost_usd: 1.25, parsed: { verdict: 'ready' }, duration_ms: 5 };
  };
  const deps = {
    user,
    limits: { async checkBudget() { return { ok: true }; }, async recordSpend() {} },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    github: { isEnabled: () => true },
    worker: { async stopTurn() {} },
    afterTrial: async () => {},
  };
  const trials = async (runId) => (await pool.query(
    'SELECT id, status, model, attempt, task_id, error, cost_usd::float8 AS cost FROM bench_trials WHERE run_id = $1 ORDER BY id', [runId],
  )).rows;

  // ── The lane and the builds, as the workflow runs them ────────────────
  const debits = [];
  let allowed = true;
  runner.ensureBenchUser = async () => user;
  require('../src/services/openrouter-managed-keys').usesIncludedKey = async () => true;
  require('../src/services/limits').recordSpend = async (_p, _u, cents) => { debits.push(cents); };
  require('../src/services/session-lifecycle').closeOwnSession = async () => {};
  require('../src/services/bench/graders').gradeTrial = async () => {};
  lane.allowanceGate = async () => (allowed ? { ok: true, reason: null } : { ok: false, reason: 'weekly_limit' });
  const make = (machines) => {
    const r = createRuntime({
      pool, machines, pollMs: 50,
      services: { ...benchLaneServices({ config: {}, pool }), ...botBuildServices({ config: {}, pool }) },
    });
    runtimes.push(r);
    return r;
  };
  const rt = make([benchLaneMod.benchLane(), botBuild()]);
  // A process that runs the lane but not the builds: what the lane sends
  // waits until the test lets `rt` take it.
  const laneOnly = make([benchLaneMod.benchLane()]);
  const settle = async (r = rt) => { for (let i = 0; i < 40; i += 1) { await r.drain(); if (!(await r.runServices())) { await r.drain(); return; } } };
  let rk = 0;
  const lookNow = async (r = rt, runId = null) => {
    await r.append(benchLaneMod.MACHINE, benchLaneMod.KEY, { type: 'Look', payload: { runId } }, { requestKey: `look-${++rk}`, source: { kind: 'system', name: 'test' } });
  };
  // An admin's cancel, as appendAndWait answers it (these runtimes are
  // stepped by hand: append, process, read the event's outcome).
  const cancel = async (r, type, payload) => {
    const id = await r.append(benchLaneMod.MACHINE, benchLaneMod.KEY, { type, payload },
      { requestKey: `cancel-${++rk}`, source: { kind: 'admin', name: 'test' } });
    await r.drain();
    const { rows: [e] } = await pool.query('SELECT result, reason, reply FROM wf_events WHERE id = $1', [id]);
    return { status: e.result || 'pending', reason: e.reason, reply: e.reply };
  };
  // The live bot's slots: `n` grants on their way (rules/bot-loop.ts
  // SLOTS_IN_USE_SQL counts them), out of `liveAtOnce`.
  const liveSlots = async (n, liveAtOnce = 12) => {
    await pool.query("DELETE FROM wf_events WHERE machine = 'bot-request' AND type = 'Granted' AND status = 'pending'").catch(async () => {
      await pool.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'; DELETE FROM wf_events WHERE machine = 'bot-request' AND type = 'Granted' AND status = 'pending'; COMMIT`);
    });
    await pool.query(`INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_live_at_once', $1)
                      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(liveAtOnce)]);
    for (let i = 0; i < n; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query("INSERT INTO wf_events (machine, key, type, payload, source, request_key) VALUES ('bot-request', $1, 'Granted', '{\"kind\": \"build\"}'::jsonb, '{}'::jsonb, $2)",
        [`request:1:${i + 1}`, `g-${crypto.randomUUID()}`]);
    }
  };
  const runRow = async (id) => (await pool.query('SELECT status, spent_usd::float8 AS spent FROM bench_runs WHERE id = $1', [id])).rows[0];
  const laneData = async () => (await pool.query('SELECT data, deadline_at FROM wf_instances WHERE machine = $1 AND key = $2', [benchLaneMod.MACHINE, benchLaneMod.KEY])).rows[0];
  // Every run of an earlier subtest put away, so each starts with a lane of its own.
  const okStage = async ({ stage, model, trial }) => {
    ran.push(`${stage}:${model}:${trial.id}`);
    return { status: 'ok', cost_usd: 1.25, parsed: { verdict: 'ready' }, duration_ms: 5 };
  };
  const closeAll = async () => {
    runner.runStage = okStage;
    await pool.query("UPDATE bench_runs SET status = 'cancelled' WHERE status IN ('queued', 'running')");
    await pool.query("UPDATE bench_trials SET status = 'cancelled' WHERE status IN ('pending', 'running', 'awaiting')");
  };

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


  await t.test('L1: the lane waits for the live bot, runs a run\'s trials as builds, charges the run once each, and finishes it', async () => {
    await closeAll();
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 1, concurrency: 2 });
    await liveSlots(1, 1);
    await lookNow();
    await settle();
    assert.deepEqual((await trials(run.id)).map((r) => r.status), ['pending', 'pending', 'pending'], 'the live bot uses its one slot');
    const held = await laneData();
    assert.ok(held.deadline_at && Date.parse(held.deadline_at) > Date.now(), 'it looks again later');
    await liveSlots(0);
    await lookNow();
    await rt.drain();
    await rt.runServices(); // the allowance
    await rt.drain();
    const claimed = (await pool.query("SELECT id, build_key FROM bench_trials WHERE run_id = $1 AND status = 'running' ORDER BY id", [run.id])).rows;
    assert.equal(claimed.length, 2, 'two at once: the run\'s concurrency');
    assert.ok(claimed.every((c) => /^trial:\d+@c1\.g\d+$/.test(c.build_key)), 'each claim names its build');
    const { rows: asked } = await pool.query("SELECT key, payload FROM wf_events WHERE machine = 'bot-build' AND type = 'Requested' AND key = ANY($1::text[])", [claimed.map((c) => c.build_key)]);
    assert.equal(asked.length, 2, 'its build asked for in the same transition');
    assert.deepEqual(asked[0].payload.replyTo, { machine: 'bench-lane', key: 'lane' });
    await settle();
    assert.deepEqual((await trials(run.id)).map((r) => r.status), ['ok', 'ok', 'ok']);
    assert.deepEqual(await runRow(run.id), { status: 'done', spent: 3.75 });
  });

  await t.test('L2: a provider refusing the bench key for its spending limit: an infra_fail, and nothing new starts until the pause ends', async () => {
    await closeAll();
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 2, concurrency: 1 });
    const refused = 'the build turn failed (the agent exited with code 1); last activity: Failed to authenticate. API Error: 403 Key limit exceeded (weekly limit).';
    runner.runStage = async () => ({ status: 'model_fail', error: refused, cost_usd: 0.04, duration_ms: 5 });
    try {
      await lookNow();
      await settle();
      const done = (await trials(run.id)).filter((x) => x.status !== 'pending');
      assert.equal(done.length, 1, 'one ran, and the next waits on the pause');
      assert.equal(done[0].status, 'infra_fail', 'the platform\'s fault, out of the arm\'s build rate');
      const pause = await lane.providerLimitPause(pool);
      assert.ok(pause && Date.parse(pause.until) > Date.now());
      assert.equal(new Date((await laneData()).deadline_at).toISOString(), pause.until, 'its clock is the pause\'s end');
      // Past it, the next trial finds out whether the key works again.
      await pool.query("UPDATE bench_trials SET finished_at = NOW() - INTERVAL '31 minutes' WHERE id = $1", [done[0].id]);
      runner.runStage = async () => ({ status: 'ok', cost_usd: 1.25, parsed: { verdict: 'ready' }, duration_ms: 5 });
      await lookNow();
      await settle();
      assert.equal((await trials(run.id)).filter((x) => x.status === 'ok').length, 5, 'every one left, the key working again');
    } finally {
      runner.runStage = async ({ stage, model, trial }) => {
        ran.push(`${stage}:${model}:${trial.id}`);
        return { status: 'ok', cost_usd: 1.25, parsed: { verdict: 'ready' }, duration_ms: 5 };
      };
    }
  });

  await t.test('L3: the cap: no trial starts that would cross it, and the rest are skipped', async () => {
    await closeAll();
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 3, capUsd: 3 });
    // Each trial is estimated at $1 and costs $1.25.
    await pool.query('UPDATE bench_trials SET est_cost_usd = 1 WHERE run_id = $1', [run.id]);
    await lookNow();
    await settle();
    const rows = await trials(run.id);
    assert.equal(rows.filter((x) => x.status === 'ok').length, 2, 'two fit: $1.25 + $1.25 spent, and a third estimated at $1 would make $3.50');
    assert.equal(rows.filter((x) => x.status === 'skipped_cap').length, 7);
    const r = await runRow(run.id);
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
  // A claim as the lane's transition writes it (only it may).
  const claimAs = async (trialId, sessionId, { claims = 1, ago = '10 minutes', baseSha = null, buildKey = null } = {}) => {
    const c = await pool.connect();
    try {
      await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      await c.query(
        `UPDATE bench_trials
            SET status = 'running', claims = $2, started_at = NOW() - $3::interval, session_id = $4, base_sha = $5,
                build_branch = 'bench/r' || run_id || '-t' || id, build_key = $6
          WHERE id = $1`,
        [trialId, claims, ago, sessionId, baseSha, buildKey]);
      await c.query('COMMIT');
    } finally { c.release(); }
  };
  const trialRow = async (id) => (await pool.query(
    `SELECT id, status, error, claims, session_id, base_sha, cost_usd::float8 AS cost, parsed, recovered_at, finished_at,
            interrupted_cost_usd::float8 AS interrupted, build_commits, diff
       FROM bench_trials WHERE id = $1`, [id],
  )).rows[0];
  const spent = async (runId) => (await pool.query('SELECT spent_usd::float8 AS s FROM bench_runs WHERE id = $1', [runId])).rows[0].s;
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


  await t.test('R1: a trial\'s sessions are on its row before its turns run; one lost is charged for all of them', async () => {
    await closeAll();
    debits.length = 0;
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 1 });
    const [a] = await trials(run.id);
    await claimAs(a.id, null, { buildKey: `trial:${a.id}@c1.g1` });
    // A first version's triage, then its build: two sessions.
    const s1 = await newSession();
    const s2 = await newSession();
    await spend(s1, 0.3);
    await spend(s2, 0.5);
    let during = null;
    runner.runStage = async (ctx) => {
      await ctx.onSession(s1, { baseSha: BASE, branch: runner.branchFor(ctx.trial) });
      await ctx.onSession(s2, {});
      during = await trialRow(ctx.trial.id);
      throw Object.assign(new Error('the process stopped'), { code: 'steps_stopped', stopped: true });
    };
    const steps = durableSteps.durable({ checkpoint: async () => {} });
    await assert.rejects(lane.executeTrial(pool, {}, { id: a.id, run_id: run.id }, { ...deps, durable: steps, buildKey: `trial:${a.id}@c1.g1` }));
    assert.equal(during.session_id, s2, 'the session is recorded before the turn, not at the trial\'s end');
    const { rows: [ids] } = await pool.query('SELECT session_ids, build_branch FROM bench_trials WHERE id = $1', [a.id]);
    assert.deepEqual(ids.session_ids, [s1, s2], 'every session it opened');
    // Its build failed for good: recorded lost, charged for both sessions.
    await lane.recordLostTrial({ pool, config: {}, id: a.id, nonce: 'c1.g1', error: { message: 'kept failing' } });
    const row = await trialRow(a.id);
    assert.equal(row.status, 'infra_fail');
    assert.equal(row.cost, 0.8, 'the triage\'s cost too');
    assert.equal(await spent(run.id), 0.8);
    assert.deepEqual(debits, [80]);
    const { rows: [kept] } = await pool.query('SELECT build_branch FROM bench_trials WHERE id = $1', [a.id]);
    assert.equal(kept.build_branch, ids.build_branch, 'its branch still named, for the sweep');
    runner.runStage = async ({ stage, model, trial }) => {
      ran.push(`${stage}:${model}:${trial.id}`);
      return { status: 'ok', cost_usd: 1.25, parsed: { verdict: 'ready' }, duration_ms: 5 };
    };
  });

  await t.test('R2: only the build the claim named records the trial', async () => {
    await closeAll();
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 1 });
    const [a] = await trials(run.id);
    await claimAs(a.id, null, { buildKey: `trial:${a.id}@c2.g9` });
    // An earlier claim's build, lost: it records nothing over the new claim.
    await lane.recordLostTrial({ pool, config: {}, id: a.id, nonce: 'c1.g3', error: { message: 'lost' } });
    assert.equal((await trialRow(a.id)).status, 'running');
    // Nor does an earlier claim's build that reached its record (the claim
    // moved on between its read and its write): the write itself is fenced.
    const row = await lane.loadTrialContext(pool, a.id);
    await lane.recordTrial(pool, {
      trialRow: { id: a.id, run_id: run.id }, row, user, d: { ...deps, ...moneyDeps }, buildKey: `trial:${a.id}@c1.g3`,
      patch: { status: 'infra_fail', error: 'lost', cost_usd: 2 },
    });
    assert.equal((await trialRow(a.id)).status, 'running');
    assert.equal(await spent(run.id), 0, 'nor charged');
    // Nor does it run.
    const before = ran.length;
    assert.deepEqual(await lane.runTrial({ pool, config: {}, id: a.id, input: { nonce: 'c1.g3' }, steps: durableSteps.durable({ checkpoint: async () => {} }) }),
      { status: 'not_this_claim' });
    assert.equal(ran.length, before);
  });

  await t.test('R3: the trial recorded and its run charged in one write: a failure between them charges on the next try', async () => {
    await closeAll();
    debits.length = 0;
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 1 });
    const [a] = await trials(run.id);
    const key = `trial:${a.id}@c1.g1`;
    await claimAs(a.id, null, { buildKey: key });
    // The run's charge fails once, as a dropped connection would.
    // (A sequence counts outside the transaction the failure rolls back.)
    await pool.query(`CREATE SEQUENCE r3_fail;
      CREATE FUNCTION r3_fail_charge() RETURNS trigger AS $$
      BEGIN IF NEW.spent_usd <> OLD.spent_usd AND nextval('r3_fail') = 1 THEN RAISE EXCEPTION 'the connection dropped'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER r3_fail_charge BEFORE UPDATE ON bench_runs FOR EACH ROW EXECUTE FUNCTION r3_fail_charge();`);
    try {
      const steps = () => durableSteps.durable({ checkpoint: async () => {} });
      await assert.rejects(lane.executeTrial(pool, {}, { id: a.id, run_id: run.id }, { ...deps, durable: steps(), buildKey: key }), /connection dropped/);
      assert.equal((await trialRow(a.id)).status, 'running', 'not recorded without its charge');
      assert.equal(await lane.executeTrial(pool, {}, { id: a.id, run_id: run.id }, { ...deps, durable: steps(), buildKey: key }), 'ok');
      assert.equal(await spent(run.id), 1.25, 'charged, once');
    } finally {
      await pool.query('DROP TRIGGER r3_fail_charge ON bench_runs; DROP FUNCTION r3_fail_charge(); DROP SEQUENCE r3_fail');
    }
  });
  await t.test('a trial keeps its looks as a step while its turns run; the attempt after a restart starts from them, each counted once', async () => {
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
    await claimAs(trial.id, null, { buildKey: `trial:${trial.id}@c1.g1` });
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
      assert.equal(await lane.executeTrial(pool, {}, { id: trial.id, run_id: run.id }, { ...deps, durable: steps, buildKey: `trial:${trial.id}@c1.g1` }), 'ok');
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

  await t.test('a trial is recorded once: an attempt a restart caught after it recorded the trial, and before that was saved, charges nothing twice', async () => {
    await closeAll();
    debits.length = 0;
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 1 });
    const [a] = await trials(run.id);
    await claimAs(a.id, null, { buildKey: `trial:${a.id}@c1.g1` });
    const sid = await newSession();
    await spend(sid, 0.42);
    runner.runStage = async (ctx) => {
      await ctx.onSession(sid, { baseSha: BASE, branch: runner.branchFor(ctx.trial) });
      return { status: 'ok', session_id: sid, base_sha: BASE, build_branch: runner.branchFor(ctx.trial), parsed: { verdict: 'ready' }, duration_ms: 5 };
    };
    const tdeps = { ...deps, ...moneyDeps, github: fakeGithub(), buildKey: `trial:${a.id}@c1.g1` };
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


  // ── Limits, counted from the rows ─────────────────────────────────────

  // The lane grants; nothing here lets the builds run, so every grant stays
  // a running trial whose build has not started: the slots it takes are
  // counted all the same (they are running rows, claimed in the transition
  // that asked for the build).
  // The allowance's look kept by an earlier subtest is stale once a minute
  // has passed: made so.
  const staleGate = () => pool.query(`BEGIN; SET LOCAL app.wf_writer = 'transition';
    UPDATE wf_instances SET data = jsonb_set(data, '{gate,at}', to_jsonb((now() - interval '2 minutes')::text)) WHERE machine = 'bench-lane'; COMMIT`);
  const grantOnly = async () => { await lookNow(laneOnly); await laneOnly.drain(); await laneOnly.runServices(); await laneOnly.drain(); };
  const runningOf = async (runId) => (await pool.query(
    `SELECT tr.id, t.stage FROM bench_trials tr JOIN bench_tasks t ON t.id = tr.task_id WHERE tr.run_id = $1 AND tr.status = 'running'`, [runId])).rows;

  await t.test('L4: a run takes up to its concurrency at once, granted builds counted though none has started', async () => {
    await closeAll();
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 3, concurrency: 8 });
    await grantOnly();
    assert.equal((await runningOf(run.id)).length, 8);
    await grantOnly();
    assert.equal((await runningOf(run.id)).length, 8, 'the ninth waits: the eight granted hold their slots before their builds start');
  });

  await t.test('L5: at most three heavy trials of a run at once; its light ones go meanwhile', async () => {
    await closeAll();
    const { run } = await lane.launchRun(pool, {
      suiteId: suite.id, models: ['z-ai/glm-5.3-flash', 'moonshotai/kimi-k2.7-code'], stages: ['triage', 'build'], repeats: 1, concurrency: 8,
    });
    await grantOnly();
    const flying = await runningOf(run.id);
    assert.equal(flying.filter((f) => f.stage === 'build').length, 3, 'three builds, not six');
    assert.equal(flying.filter((f) => f.stage === 'triage').length, 3, 'every triage trial, including one ordered after the fourth build');
  });

  await t.test('L6: at most eleven trials in flight across every run', async () => {
    await closeAll();
    assert.equal(lane.MAX_IN_FLIGHT, 11);
    const a = (await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 3, concurrency: 7 })).run;
    const b = (await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 3, concurrency: 7 })).run;
    await grantOnly();
    assert.equal((await runningOf(a.id)).length, 7);
    assert.equal((await runningOf(b.id)).length, 4, 'the second run gets what is left of the eleven');
  });

  await t.test('L7: a later change\'s side builds take only the live slots live work leaves free', async () => {
    await closeAll();
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 3, concurrency: 9 });
    await pool.query("UPDATE bench_runs SET kind = 'bot_config_later' WHERE id = $1", [run.id]);
    await liveSlots(2, 4);
    try {
      await grantOnly();
      assert.equal((await runningOf(run.id)).length, 2, 'two live, two side builds: four of the four');
    } finally { await liveSlots(0); }
  });

  await t.test('L8: the bench user\'s allowance spent: nothing starts, and the lane looks again', async () => {
    await closeAll();
    allowed = false;
    try {
      const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 1 });
      await staleGate();
      await grantOnly();
      assert.equal((await runningOf(run.id)).length, 0);
      const d = await laneData();
      assert.equal(d.data.gate.ok, false);
      assert.ok(d.deadline_at, 'looked at again in a minute');
    } finally { allowed = true; await staleGate(); }
  });

  // ── Cancels ───────────────────────────────────────────────────────────

  await t.test('C1: a cancelled run claims nothing more, its waiting trials are cancelled, its running ones stopped by their builds', async () => {
    await closeAll();
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 3, concurrency: 2 });
    await grantOnly();
    const flying = await runningOf(run.id);
    assert.equal(flying.length, 2);
    assert.equal((await lane.cancelRun(pool, run.id, { platform: { benchCancelRun: (id, o) => cancel(laneOnly, 'RunCancelled', { runId: id, by: o.by }) } })).ok, true);
    const again = await lane.cancelRun(pool, run.id, { platform: { benchCancelRun: (id) => cancel(laneOnly, 'RunCancelled', { runId: id }) } });
    assert.equal(again.status, 409);
    const rows = await trials(run.id);
    assert.equal(rows.filter((x) => x.status === 'cancelled').length, 7, 'the waiting ones');
    const { rows: stops } = await pool.query(
      "SELECT key FROM wf_events WHERE machine = 'bot-build' AND type = 'StopRequested' AND key = ANY(SELECT build_key FROM bench_trials WHERE run_id = $1)", [run.id]);
    assert.equal(stops.length, 2, 'each running trial\'s build told to stop');
    // Its builds take their Requested, then the Stop: never run, recorded cancelled.
    await settle();
    assert.ok((await trials(run.id)).every((x) => x.status === 'cancelled'), JSON.stringify(await trials(run.id)));
    assert.equal((await runRow(run.id)).status, 'cancelled');
  });

  await t.test('C2: a trial cancelled before its build exists is stopped all the same, and never runs', async () => {
    await closeAll();
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 1, concurrency: 1 });
    await grantOnly();
    const [t1] = await runningOf(run.id);
    const before = ran.length;
    const out = await lane.cancelTrial(pool, t1.id, { platform: { benchCancelTrial: (id, o) => cancel(laneOnly, 'TrialCancelled', { trialId: id, by: o.by }) } });
    assert.deepEqual(out, { ok: true, status: 'stopping' });
    await settle();
    assert.equal(ran.length, before, 'its stage never ran');
    assert.equal((await trialRow(t1.id)).status, 'cancelled');
    // A waiting one is cancelled at once; one already ended is refused.
    const [pending] = (await trials(run.id)).filter((x) => x.status === 'pending');
    assert.deepEqual(await lane.cancelTrial(pool, pending.id, { platform: { benchCancelTrial: (id) => cancel(rt, 'TrialCancelled', { trialId: id }) } }), { ok: true, status: 'cancelled' });
    const refused = await lane.cancelTrial(pool, t1.id, { platform: { benchCancelTrial: (id) => cancel(rt, 'TrialCancelled', { trialId: id }) } });
    assert.equal(refused.status, 409);
  });

  await t.test('C3: a trial added to a run marked done reopens it and runs', async () => {
    await closeAll();
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 1, concurrency: 3 });
    await lookNow();
    await settle();
    assert.equal((await runRow(run.id)).status, 'done');
    const [one] = await trials(run.id);
    await pool.query(
      `INSERT INTO bench_trials (run_id, task_id, model, attempt, status, item_token, est_cost_usd)
       SELECT run_id, task_id, model, attempt + 1, 'pending', md5(random()::text), est_cost_usd FROM bench_trials WHERE id = $1`, [one.id]);
    await lookNow(rt, run.id);
    await settle();
    assert.equal((await runRow(run.id)).status, 'done', 'reopened, ran, and done again');
    assert.equal((await trials(run.id)).filter((x) => x.status === 'ok').length, 4);
  });

  await t.test('C4: only the lane claims a trial: an older build\'s claim is refused', async () => {
    await closeAll();
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 1 });
    const [one] = await trials(run.id);
    await assert.rejects(pool.query("UPDATE bench_trials SET status = 'running' WHERE id = $1 AND status = 'pending'", [one.id]), /WF_OWNERSHIP_VIOLATION/);
  });
});
