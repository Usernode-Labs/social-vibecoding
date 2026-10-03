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
// trial nothing holds is released on the next pass; a trial recovery
// finishes holds its slot and is recorded through the shared finisher; one
// it cannot finish goes back in the queue.
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

  // ── After a restart ───────────────────────────────────────────────────

  const BASE = 'a'.repeat(40);
  const VERDICT = '```json\n{"verdict":"ready","build_note":"Pin the markers.","reason":"clear"}\n```';
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
  const benchSession = async (id) => (await pool.query(
    `SELECT cs.*, a.repo_url, u.username, u.is_synthetic AS user_is_synthetic
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id JOIN users u ON u.id = cs.user_id WHERE cs.id = $1`, [id],
  )).rows[0];
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

  await t.test('the lane releases a trial nothing holds at once; not one recovery owns, holds, or that is just claimed', async () => {
    lane._resetForTests();
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 2 });
    const [noTurn, withTurn, held, neverOpened, fresh] = await trials(run.id);
    await claimAs(noTurn.id, await newSession({ status: 'paused' }));
    await claimAs(withTurn.id, await newSession({ activeTurn: turnOf('scout') }));
    const heldSession = await newSession({ activeTurn: turnOf('scout') });
    await claimAs(held.id, heldSession, { ago: '1 day' });
    await claimAs(neverOpened.id, null);
    await claimAs(fresh.id, null, { ago: '0 seconds' });
    let finish;
    const recovery = new Promise((resolve) => { finish = resolve; });
    const plan = await lane.recoveryPlan(pool, await benchSession(heldSession), turnOf('scout'));
    assert.equal(plan.trial.id, held.id);
    assert.equal(plan.resumable, true, 'a triage turn is its trial\'s last');
    const holding = lane.holdRecoveredTrial(plan.trial, heldSession, recovery);
    assert.equal(lane._inFlightForTests().get(held.id).runId, run.id, 'held in a lane slot, at its estimate');

    assert.equal(await lane.releaseOrphaned(pool, moneyDeps), 2);
    assert.equal((await trialRow(noTurn.id)).status, 'pending', 'a session with no turn left');
    assert.equal((await trialRow(neverOpened.id)).status, 'pending', 'no session ever recorded');
    assert.equal((await trialRow(withTurn.id)).status, 'running', 'a turn record is restart recovery\'s');
    assert.equal((await trialRow(fresh.id)).status, 'running', 'inside the grace');
    assert.equal(await lane.releaseStale(pool, { turnSeconds: 1200 }), 0, 'releaseStale skips a trial recovery holds');
    assert.equal((await trialRow(held.id)).status, 'running');
    finish('done');
    assert.equal(await holding, 'done');
    assert.equal(lane._inFlightForTests().has(held.id), false, 'the slot is let go with the recovery');
    await pool.query("UPDATE bench_runs SET status = 'cancelled' WHERE id = $1", [run.id]);
  });

  await t.test('a triage turn recovery followed is read and recorded through the shared finisher, once', async () => {
    lane._resetForTests();
    debits.length = 0;
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 1 });
    const [a] = await trials(run.id);
    const turn = turnOf('scout');
    const sid = await newSession({ activeTurn: turn });
    await claimAs(a.id, sid, { baseSha: BASE });
    await spend(sid, 0.42);
    const session = await benchSession(sid);
    const graded = [];
    const gh = fakeGithub();
    const out = await lane.finishRecoveredTrial({
      pool, config: {}, session, activeTurn: turn, result: { lastResultText: VERDICT, exitCode: 0 },
      deps: { ...moneyDeps, github: gh, afterTrial: async (_p, id) => { graded.push(id); } },
    });
    assert.equal(out, 'ok');
    const row = await trialRow(a.id);
    assert.equal(row.status, 'ok');
    assert.equal(row.parsed.verdict, 'ready', 'parsed by the live stage\'s reader');
    assert.deepEqual(row.parsed.routedModels, ['z-ai/glm-5.3-flash']);
    assert.equal(row.cost, 0.42, 'its cost from the session\'s ledger');
    assert.equal(row.base_sha, BASE);
    assert.ok(row.recovered_at, 'marked finished after a restart');
    assert.equal(row.interrupted, 0);
    assert.equal(await spent(run.id), 0.42);
    assert.deepEqual(debits, [42]);
    assert.deepEqual(graded, [a.id], 'graded at once, as any trial');
    assert.deepEqual(gh.calls.deleted, [`bench/r${run.id}-t${a.id}`], 'its empty branch removed');
    assert.equal((await benchSession(sid)).status, 'archived');
    // The turn record's clear failed and recovery ran again: nothing twice.
    assert.equal(await lane.finishRecoveredTrial({ pool, config: {}, session, activeTurn: turn, result: { lastResultText: VERDICT }, deps: moneyDeps }), 'gone');
    assert.equal(await spent(run.id), 0.42);
    assert.deepEqual(debits, [42]);
    await pool.query("UPDATE bench_runs SET status = 'cancelled' WHERE id = $1", [run.id]);
  });

  await t.test('a build\'s build turn is finished with its diff; its spec turn, or a finish that fails, goes back in the queue', async () => {
    lane._resetForTests();
    debits.length = 0;
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['build'] });
    const [built, specOnly, noBase] = await trials(run.id);
    const gh = fakeGithub();
    const graded = [];
    const rdeps = { ...moneyDeps, github: gh, afterTrial: async (_p, id) => { graded.push(id); } };

    const buildTurn = turnOf('build');
    const sb = await newSession({ activeTurn: buildTurn, specMd: '# Pin the markers' });
    await claimAs(built.id, sb, { baseSha: BASE });
    await spend(sb, 0.1); // the spec turn
    await spend(sb, 0.9); // the build turn
    assert.equal(await lane.finishRecoveredTrial({
      pool, config: {}, session: await benchSession(sb), activeTurn: buildTurn,
      result: { pushOk: true, ahead: 2, sha: 'c'.repeat(40), exitCode: 0 }, deps: rdeps,
    }), 'ok');
    let row = await trialRow(built.id);
    assert.equal(row.status, 'ok');
    assert.equal(row.build_commits, 2);
    assert.match(row.diff, /app\.js/);
    assert.equal(row.parsed.built, true);
    assert.equal(row.parsed.spec, '# Pin the markers', 'the spec the session stored before the restart');
    assert.equal(row.cost, 1, 'both turns, as on the live path');
    assert.deepEqual(gh.calls.compared, [`${BASE}...bench/r${run.id}-t${built.id}`], 'diffed against the base it recorded');
    assert.deepEqual(gh.calls.deleted, [], 'a branch with commits is kept');
    assert.deepEqual(graded, [built.id]);

    const specTurn = turnOf('scout');
    const ss = await newSession({ activeTurn: specTurn });
    await claimAs(specOnly.id, ss, { baseSha: BASE });
    await spend(ss, 0.15);
    assert.equal((await lane.recoveryPlan(pool, await benchSession(ss), specTurn)).resumable, false,
      'a build\'s spec turn has the build still to run');
    assert.equal(await lane.finishRecoveredTrial({
      pool, config: {}, session: await benchSession(ss), activeTurn: specTurn, result: { lastResultText: '# Spec' }, deps: rdeps,
    }), 'released');
    row = await trialRow(specOnly.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.interrupted, 0.15);

    const nb = await newSession({ activeTurn: buildTurn });
    await claimAs(noBase.id, nb, { baseSha: null });
    assert.equal(await lane.finishRecoveredTrial({
      pool, config: {}, session: await benchSession(nb), activeTurn: buildTurn,
      result: { pushOk: true, ahead: 1, sha: 'd'.repeat(40) }, deps: rdeps,
    }), 'released', 'a build with no base on record cannot be diffed: it is run again');
    assert.equal((await trialRow(noBase.id)).status, 'pending');
    assert.deepEqual(graded, [built.id], 'nothing released is graded');
    assert.equal(await spent(run.id), 1.15);
    await pool.query("UPDATE bench_runs SET status = 'cancelled' WHERE id = $1", [run.id]);
  });

  await t.test('a recovered turn keeps the trial\'s own clock', async () => {
    lane._resetForTests();
    const { run } = await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage', 'build'], repeats: 1 });
    const rows = await trials(run.id);
    const startedAt = '2026-10-01T00:00:00.000Z';
    const bot = require('../src/services/homeroom-bot');
    const settings = await bot.readSettings(pool);
    const tri = rows.find((r) => r.attempt === 1);
    const st = await newSession({ activeTurn: turnOf('scout', { startedAt }) });
    await claimAs(tri.id, st);
    const stage = (await pool.query('SELECT t.stage FROM bench_trials tr JOIN bench_tasks t ON t.id = tr.task_id WHERE tr.id = $1', [tri.id])).rows[0].stage;
    const budgets = runner.budgetsFor(settings, { repo_url: 'https://github.com/o/todo' }, {}, stage);
    assert.equal(
      await lane.recoveryDeadline(pool, {}, await benchSession(st), turnOf('scout', { startedAt })),
      Date.parse(startedAt) + (stage === 'build' ? budgets.buildMs : budgets.turnMs),
    );
    assert.equal(await lane.recoveryDeadline(pool, {}, await benchSession(st), turnOf('scout', { startedAt: null })), null);
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

  await t.test('at most eight trials in flight across every run', async () => {
    lane._resetForTests();
    const g = gated();
    const a = (await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 3, concurrency: 5 })).run;
    const b = (await lane.launchRun(pool, { suiteId: suite.id, models: ['z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 3, concurrency: 5 })).run;
    const out = await lane.tick(pool, {}, deps);
    assert.equal(out.started, 8);
    assert.equal(out.paused, 'lane_full');
    const flying = [...lane._inFlightForTests().values()];
    assert.equal(flying.filter((f) => f.runId === a.id).length, 5);
    assert.equal(flying.filter((f) => f.runId === b.id).length, 3, 'the second run gets what is left of the eight');
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
