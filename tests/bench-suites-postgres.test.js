'use strict';

// #3654: benchmark suites and tasks against the FULL PostgreSQL schema.
// Versions number themselves per name; a run becomes a task only with a
// snapshot for the stage; freezing makes every task immutable and an edit
// goes to the next version, which copies the tasks; the sampler draws only
// runs that can be replayed and are not in the suite yet; a merged pull
// request becomes a build task with the thread as it stood when the pull
// request was opened and the checks it added as hidden checks.
//
// Skips when no database is reachable, unless TEST_DATABASE_URL insists.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
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
