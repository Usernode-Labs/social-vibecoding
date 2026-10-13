'use strict';

// #3654: running the benchmark from an admin's Claude session, against the
// FULL PostgreSQL schema and the real routes (routes/homeroom-bench.js
// /api/bot-bench/runs). Every door refuses anybody but a full platform admin;
// a run's results reach the session as aggregates per stage and model, with
// failure reasons grouped and nothing that names one trial; a launch must
// name its cap, and a cap over $100 needs confirmLargeCap; a cancel is the
// console's own.
//
// Skips when no database is reachable, unless TEST_DATABASE_URL insists.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const A = 'z-ai/glm-5.3-flash';
const B = 'anthropic/claude-sonnet-5.5';

/** Every key anywhere in a JSON value. */
function keysOf(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.add(k); keysOf(v, out); }
  }
  return out;
}

test('running the benchmark through the connector routes, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bench_runs_conn_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  const poolMod = require('../src/db/pool');
  const realGetPool = poolMod.getPool;
  poolMod.getPool = () => pool;
  const lane = require('../src/services/bench/lane');
  let server;
  t.after(async () => {
    poolMod.getPool = realGetPool;
    lane._resetForTests();
    if (server) await new Promise((r) => server.close(r));
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);

  const suites = require('../src/services/bench/suites');
  const snapshots = require('../src/services/homeroom-bot-snapshots');
  const report = require('../src/services/bench/report');
  const { homeroomBenchRoutes } = require('../src/routes/homeroom-bench');

  const { rows: [app] } = await pool.query(
    "INSERT INTO apps (name, slug, status, repo_url) VALUES ('Blind', 'todo-blind', 'running', 'https://github.com/o/todo-blind') RETURNING id",
  );
  const { rows: [evan] } = await pool.query("INSERT INTO users (username, password, is_admin) VALUES ('evan', 'x', TRUE) RETURNING id");
  const { suite } = await suites.createSuite(pool, { name: 'connector' });
  const task = async (stage, issue) => {
    const { rows: [r] } = await pool.query(
      "INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict) VALUES ($1, $2, 'shadow', 'ready') RETURNING id", [app.id, issue],
    );
    await snapshots.recordSnapshot(pool, {
      runId: r.id, stage, appId: app.id, issueNumber: issue, baseSha: 'a'.repeat(40), texts: { seed: `Issue #${issue}`, prompt: 'p' },
    });
    const out = await suites.addTaskFromRun(pool, { suiteId: suite.id, runId: r.id, stage });
    assert.ok(out.ok, JSON.stringify(out));
    return out.task.id;
  };
  const t1 = await task('triage', 7771);
  const t2 = await task('triage', 7772);
  const t3 = await task('build', 7773);

  const { rows: [run] } = await pool.query(
    `INSERT INTO bench_runs (suite_id, models, baseline_model, stages, repeats, cap_usd, spent_usd, status)
     VALUES ($1, ARRAY[$2, $3], $2, ARRAY['triage','build'], 2, 2, 2.40, 'done') RETURNING id`,
    [suite.id, A, B],
  );
  const tokens = [];
  const trial = async (taskId, model, attempt, status, { cost = null, error = null, deterministic = null, branch = null } = {}) => {
    const token = crypto.randomBytes(12).toString('base64url');
    tokens.push(token);
    const { rows: [tr] } = await pool.query(
      `INSERT INTO bench_trials (run_id, task_id, model, attempt, status, item_token, cost_usd, error, deterministic, build_branch, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, 1000) RETURNING id`,
      [run.id, taskId, model, attempt, status, token, cost, error, deterministic ? JSON.stringify(deterministic) : null, branch],
    );
    return tr.id;
  };
  // triage on A: a pass, a model failure, and one not run yet.
  const aPass = await trial(t1, A, 1, 'ok', { cost: 0.10, deterministic: { pass: true } });
  await trial(t2, A, 1, 'model_fail', { cost: 0.05, error: 'unparseable: no verdict block' });
  await trial(t1, A, 2, 'pending');
  // triage on B: a fail, one waiting for the judge, one skipped at the cap.
  await trial(t1, B, 1, 'ok', { cost: 0.20, deterministic: { pass: false } });
  await trial(t2, B, 1, 'ok', { cost: 0.30, deterministic: { needsJudge: true } });
  await trial(t1, B, 2, 'skipped_cap', { error: 'over the cap' });
  // build on A: two platform faults that differ only in branch, SHA and status
  // code, so they group as one reason; on B, a timeout.
  await trial(t3, A, 1, 'infra_fail', { error: 'branch: could not push bench/r1-t3-abc at 4f2c9e1d (HTTP 502)', branch: 'bench/r1-t3-abc' });
  await trial(t3, A, 2, 'infra_fail', { error: 'branch:  could not push bench/r1-t3-zz9 at 9a8b7c6e (HTTP 503)' });
  await trial(t3, B, 1, 'timeout', { cost: 0.40, error: 'the turn ran past its time limit' });
  // The judge and a person agree on one trial.
  for (const grader of ['opus', 'human']) {
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      "INSERT INTO bench_grades (trial_id, grader, grader_user_id, grader_label, verdict, critique) VALUES ($1, $2, $3, 'evan', 'pass', 'Right.')",
      [aPass, grader, evan.id],
    );
  }

  const appX = express();
  appX.use(express.json());
  appX.use((req, _res, next) => {
    const who = req.headers['x-test-user'];
    if (who === 'admin') req.user = { id: evan.id, username: 'evan', isAdmin: true, canAdminWrite: true };
    if (who === 'viewer') req.user = { id: evan.id, username: 'viewer', isAdmin: true, canAdminWrite: false };
    if (who === 'member') req.user = { id: evan.id, username: 'ann', isAdmin: false, canAdminWrite: false };
    req.cliAuthenticated = true;
    next();
  });
  appX.use(homeroomBenchRoutes({}));
  server = http.createServer(appX);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { who = 'admin', body } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user': who },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  await t.test('every run door refuses anybody but a full platform admin, before it reads or writes', async () => {
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM bench_runs')).rows[0].n;
    for (const who of ['member', 'viewer', 'nobody']) {
      for (const [method, path, body] of [
        ['GET', '/api/bot-bench/runs'],
        ['GET', `/api/bot-bench/runs/${run.id}`],
        ['POST', '/api/bot-bench/runs', { suiteId: suite.id, models: [A], stages: ['triage'], capUsd: 1 }],
        ['POST', `/api/bot-bench/runs/${run.id}/cancel`],
      ]) {
        // eslint-disable-next-line no-await-in-loop
        const r = await call(method, path, { who, body });
        assert.equal(r.status, 403, `${who} ${method} ${path}`);
      }
    }
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM bench_runs')).rows[0].n, before, 'nothing was launched');
  });

  await t.test('a run\'s results are aggregates per stage and model, with failure reasons grouped', async () => {
    const r = await call('GET', `/api/bot-bench/runs/${run.id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body;
    assert.equal(b.run.id, run.id);
    assert.equal(b.run.capUsd, 2);
    assert.equal(b.run.spentUsd, 2.4);
    assert.equal(b.trials, 9);
    assert.deepEqual(b.statuses, { ok: 3, model_fail: 1, pending: 1, skipped_cap: 1, infra_fail: 2, timeout: 1 });
    assert.equal(b.pendingJudge, 1);
    const cell = (stage, model) => b.cells.find((c) => c.stage === stage && c.model === model);

    const ta = cell('triage', A);
    assert.deepEqual(ta.statuses, { ok: 1, model_fail: 1, pending: 1 });
    assert.deepEqual([ta.trials, ta.pass, ta.fail, ta.graded, ta.pendingJudge], [3, 1, 1, 2, 0]);
    assert.equal(ta.accuracy, 0.5);
    assert.ok(Math.abs(ta.costUsd - 0.15) < 1e-9);
    assert.ok(Math.abs(ta.costPerAttempt - 0.075) < 1e-9, 'per attempt counts the failed attempt too');
    assert.ok(Math.abs(ta.costPerSuccess - 0.15) < 1e-9);
    assert.deepEqual(ta.failureReasons, [{ status: 'model_fail', reason: 'unparseable: no verdict block', count: 1 }]);
    assert.equal(ta.baseline, true);

    const tb = cell('triage', B);
    assert.deepEqual([tb.pass, tb.fail, tb.pendingJudge], [0, 1, 1]);
    assert.equal(tb.costPerSuccess, null, 'no success, no cost per success');
    assert.deepEqual(tb.failureReasons, [{ status: 'skipped_cap', reason: 'over the cap', count: 1 }]);

    const ba = cell('build', A);
    assert.deepEqual(ba.statuses, { infra_fail: 2 });
    assert.equal(ba.infraRate, 1);
    assert.equal(ba.accuracy, null, 'platform faults are not the model\'s');
    assert.deepEqual(ba.failureReasons, [{ status: 'infra_fail', reason: 'branch: could not push bench/… at <sha> (HTTP N)', count: 2 }]);
    assert.deepEqual(cell('build', B).failureReasons, [{ status: 'timeout', reason: 'the turn ran past its time limit', count: 1 }]);

    const paired = b.paired.find((p) => p.stage === 'triage' && p.model === B);
    assert.deepEqual([paired.n, paired.apps, paired.diff, paired.baselineModel], [1, 1, -1, A]);
    assert.deepEqual(b.agreement, { n: 1, agreement: 1, tpr: 1, tnr: null, positives: 1, negatives: 0 });
    assert.equal(b.slice.key, 'verdict');
    assert.ok(!b.slice.keys.includes('app_slug'));
  });

  await t.test('nothing in a run\'s results names one trial; the same data read for the CSV does (negative control)', async () => {
    const r = await call('GET', `/api/bot-bench/runs/${run.id}?slice=app_slug`);
    assert.equal(r.body.slice.key, 'verdict', 'slicing by app is not offered');
    const text = JSON.stringify(r.body);
    const keys = keysOf(r.body);
    for (const k of ['trial_id', 'trialId', 'task_id', 'taskId', 'item_token', 'itemToken', 'label_token', 'issue_number',
      'issueNumber', 'app_slug', 'appSlug', 'build_branch', 'error', 'tags', 'critique']) {
      assert.ok(!keys.has(k), `no ${k} key`);
    }
    for (const needle of [...tokens, '7771', '7772', '7773', 'todo-blind', 'bench/r1-t3', '4f2c9e1d', 'Right.']) {
      assert.ok(!text.includes(needle), `${needle} is not in the results`);
    }
    assert.deepEqual(Object.keys(r.body).sort(), ['agreement', 'cells', 'paired', 'pendingJudge', 'run', 'slice', 'statuses', 'trials']);
    for (const c of r.body.cells) {
      assert.deepEqual(Object.keys(c).sort(), [
        'accuracy', 'baseline', 'costPerAttempt', 'costPerSuccess', 'costUsd', 'fail', 'failureReasons', 'graded', 'infraRate',
        'model', 'moreReasons', 'p50Ms', 'p95Ms', 'paretoFrontier', 'pass', 'passK', 'pendingJudge', 'stage', 'statuses',
        'timeoutRate', 'trials', 'unlabelled',
      ]);
    }
    // The control: the admin's own CSV of the same run carries every one of
    // those, so their absence above is the filter's doing, not the seed's.
    const csv = JSON.stringify(await report.csvRows(pool, run.id));
    for (const needle of ['7771', 'todo-blind', 'bench/r1-t3', '4f2c9e1d']) assert.ok(csv.includes(needle), `${needle} is in the CSV`);
    const raw = JSON.stringify(await report.runTrials(pool, run.id));
    assert.ok(raw.includes('"task_id"') && raw.includes('"issue_number"'), 'the trials the report reads are per trial');
  });

  await t.test('a launch names its cap; over $100 it needs confirmLargeCap; the launcher\'s validation answers as it does', async () => {
    const launch = (body) => call('POST', '/api/bot-bench/runs', { body: { suiteId: suite.id, models: [A], stages: ['triage'], repeats: 1, ...body } });
    const noCap = await launch({});
    assert.equal(noCap.status, 400);
    assert.match(noCap.body.error, /capUsd is required/);
    const big = await launch({ capUsd: 150 });
    assert.equal(big.status, 400);
    assert.match(big.body.error, /confirmLargeCap/);
    const truthy = await launch({ capUsd: 150, confirmLargeCap: 'yes' });
    assert.equal(truthy.status, 400, 'only true confirms');
    const badModel = await launch({ capUsd: 5, models: ['not a model'] });
    assert.equal(badModel.status, 400);
    assert.match(badModel.body.error, /not an OpenRouter model id/);
    const overMax = await launch({ capUsd: 5000, confirmLargeCap: true });
    assert.equal(overMax.status, 400);
    assert.match(overMax.body.error, /The cap must be from/);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM bench_runs')).rows[0].n, 1, 'no refused launch made a run');

    const ok = await launch({ capUsd: 150, confirmLargeCap: true, note: 'From a session.' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.run.capUsd, 150);
    assert.equal(ok.body.run.status, 'queued');
    assert.equal(ok.body.trials, 2, 'two triage tasks, one model, one attempt');
    assert.equal(typeof ok.body.estimateUsd, 'number');
    const { rows: [stored] } = await pool.query('SELECT cap_usd::float8 AS cap, started_by, note FROM bench_runs WHERE id = $1', [ok.body.run.id]);
    assert.deepEqual(stored, { cap: 150, started_by: evan.id, note: 'From a session.' });

    const list = await call('GET', '/api/bot-bench/runs?limit=5');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.runs.map((x) => x.id), [ok.body.run.id, run.id], 'newest first');
    assert.deepEqual(list.body.runs[0].counts, { pending: 2 });
    assert.equal(list.body.runs[1].counts.infra_fail, 2);
    assert.equal(list.body.confirmAboveUsd, 100);
    assert.deepEqual(list.body.suites.map((s) => [s.id, s.counts]), [[suite.id, { triage: 2, build: 1 }]]);
    assert.ok(Array.isArray(list.body.launcher.models));

    const cancelled = await call('POST', `/api/bot-bench/runs/${ok.body.run.id}/cancel`);
    assert.equal(cancelled.status, 200);
    const { rows } = await pool.query('SELECT status FROM bench_trials WHERE run_id = $1', [ok.body.run.id]);
    assert.deepEqual(rows.map((x) => x.status), ['cancelled', 'cancelled']);
    assert.equal((await pool.query('SELECT status FROM bench_runs WHERE id = $1', [ok.body.run.id])).rows[0].status, 'cancelled');
    const again = await call('POST', `/api/bot-bench/runs/${ok.body.run.id}/cancel`);
    assert.equal(again.status, 409);
    assert.match(again.body.error, /not running/);
    assert.equal((await call('GET', '/api/bot-bench/runs/999999')).status, 404);
  });
});
