'use strict';

// #3654: benchmark suites and tasks against the FULL PostgreSQL schema.
// Versions number themselves per name; a run becomes a task only with a
// snapshot for the stage; freezing makes every task immutable and an edit
// goes to the next version, which copies the tasks; the sampler draws only
// runs that can be replayed and are not in the suite yet; a merged pull
// request becomes a build task with the thread as it stood when the pull
// request was opened and the checks it added as hidden checks. A suite made
// by mistake can be deleted, with its tasks, unless it is frozen, has runs
// or is the default (Core) suite; the list says which rows qualify, and the
// route is a full admin's alone.
//
// Skips when no database is reachable, unless TEST_DATABASE_URL insists.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');
const { Pool } = require('pg');

const suites = require('../src/services/bench/suites');
const snapshots = require('../src/services/homeroom-bot-snapshots');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

async function freshDb(t, prefix) {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return null;
  }
  const name = `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema);
  return pool;
}

test('benchmark suites and tasks against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const pool = await freshDb(t, 'bench_suite');
  if (!pool) return;

  const { rows: [todo] } = await pool.query(
    "INSERT INTO apps (name, slug, status, repo_url) VALUES ('Todo', 'todo', 'running', 'https://github.com/o/todo') RETURNING id, slug",
  );
  const { rows: [platform] } = await pool.query(
    "INSERT INTO apps (name, slug, status, repo_url) VALUES ('Homeroom', 'homeroom', 'running', 'https://github.com/Usernode-Labs/social-vibecoding') RETURNING id, slug",
  );
  const run = async (app, issue, verdict, extra = {}) => {
    const { rows: [r] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, label_verdict, question_answers)
       VALUES ($1, $2, 'shadow', $3, $4, $5) RETURNING id`,
      [app.id, issue, verdict, extra.label || null, extra.answers ? JSON.stringify(extra.answers) : null],
    );
    if (extra.snap !== false) {
      for (const stage of extra.stages || ['triage']) {
        // eslint-disable-next-line no-await-in-loop
        await snapshots.recordSnapshot(pool, {
          runId: r.id, stage, appId: app.id, issueNumber: issue, baseSha: 'c'.repeat(40),
          texts: {
            seed: `Please work on GitHub issue #${issue}`, prompt: `prompt ${issue}`,
            thread: snapshots.frozenThread({ issueNumber: issue, issue: { title: `Issue ${issue} is broken`, body: '' } }),
          },
        });
      }
    }
    return r.id;
  };

  await t.test('versions number themselves per name; a run needs a snapshot to become a task', async () => {
    const a = await suites.createSuite(pool, { name: 'core', kind: 'frozen' });
    const b = await suites.createSuite(pool, { name: 'core' });
    assert.deepEqual([a.suite.version, b.suite.version], [1, 2]);
    assert.equal((await suites.createSuite(pool, { name: '' })).status, 400);
    assert.equal((await suites.createSuite(pool, { name: 'x', kind: 'weekly' })).status, 400);

    const old = await run(todo, 1, 'ready', { snap: false });
    const refused = await suites.addTaskFromRun(pool, { suiteId: a.suite.id, runId: old, stage: 'triage' });
    assert.equal(refused.status, 409);
    assert.match(refused.error, /no triage snapshot/);

    const r2 = await run(todo, 2, 'question', { label: 'ready' });
    const added = await suites.addTaskFromRun(pool, { suiteId: a.suite.id, runId: r2, stage: 'triage' });
    assert.equal(added.ok, true);
    assert.deepEqual(added.task.reference, { verdict: 'ready' }, 'the labeller\'s verdict, not the bot\'s');
    assert.equal(added.task.reference_source, 'human');
    assert.equal(added.task.tags.request_type, 'bug');
    assert.equal((await suites.addTaskFromRun(pool, { suiteId: a.suite.id, runId: r2, stage: 'triage' })).status, 409, 'once per stage');
    assert.equal((await suites.addTaskFromRun(pool, { suiteId: a.suite.id, runId: r2, stage: 'build' })).status, 409, 'no build snapshot');
    assert.equal((await suites.addTaskFromRun(pool, { suiteId: a.suite.id, runId: r2, stage: 'dm' })).status, 409, 'no DM answer');
  });

  await t.test('a frozen suite\'s tasks are immutable; an edit goes to the next version', async () => {
    const { suite } = await suites.createSuite(pool, { name: 'frozen-one' });
    const r = await run(todo, 3, 'ready');
    const { task } = await suites.addTaskFromRun(pool, { suiteId: suite.id, runId: r, stage: 'triage' });
    assert.equal((await suites.freezeSuite(pool, suite.id)).ok, true);
    assert.equal((await suites.freezeSuite(pool, suite.id)).status, 409);
    const r2 = await run(todo, 4, 'ready');
    assert.equal((await suites.addTaskFromRun(pool, { suiteId: suite.id, runId: r2, stage: 'triage' })).status, 409);
    assert.equal((await suites.setReference(pool, { taskId: task.id, patch: { verdict: 'question' }, source: 'opus' })).status, 409);
    assert.equal((await suites.removeTask(pool, { taskId: task.id })).status, 409);

    const next = await suites.newVersion(pool, suite.id);
    assert.equal(next.ok, true);
    assert.equal(next.suite.version, 2);
    assert.equal(next.copied, 1);
    assert.equal(next.suite.frozen_at, null);
    const tasks = await suites.listTasks(pool, next.suite.id);
    assert.equal(tasks.length, 1);
    const labelled = await suites.setReference(pool, {
      taskId: tasks[0].id, patch: { verdict: 'question', answers: ['Dark'], bogus: 1 }, tags: { difficulty: 'hard', app_slug: 'x' }, source: 'opus',
    });
    assert.equal(labelled.ok, true);
    assert.deepEqual(labelled.task.reference, { verdict: 'question', answers: ['Dark'] }, 'unknown keys dropped');
    assert.equal(labelled.task.tags.difficulty, 'hard');
    assert.equal(labelled.task.tags.app_slug, 'todo', 'only the labeller\'s tags move');
    const { rows: [orig] } = await pool.query('SELECT reference, label_token FROM bench_tasks WHERE id = $1', [task.id]);
    assert.deepEqual(orig.reference, {}, 'the frozen version is untouched');
    const { rows: [copy] } = await pool.query('SELECT label_token FROM bench_tasks WHERE id = $1', [tasks[0].id]);
    assert.notEqual(copy.label_token, orig.label_token, 'a copy has a token of its own');
    assert.equal((await suites.freezeSuite(pool, (await suites.createSuite(pool, { name: 'empty' })).suite.id)).status, 409,
      'an empty suite cannot be frozen');
  });

  await t.test('a suite is deleted with its tasks unless frozen, run or the default', async () => {
    const make = async (label, issue) => {
      const { suite } = await suites.createSuite(pool, { name: label });
      await suites.addTaskFromRun(pool, { suiteId: suite.id, runId: await run(todo, issue, 'ready'), stage: 'triage' });
      return suite;
    };
    const frozen = await make('del-frozen', 40);
    await suites.freezeSuite(pool, frozen.id);
    const ran = await make('del-ran', 41);
    await pool.query("INSERT INTO bench_runs (suite_id, models, stages) VALUES ($1, ARRAY['a/b'], ARRAY['triage'])", [ran.id]);
    const core = await make('del-core', 42);
    await pool.query("INSERT INTO bench_materializations (definition, version, suite_id, status) VALUES ('del-core', 1, $1, 'done')", [core.id]);
    const doomed = await make('del-mistake', 43);
    await suites.addTaskFromRun(pool, { suiteId: doomed.id, runId: await run(todo, 44, 'ready'), stage: 'triage' });
    const keeper = await make('del-keeper', 45);

    const listed = Object.fromEntries((await suites.listSuites(pool)).map((s) => [s.id, s]));
    assert.deepEqual([frozen, ran, core, doomed, keeper].map((s) => listed[s.id].deletable), [false, false, false, true, true]);
    assert.equal(listed[ran.id].runs, 1);
    assert.equal(listed[core.id].is_default, true);

    const tasksOf = async (id) => (await pool.query('SELECT COUNT(*)::int AS n FROM bench_tasks WHERE suite_id = $1', [id])).rows[0].n;
    const missing = await suites.deleteSuite(pool, { suiteId: 999999 });
    assert.equal(missing.status, 404);
    const refusedFrozen = await suites.deleteSuite(pool, { suiteId: frozen.id });
    assert.equal(refusedFrozen.status, 409);
    assert.match(refusedFrozen.error, /answer key past runs were graded against/);
    const refusedRan = await suites.deleteSuite(pool, { suiteId: ran.id });
    assert.equal(refusedRan.status, 409);
    assert.match(refusedRan.error, /it has runs/);
    const refusedCore = await suites.deleteSuite(pool, { suiteId: core.id });
    assert.equal(refusedCore.status, 409);
    assert.match(refusedCore.error, /default suite; make a new version instead/);
    for (const s of [frozen, ran, core]) {
      // eslint-disable-next-line no-await-in-loop
      assert.ok(await suites.suiteRow(pool, s.id), `${s.name} is kept`);
      // eslint-disable-next-line no-await-in-loop
      assert.equal(await tasksOf(s.id), 1, `${s.name}'s task is kept`);
    }

    const out = await suites.deleteSuite(pool, { suiteId: doomed.id, actorId: null });
    assert.deepEqual(out, { ok: true, deleted: { suiteId: doomed.id, tasks: 2 } });
    assert.equal(await suites.suiteRow(pool, doomed.id), null);
    assert.equal(await tasksOf(doomed.id), 0);
    assert.equal(await tasksOf(keeper.id), 1, 'another suite is untouched');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM bench_runs WHERE suite_id = $1', [ran.id])).rows[0].n, 1);
    assert.equal((await suites.deleteSuite(pool, { suiteId: doomed.id })).status, 404);
  });

  await t.test('the sampler draws replayable runs not in the suite yet; DM tasks need an answered DM', async () => {
    const { suite } = await suites.createSuite(pool, { name: 'sampled' });
    const ids = [];
    for (let i = 10; i < 16; i += 1) ids.push(await run(todo, i, i % 2 ? 'question' : 'ready'));
    await run(platform, 20, 'ready');
    await run(todo, 21, 'ready', { snap: false });
    const first = await suites.proposeSample(pool, { suiteId: suite.id, stage: 'triage', n: 4, seed: 2 });
    assert.equal(first.ok, true);
    assert.ok(first.available >= 7);
    assert.equal(first.picked.length, 4);
    assert.ok(!first.picked.some((c) => c.issueNumber === 21), 'a run with no snapshot is never offered');
    await suites.addTaskFromRun(pool, { suiteId: suite.id, runId: first.picked[0].id, stage: 'triage' });
    const second = await suites.proposeSample(pool, { suiteId: suite.id, stage: 'triage', n: 50, seed: 2 });
    assert.ok(!second.picked.some((c) => c.issueNumber === first.picked[0].issueNumber), 'an issue in the suite is not offered again');

    // A question answered in the requester's DM is a DM candidate.
    const { rows: [user] } = await pool.query("INSERT INTO users (username, password) VALUES ('req', 'x') RETURNING id");
    const { rows: [bot] } = await pool.query("INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id");
    const { rows: [conv] } = await pool.query("INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id", [bot.id]);
    const asked = await run(todo, 30, 'question', { answers: ['Blue', 'Green'] });
    const { rows: [q] } = await pool.query(
      "INSERT INTO conversation_messages (conversation_id, sender_id, content) VALUES ($1, $2, 'Which colour?') RETURNING id", [conv.id, bot.id],
    );
    const { rows: [a] } = await pool.query(
      "INSERT INTO conversation_messages (conversation_id, sender_id, content) VALUES ($1, $2, 'A dark blue please') RETURNING id", [conv.id, user.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind, run_id,
                                             question_status, answer_message_id, answered_at)
       VALUES ($1, $2, $3, $4, 30, 'question', $5, 'answered', $6, NOW())`,
      [q.id, user.id, conv.id, todo.id, asked, a.id],
    );
    const dm = await suites.proposeSample(pool, { suiteId: suite.id, stage: 'dm', n: 5 });
    assert.deepEqual(dm.picked.map((c) => c.issueNumber), [30]);
    const added = await suites.addTaskFromRun(pool, { suiteId: suite.id, runId: asked, stage: 'dm' });
    assert.equal(added.ok, true);
    assert.equal(added.task.reference.dm_script.true_answer, 'A dark blue please');
  });

  await t.test('a merged pull request becomes a build task: thread as of the PR, hidden checks added by it', async () => {
    const { suite } = await suites.createSuite(pool, { name: 'imports' });
    const base = 'b'.repeat(40);
    const merge = 'e'.repeat(40);
    const github = {
      isEnabled: () => true,
      getBotUsername: async () => 'usernode-bot',
      async getPR(_o, _r, n) {
        return n === 3630
          ? { number: 3630, title: 'Add dark mode', merged_at: '2026-10-01T12:00:00Z', created_at: '2026-10-01T10:00:00Z', merge_commit_sha: merge, base: { sha: base } }
          : { number: n, merged_at: null };
      },
      async fetchPublicIssue(_o, _r, n) { return { issue: { number: n, title: 'Dark mode', body: 'Please add one.', state: 'closed' } }; },
      async fetchIssueComments() {
        return { comments: [
          { author: 'ann', body: 'Like the platform.', createdAt: '2026-10-01T09:00:00Z' },
          { author: 'bob', body: 'Merged in #3630, thanks!', createdAt: '2026-10-01T13:00:00Z' },
        ] };
      },
      async getFileContent(_o, _r, _p, ref) {
        const tests = [{ name: 'home', path: '/' }];
        if (ref === merge) tests.push({ name: 'dark', path: '/?theme=dark', expectSelector: '.dark' });
        return JSON.stringify({ tests });
      },
      async listChangedFiles() { return ['public/app.css', 'dapp.json']; },
    };
    const notMerged = await suites.importTaskFromPr(pool, { suiteId: suite.id, appSlug: 'homeroom', issueNumber: 3600, prNumber: 1, deps: { github } });
    assert.equal(notMerged.status, 409);
    const out = await suites.importTaskFromPr(pool, {
      suiteId: suite.id, appSlug: 'homeroom', issueNumber: 3600, prNumber: 3630,
      deps: { github, threadContext: { async loadIssueThread() { return { messages: [] }; } } },
    });
    assert.equal(out.ok, true);
    assert.equal(out.hiddenChecks, 1);
    assert.equal(out.task.reference_source, 'merged_pr');
    assert.deepEqual(out.task.reference.hidden_checks, [{ name: 'dark', path: '/?theme=dark', expectSelector: '.dark' }]);
    assert.equal(out.task.reference.base_sha, base);
    assert.equal(out.task.tags.repo_size, 'large');
    const { rows: [task] } = await pool.query('SELECT snapshot_id FROM bench_tasks WHERE id = $1', [out.task.id]);
    const snap = await snapshots.readSnapshot(pool, task.snapshot_id);
    assert.equal(snap.source, 'import');
    assert.equal(snap.baseSha, base);
    assert.match(snap.texts.seed, /Like the platform\./);
    assert.doesNotMatch(snap.texts.seed, /Merged in #3630/, 'a comment after the PR opened would give the answer away');
  });
});

test('DELETE /bench/suites/:id is a full admin\'s alone', { timeout: 60000 }, async (t) => {
  const pool = await freshDb(t, 'bench_suite_route');
  if (!pool) return;
  const poolMod = require('../src/db/pool');
  const realGetPool = poolMod.getPool;
  poolMod.getPool = () => pool;
  t.after(() => { poolMod.getPool = realGetPool; });
  const { homeroomBenchRoutes } = require('../src/routes/homeroom-bench');
  const appX = express();
  appX.use(express.json());
  appX.use((req, _res, next) => {
    const who = req.headers['x-test-user'];
    if (who === 'admin') req.user = { id: null, username: 'evan', isAdmin: true, canAdminWrite: true };
    if (who === 'viewer') req.user = { id: null, username: 'viewer', isAdmin: true, canAdminWrite: false };
    if (who === 'member') req.user = { id: null, username: 'ann', isAdmin: false, canAdminWrite: false };
    next();
  });
  appX.use(homeroomBenchRoutes({}));
  const server = http.createServer(appX);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const del = async (id, who) => {
    const res = await fetch(`${base}/api/admin/homeroom-bot/bench/suites/${id}`, { method: 'DELETE', redirect: 'manual', headers: { 'x-test-user': who } });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const { suite } = await suites.createSuite(pool, { name: 'mistake' });
  // A non-admin is turned away by adminMiddleware (a redirect home, as the
  // router mounts it under the prefix); a view-only admin by requireAdminWrite.
  for (const who of ['member', 'nobody']) {
    // eslint-disable-next-line no-await-in-loop
    assert.ok([302, 403].includes((await del(suite.id, who)).status), who);
  }
  const viewer = await del(suite.id, 'viewer');
  assert.equal(viewer.status, 403);
  assert.equal(viewer.body.error, 'Full admin access required');
  assert.ok(await suites.suiteRow(pool, suite.id), 'a refused delete deletes nothing');
  assert.equal((await del('x', 'admin')).status, 400);
  const ok = await del(suite.id, 'admin');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true, deleted: { suiteId: suite.id, tasks: 0 } });
  const gone = await del(suite.id, 'admin');
  assert.equal(gone.status, 404);
  assert.equal(gone.body.error, 'Suite not found');
  const { suite: frozen } = await suites.createSuite(pool, { name: 'kept' });
  await pool.query('UPDATE bench_suites SET frozen_at = NOW() WHERE id = $1', [frozen.id]);
  const refused = await del(frozen.id, 'admin');
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /frozen/);
});
