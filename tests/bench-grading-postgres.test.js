'use strict';

// #3654: grading the benchmark against the FULL PostgreSQL schema and the
// real routes. The judge's doors refuse anybody but a full platform admin;
// an item is blind (no trial id, no run, no model, model names masked); the
// queue offers only what a rule could not settle and nobody judged yet; a
// grade needs its critique; a person's grade overrides the judge's and the
// two are compared; labelling a task grades its trials again, and a frozen
// suite's task cannot be labelled.
//
// Skips when no database is reachable, unless TEST_DATABASE_URL insists.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const { Pool } = require('pg');
const { createSchemaDatabase } = require('./lib/schema-database');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('benchmark grading against the full PostgreSQL schema and its routes', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bench_grade_${crypto.randomBytes(6).toString('hex')}`;
  await createSchemaDatabase(admin, name);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  const poolMod = require('../src/db/pool');
  const realGetPool = poolMod.getPool;
  poolMod.getPool = () => pool;
  let server;
  t.after(async () => {
    poolMod.getPool = realGetPool;
    if (server) await new Promise((r) => server.close(r));
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  const suites = require('../src/services/bench/suites');
  const snapshots = require('../src/services/homeroom-bot-snapshots');
  const graders = require('../src/services/bench/graders');
  const grading = require('../src/services/bench/grading');
  const { homeroomBenchRoutes } = require('../src/routes/homeroom-bench');

  const { rows: [app] } = await pool.query(
    "INSERT INTO apps (name, slug, status, repo_url) VALUES ('Todo', 'todo', 'running', 'https://github.com/o/todo') RETURNING id",
  );
  const { rows: [evan] } = await pool.query("INSERT INTO users (username, password, is_admin) VALUES ('evan', 'x', TRUE) RETURNING id, username");
  const { suite } = await suites.createSuite(pool, { name: 'grading' });
  const task = async (stage, issue, reference = {}) => {
    const { rows: [r] } = await pool.query(
      "INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict) VALUES ($1, $2, 'shadow', 'ready') RETURNING id", [app.id, issue],
    );
    await snapshots.recordSnapshot(pool, {
      runId: r.id, stage: stage === 'spec' ? 'build' : stage, appId: app.id, issueNumber: issue,
      texts: { seed: `Please work on GitHub issue #${issue}: "Pins drift". Built with Claude in mind.`, prompt: 'p' },
    });
    const out = await suites.addTaskFromRun(pool, { suiteId: suite.id, runId: r.id, stage });
    if (Object.keys(reference).length) await suites.setReference(pool, { taskId: out.task.id, patch: reference, source: 'human' });
    return out.task.id;
  };
  const { rows: [run] } = await pool.query(
    `INSERT INTO bench_runs (suite_id, models, baseline_model, stages)
     VALUES ($1, ARRAY['z-ai/glm-5.3-flash','anthropic/claude-sonnet-5.5'], 'z-ai/glm-5.3-flash', ARRAY['triage','build']) RETURNING id`,
    [suite.id],
  );
  const trial = async (taskId, model, parsed, extra = {}) => {
    const { rows: [tr] } = await pool.query(
      `INSERT INTO bench_trials (run_id, task_id, model, attempt, status, item_token, parsed, build_commits, changed_files, diff)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10) RETURNING id, item_token`,
      [run.id, taskId, model, extra.attempt || 1, extra.status || 'ok', crypto.randomBytes(12).toString('base64url'),
        JSON.stringify(parsed), extra.commits ?? null, extra.files ? JSON.stringify({ files: extra.files }) : null, extra.diff || null],
    );
    await graders.gradeTrial(pool, tr.id);
    return tr;
  };

  const triageTask = await task('triage', 1, { verdict: 'question' });
  const buildTask = await task('build', 2);
  const unlabelled = await task('triage', 3);
  const right = await trial(triageTask, 'anthropic/claude-sonnet-5.5', {
    verdict: 'question', question: 'Which map? (Claude Sonnet 5.5 here)', questionAnswers: ['Route', 'City'], questionDefault: 'Route',
    routedModels: ['anthropic/claude-sonnet-5.5'],
  });
  const wrong = await trial(triageTask, 'z-ai/glm-5.3-flash', { verdict: 'ready', buildNote: 'GLM thinks: just pin them' });
  const built = await trial(buildTask, 'z-ai/glm-5.3-flash', { built: true, spec: '# Pins' }, {
    commits: 1, files: [{ filename: 'public/app.js', status: 'modified' }], diff: 'diff --git a/public/app.js\n+// written by glm-5.3-flash',
  });
  const scopeBreak = await trial(buildTask, 'anthropic/claude-sonnet-5.5', { built: true }, {
    commits: 1, files: [{ filename: 'tests/app.test.js', status: 'modified' }],
  });
  const waiting = await trial(unlabelled, 'z-ai/glm-5.3-flash', { verdict: 'person' });

  // An express app with the real routes, and a user picked per request.
  const appX = express();
  appX.use(express.json());
  appX.use((req, _res, next) => {
    const who = req.headers['x-test-user'];
    if (who === 'admin') req.user = { id: evan.id, username: 'evan', isAdmin: true, canAdminWrite: true };
    if (who === 'viewer') req.user = { id: evan.id, username: 'viewer', isAdmin: true, canAdminWrite: false };
    if (who === 'member') req.user = { id: evan.id, username: 'ann', isAdmin: false, canAdminWrite: false };
    if (req.headers['x-test-connector']) req.cliAuthenticated = true;
    next();
  });
  appX.use(homeroomBenchRoutes({}));
  server = http.createServer(appX);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { who = 'admin', connector = false, body } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user': who, ...(connector ? { 'x-test-connector': '1' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  await t.test('the judge\'s doors refuse anybody but a full platform admin', async () => {
    for (const who of ['member', 'viewer', 'nobody']) {
      for (const [method, path] of [
        ['GET', '/api/bot-bench/queue'], ['GET', `/api/bot-bench/items/${right.item_token}`],
        ['POST', `/api/bot-bench/items/${right.item_token}/grade`], ['POST', '/api/bot-bench/tasks/abcdefghijkl/label'],
      ]) {
        // eslint-disable-next-line no-await-in-loop
        const r = await call(method, path, { who, body: method === 'POST' ? { verdict: 'pass', critique: 'x'.repeat(30) } : undefined });
        assert.equal(r.status, 403, `${who} ${method} ${path}`);
      }
    }
    assert.equal((await call('GET', '/api/bot-bench/queue')).status, 200);
  });

  await t.test('rules settle what they can; the queue offers only what a judge must see', async () => {
    const det = async (id) => (await pool.query('SELECT deterministic FROM bench_trials WHERE id = $1', [id])).rows[0].deterministic;
    assert.equal((await det(wrong.id)).pass, false, 'the wrong verdict is failed by the rule');
    assert.equal((await det(right.id)).needsJudge, true);
    assert.equal((await det(built.id)).needsJudge, true);
    assert.equal((await det(scopeBreak.id)).pass, false, 'editing a pre-existing test fails the diff-scope rule');
    assert.equal((await det(waiting.id)).pass, null, 'no reference yet');
    const q = await call('GET', '/api/bot-bench/queue', { connector: true });
    assert.equal(q.status, 200);
    assert.deepEqual(q.body.items.map((i) => i.itemId).sort(), [right.item_token, built.item_token].sort());
    assert.ok(q.body.items.every((i) => Object.keys(i).sort().join() === 'itemId,kind,stage'), 'opaque ids and stages only');
  });

  await t.test('an item is blind: no trial id, no run, no model, model names masked in the candidate', async () => {
    for (const tr of [right, built]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await call('GET', `/api/bot-bench/items/${tr.item_token}`, { connector: true });
      assert.equal(r.status, 200);
      const text = JSON.stringify(r.body.item);
      for (const leak of ['glm', 'claude-sonnet', 'z-ai', 'anthropic', 'sonnet', 'routedModels']) {
        assert.ok(!r.body.item.candidate || !JSON.stringify(r.body.item.candidate).toLowerCase().includes(leak), `${leak} is not in the candidate`);
      }
      assert.doesNotMatch(text, /z-ai\/glm|anthropic\/claude/, 'no model id anywhere in the item');
      assert.ok(!('trialId' in r.body.item) && !('runId' in r.body.item) && !('model' in r.body.item));
      assert.doesNotMatch(text, new RegExp(`"${tr.id}"|"run_id"|"task_id"`));
      assert.match(text, /Built with Claude in mind/, 'the request itself is the task and is not scrubbed');
    }
    const item = (await call('GET', `/api/bot-bench/items/${right.item_token}`, { connector: true })).body.item;
    assert.equal(item.kind, 'grade');
    assert.equal(item.candidate.verdict, 'question');
    assert.equal(item.candidate.question, 'Which map? ([model] here)');
    assert.deepEqual(item.reference, { verdict: 'question' });
    assert.ok(item.rubric.criteria.length >= 3);
  });

  await t.test('a grade needs its critique; a person overrides the judge, and agreement is measured', async () => {
    const short = await call('POST', `/api/bot-bench/items/${right.item_token}/grade`, { connector: true, body: { verdict: 'pass', critique: 'ok' } });
    assert.equal(short.status, 400);
    assert.match(short.body.error, /critique first/);
    const g1 = await call('POST', `/api/bot-bench/items/${right.item_token}/grade`, {
      connector: true, body: { verdict: 'pass', critique: 'A real blocker, one question, sensible default.', criteria: { real_blocker: true, bogus: true } },
    });
    assert.equal(g1.status, 200);
    assert.equal(g1.body.grader, 'opus');
    const { rows: [stored] } = await pool.query('SELECT grader_label, criteria FROM bench_grades WHERE trial_id = $1', [right.id]);
    assert.equal(stored.grader_label, 'opus via connector (evan)');
    assert.deepEqual(stored.criteria, { real_blocker: true }, 'only the rubric\'s criteria');
    await call('POST', `/api/bot-bench/items/${built.item_token}/grade`, { connector: true, body: { verdict: 'pass', critique: 'Does what was asked and nothing else.' } });
    const q = await call('GET', '/api/bot-bench/queue', { connector: true });
    assert.equal(q.body.total, 0, 'judged items leave the queue');

    const override = await call('POST', `/api/admin/homeroom-bot/bench/trials/${built.id}/grade`, { body: { verdict: 'fail', critique: 'It breaks the mobile layout.' } });
    assert.equal(override.status, 200);
    assert.equal(override.body.grade.grader, 'human');
    const { rows: grades } = await pool.query('SELECT grader, verdict, created_at, id FROM bench_grades WHERE trial_id = $1', [built.id]);
    const { rows: [b] } = await pool.query('SELECT status, deterministic FROM bench_trials WHERE id = $1', [built.id]);
    assert.equal(graders.finalVerdict({ ...b, grades }), 'fail', 'the person\'s grade decides');
    const review = await call('GET', `/api/admin/homeroom-bot/bench/runs/${run.id}/review`);
    assert.equal(review.status, 200);
    assert.equal(review.body.items.length, 2);
    assert.deepEqual(review.body.agreement, { n: 1, agreement: 0, tpr: null, tnr: 0, positives: 0, negatives: 1 });
    const viewer = await call('POST', `/api/admin/homeroom-bot/bench/trials/${built.id}/grade`, { who: 'viewer', body: { verdict: 'pass' } });
    assert.equal(viewer.status, 403, 'a view-only admin cannot override');
  });

  await t.test('labelling a task grades its trials again; a frozen suite\'s task cannot be labelled', async () => {
    const queue = await call('GET', '/api/bot-bench/queue?kind=label', { connector: true });
    const { rows: [unl] } = await pool.query('SELECT label_token FROM bench_tasks WHERE id = $1', [unlabelled]);
    assert.ok(queue.body.items.some((i) => i.itemId === unl.label_token));
    const item = await call('GET', `/api/bot-bench/items/${unl.label_token}`, { connector: true });
    assert.equal(item.body.item.kind, 'label');
    const noVerdict = await call('POST', `/api/bot-bench/tasks/${unl.label_token}/label`, { connector: true, body: { notes: 'x' } });
    assert.equal(noVerdict.status, 400, 'a triage label needs its verdict');
    const labelled = await call('POST', `/api/bot-bench/tasks/${unl.label_token}/label`, {
      connector: true, body: { verdict: 'person', notes: 'A pricing decision.', tags: { difficulty: 'easy' } },
    });
    assert.equal(labelled.status, 200);
    const { rows: [tk] } = await pool.query('SELECT reference, reference_source, tags FROM bench_tasks WHERE id = $1', [unlabelled]);
    assert.equal(tk.reference_source, 'opus');
    assert.equal(tk.tags.difficulty, 'easy');
    const { rows: [w] } = await pool.query('SELECT deterministic FROM bench_trials WHERE id = $1', [waiting.id]);
    assert.equal(w.deterministic.pass, true, 'the waiting trial is graded against the new reference');

    await suites.freezeSuite(pool, suite.id);
    const frozen = await call('POST', `/api/bot-bench/tasks/${unl.label_token}/label`, { connector: true, body: { verdict: 'empty' } });
    assert.equal(frozen.status, 409);
  });
});
