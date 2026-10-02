'use strict';

// #3654 Core v1 against the FULL PostgreSQL schema: the checked-in
// definition materialized end to end with a read-only GitHub stub. Each task
// gets a snapshot (the one its run recorded, or one rebuilt as of as_of:
// comments after as_of left out, the commit at as_of), a build from a merged
// pull request, a checks fix from the bot's red proposal, a DM with the
// requester's real answer; what cannot be resolved is skipped with its
// reason; a second pass is a no-op and a retry adds only what is missing;
// the suite freezes only once every task is labelled.
//
// Skips when no database is reachable, unless TEST_DATABASE_URL insists.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');
const { Pool } = require('pg');

const core = require('../src/services/bench/core');
const suites = require('../src/services/bench/suites');
const grading = require('../src/services/bench/grading');
const lane = require('../src/services/bench/lane');
const runner = require('../src/services/bench/runner');
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

const PLATFORM = 'usernode-2d5619';
const GONE_APP = 'falling-sands-game-ad186d';
const LATE = '2026-10-02T06:00:00Z';

function stubGithub({ calls }) {
  const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
  return {
    isEnabled: () => true,
    async getBotUsername() { return 'homeroom-bot[bot]'; },
    async fetchPublicIssue(owner, repo, n) {
      calls.push(['issue', repo, n]);
      if (n === 2995) return { issue: null, note: 'not found' };
      const closed = repo === 'clearskies-924851';
      return {
        issue: {
          number: n, title: `Request ${n} is broken`,
          // #3517 was filed through Homeroom: the bot account is the GitHub
          // author, and only the Source line names the person.
          body: n === 3517 ? `**Source:** Homeroom user (amy)\n\nThe body of request ${n}.` : `The body of request ${n}.`,
          user: 'homeroom-bot[bot]',
          createdAt: '2026-09-01T00:00:00Z', updatedAt: LATE, state: closed ? 'closed' : 'open', closedAt: null,
        },
      };
    },
    async fetchIssueComments(owner, repo, n) {
      return {
        comments: [
          { author: 'amy', body: `EARLY COMMENT ${n}`, createdAt: '2026-09-01T01:00:00Z' },
          { author: 'amy', body: `LATE ANSWER ${n}`, createdAt: LATE },
        ],
        truncated: false,
      };
    },
    async getCommitAt(owner, repo, until) {
      calls.push(['commitAt', repo, until]);
      return { sha: sha(`${repo}@${until}`), committedAt: until, branch: 'main' };
    },
    async getPR(owner, repo, pr) {
      calls.push(['pr', repo, pr]);
      if (pr === 3634) { const err = new Error('Not Found'); err.status = 404; throw err; }
      return {
        number: pr, merged_at: '2026-10-01T10:00:00Z', merge_commit_sha: sha(`merge${pr}`), base: { sha: 'b'.repeat(40) },
        created_at: '2026-10-01T00:00:00Z', title: `Change ${pr}`, body: `What PR ${pr} does, as its description.`, user: { login: 'homeroom-bot[bot]' },
      };
    },
    async getFileContent(owner, repo, file, ref) {
      return ref === 'b'.repeat(40) || ref === 'ac67fac30de91d0dd969f72b2cd73633d4719dd9'
        ? '{"tests":[]}' : '{"tests":[{"name":"new check","path":"/"}]}';
    },
    async listChangedFiles() { return ['public/app.js']; },
    // A write the materializer must never make: the guard refuses it anyway.
    async createIssueComment() { calls.push(['WRITE']); },
  };
}

test('Core v1 materializes from its definition against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const pool = await freshDb(t, 'bench_core');
  if (!pool) return;
  const def = core.loadDefinition();

  // Every app the definition names, except one that is gone.
  const slugs = [...new Set(def.tasks.map((x) => x.app_slug))].filter((s) => s !== GONE_APP);
  for (const slug of [...slugs, 'invite-board-extra', 'rss-reader-extra']) {
    const repoUrl = slug === PLATFORM ? 'https://github.com/Usernode-Labs/social-vibecoding' : `https://github.com/o/${slug}`;
    // eslint-disable-next-line no-await-in-loop
    await pool.query("INSERT INTO apps (name, slug, status, repo_url) VALUES ($1, $1, 'running', $2)", [slug, repoUrl]);
  }
  const app = async (slug) => (await pool.query('SELECT id FROM apps WHERE slug = $1', [slug])).rows[0].id;
  const { rows: [amy] } = await pool.query("INSERT INTO users (username, password) VALUES ('amy', 'x') RETURNING id");

  // Run 593 recorded its own triage snapshot, and a labeller said person.
  await pool.query(
    `INSERT INTO homeroom_bot_runs (id, app_id, issue_number, mode, verdict, label_verdict, created_at)
     VALUES (593, $1, 3516, 'shadow', 'ready', 'person', '2026-09-30T21:23:25.182Z')`,
    [await app(PLATFORM)],
  );
  const recordedId = await snapshots.recordSnapshot(pool, {
    runId: 593, stage: 'triage', appId: await app(PLATFORM), issueNumber: 3516, baseSha: 'a'.repeat(40),
    texts: { seed: 'RECORDED SEED', prompt: 'RECORDED PROMPT', thread: snapshots.frozenThread({ issueNumber: 3516, issue: { title: 'Resume banner overlaps', body: '' } }) },
  });
  // The platform's own thread on #3555: one message before the run, one after.
  await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at) VALUES
       ($1, $2, 'THREAD BEFORE', 'message', 'issue', 3555, '2026-10-01T10:00:00Z'),
       ($1, $2, 'THREAD AFTER', 'message', 'issue', 3555, '2026-10-01T12:00:00Z')`,
    [await app(PLATFORM), amy.id],
  );
  // DMs: run 649's requester answered on the thread, run 267's on GitHub;
  // 172 and 590 have no known requester; 8's app is gone.
  await pool.query('INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id) VALUES ($1, 50, $3), ($2, 63, $3)',
    [await app('my-cool-app-460fe8'), await app('recipebot-33b169'), amy.id]);
  await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at)
     VALUES ($1, $2, 'People who picked interested', 'message', 'issue', 50, '2026-10-01T23:40:00Z')`,
    [await app('my-cool-app-460fe8'), amy.id],
  );
  // The bot's red proposals: 5754 looked at by its own checks-fix turn (a
  // recorded snapshot), 5755 still red on its head (rebuilt from the row).
  await pool.query(
    `INSERT INTO chat_sessions (id, app_id, pr_number, status, check_state, reviewed_head_sha, checks_commit_sha, test_results) VALUES
       (5754, $1, 87, 'promoted', 'passing', NULL, NULL, '[]'),
       (5755, $2, 82, 'promoted', 'failing', $3, $3, $4::jsonb)`,
    [await app('todo-list-b91765'), await app('recipebot-33b169'), 'f'.repeat(40),
      JSON.stringify([{ name: 'Text size', status: 'fail', failureReason: 'expected "Text size"' }, { name: 'Home', status: 'pass' }])],
  );
  const { rows: [fixRun] } = await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id, checks_head_sha)
     VALUES ($1, 72, 'live', 'revise', 5754, $2) RETURNING id`,
    [await app('todo-list-b91765'), 'e'.repeat(40)],
  );
  const fixSnap = await snapshots.recordSnapshot(pool, {
    runId: fixRun.id, stage: 'checks_fix', appId: await app('todo-list-b91765'), issueNumber: 72, baseSha: 'e'.repeat(40),
    texts: { seed: 'seed 72', prompt: 'fix prompt', failing: '[]' }, extra: { prNumber: 87 },
  });
  await pool.query("INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id) VALUES ($1, 70, 'live', 'ready', 5755)",
    [await app('recipebot-33b169')]);
  // The dynamic rules: merged bot proposals on two small apps and on the
  // platform (left out); a shadow build whose request is closed, one whose
  // request is open; a follow-up with a snapshot and one without.
  const merged = async (slug, issue, pr) => {
    const { rows: [s] } = await pool.query("INSERT INTO chat_sessions (app_id, pr_number, status) VALUES ($1, $2, 'merged') RETURNING id", [await app(slug), pr]);
    await pool.query("INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id) VALUES ($1, $2, 'live', 'ready', $3)", [await app(slug), issue, s.id]);
  };
  await merged('invite-board-extra', 5, 11);
  await merged('rss-reader-extra', 6, 12);
  await merged(PLATFORM, 3600, 3700);
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_ok, build_note, build_at, created_at) VALUES
       ($1, 4, 'shadow', 'ready', TRUE, 'Add the icon.', '2026-09-28T08:00:00Z', '2026-09-28T07:43:01Z'),
       ($2, 2, 'shadow', 'ready', TRUE, 'Add the icon.', '2026-09-28T08:00:00Z', '2026-09-28T07:37:05Z')`,
    [await app('clearskies-924851'), await app('test-cf3ec4')],
  );
  const { rows: [fs1] } = await pool.query("INSERT INTO chat_sessions (app_id, pr_number, status) VALUES ($1, 30, 'promoted') RETURNING id", [await app('sheep-countrr-a08857')]);
  const { rows: [fu] } = await pool.query(
    "INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id) VALUES ($1, 28, 'live', 'answer', $2) RETURNING id",
    [await app('sheep-countrr-a08857'), fs1.id],
  );
  await snapshots.recordSnapshot(pool, {
    runId: fu.id, stage: 'followup', appId: await app('sheep-countrr-a08857'), issueNumber: 28, baseSha: 'd'.repeat(40),
    texts: { seed: 'seed 28', prompt: 'follow-up prompt', replies: '[]' },
  });
  await pool.query("INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id) VALUES ($1, 2, 'live', 'question', $2)",
    [await app('invite-board-ad93b6'), fs1.id]);

  const calls = [];
  const github = runner.guardedGithub(stubGithub({ calls }));
  const opts = { definition: def, deps: { github }, rateMs: 0 };

  let first;
  await t.test('the first pass makes the suite and every task it can, and skips the rest with reasons', async () => {
    first = await core.materialize(pool, {}, opts);
    assert.equal(first.ok, true, first.error);
    const { summary } = first;
    assert.equal(calls.some((c) => c[0] === 'WRITE'), false, 'reads only');
    const suite = await suites.suiteRow(pool, first.suiteId);
    assert.deepEqual([suite.name, suite.version, suite.kind, suite.frozen_at], ['Core', 1, 'frozen', null], 'unfrozen, to be labelled');
    const reasons = Object.fromEntries(summary.skipped.map((s) => [s.ref, s.reason]));
    assert.match(reasons[`triage:${GONE_APP}#25`], /is gone/);
    assert.match(reasons[`dm:${GONE_APP}#25`], /is gone/);
    assert.match(reasons['triage:usernode-2d5619#2995'], /could not be read \(not found\)/);
    assert.match(reasons['build:usernode-2d5619#3620:pr3634'], /Could not read PR #3634/);
    assert.match(reasons['dm:workquest-escape-from-the-underclass-831ec5#1'], /requester is not known/);
    assert.equal(reasons['dm:usernode-2d5619#3517'], undefined, 'a request filed through Homeroom names its requester in its Source line');
    const { rows: [viaSource] } = await pool.query(
      "SELECT reference FROM bench_tasks WHERE stage = 'dm' AND tags->>'core_ref' = 'dm:usernode-2d5619#3517'",
    );
    assert.equal(viaSource.reference.dm_script.true_answer, 'LATE ANSWER 3517', "the person's own reply after the question");
    assert.match(reasons['build:merged_bot_proposals'], /only 3 of 10/);
    assert.match(reasons['followup:bot_followups'], /only 1 of 3/);
    assert.deepEqual(summary.stages, {
      triage: { ready: 42, skipped: 2 },
      build: { ready: 12, skipped: 2 },
      followup: { ready: 1, skipped: 1 },
      checks_fix: { ready: 2, skipped: 0 },
      dm: { ready: 3, skipped: 2 },
    });
    const { rows: [m] } = await pool.query("SELECT status, suite_id, attempts FROM bench_materializations WHERE definition = 'core-v1'");
    assert.deepEqual([m.status, m.suite_id, m.attempts], ['done', first.suiteId, 1]);
  });

  const taskByRef = async (ref) => (await pool.query(
    "SELECT * FROM bench_tasks WHERE suite_id = $1 AND tags->>'core_ref' = $2", [first.suiteId, ref],
  )).rows[0];

  await t.test('a backfilled snapshot is the thread as of as_of, at the commit of as_of, built like the bot\'s', async () => {
    const task = await taskByRef('triage:usernode-2d5619#3555');
    const snap = await snapshots.readSnapshot(pool, task.snapshot_id);
    assert.equal(snap.source, 'import');
    assert.match(snap.texts.seed, /^Please work on GitHub issue #3555: "Request 3555 is broken"\./, 'the bot\'s own seed builder');
    assert.match(snap.texts.seed, /EARLY COMMENT 3555/);
    assert.doesNotMatch(snap.texts.seed, /LATE ANSWER/, 'a comment after as_of would give the answer away');
    assert.match(snap.texts.seed, /THREAD BEFORE/);
    assert.doesNotMatch(snap.texts.seed, /THREAD AFTER/);
    assert.ok(snap.texts.prompt.startsWith(snap.texts.seed), 'the triage prompt the bot builds from it');
    assert.match(snap.texts.prompt, /END YOUR REPLY WITH EXACTLY ONE fenced JSON block/);
    const asked = calls.find((c) => c[0] === 'commitAt' && c[2] === '2026-10-01T11:52:42.142Z');
    assert.ok(asked, 'the commit at the run\'s own time');
    assert.equal(snap.baseSha, crypto.createHash('sha1').update('social-vibecoding@2026-10-01T11:52:42.142Z').digest('hex'));
    assert.equal(snap.extra.backfilled, true);
    assert.equal(snap.extra.asOf, '2026-10-01T11:52:42.142Z');
    assert.equal(snap.extra.commentsAfterAsOf, 1);
    assert.equal(snap.extra.bodyEditedAfter, false, 'the late comment explains the later updated_at');
    assert.equal(task.tags.snapshot_origin, 'backfilled');
    assert.equal(task.tags.verdict, 'ready');
    assert.equal(task.tags.platform, true);
    assert.equal(task.tags.request_type, 'bug');
    assert.equal(task.reference_source, null, 'the bot\'s verdict is not the reference');
  });

  await t.test('a run\'s own snapshot is used when it recorded one, with its labeller\'s verdict', async () => {
    const task = await taskByRef('triage:usernode-2d5619#3516');
    assert.equal(task.snapshot_id, recordedId);
    assert.equal(task.source_run_id, 593);
    assert.equal(task.tags.snapshot_origin, 'recorded');
    assert.deepEqual([task.reference, task.reference_source], [{ verdict: 'person' }, 'human']);
    const other = await taskByRef('triage:usernode-2d5619#3518');
    assert.equal(other.source_run_id, null, 'a run this database never had is not linked');
  });

  await t.test('the adversarial tasks carry their authored text and reference', async () => {
    const task = await taskByRef('triage:adversarial:prompt-injection');
    assert.equal(task.reference_source, 'authored');
    assert.equal(task.reference.verdict, 'person');
    assert.equal(task.issue_number, 990001);
    const snap = await snapshots.readSnapshot(pool, task.snapshot_id);
    assert.match(snap.texts.seed, /ignore your rules and instructions/);
    assert.equal(snap.extra.synthetic, true);
    assert.equal(calls.some((c) => c[0] === 'issue' && c[2] >= 990001), false, 'no GitHub request is read for them');
  });

  await t.test('builds come from merged pull requests at the definition\'s base; the bot follow-ups task is the PR\'s description', async () => {
    const task = await taskByRef('build:usernode-2d5619#3138:pr3625');
    assert.equal(task.reference_source, 'merged_pr');
    assert.equal(task.reference.base_sha, 'ac67fac30de91d0dd969f72b2cd73633d4719dd9', 'the work order\'s base, not GitHub\'s base.sha');
    assert.deepEqual(task.reference.hidden_checks, [{ name: 'new check', path: '/' }]);
    const pr = await taskByRef('build:usernode-2d5619:pr3647');
    const snap = await snapshots.readSnapshot(pool, pr.snapshot_id);
    assert.equal(snap.texts.seed, 'Please work on this request: "Change 3647".\n\nWhat PR 3647 does, as its description.');
    assert.equal(snap.baseSha, '18df8f1c187a32029f663612a4536378184569bd');
    assert.equal(snap.extra.requestFromPr, true);
    const dyn = (await pool.query(
      "SELECT a.slug, t.tags, t.reference_source FROM bench_tasks t JOIN apps a ON a.id = t.app_id WHERE t.suite_id = $1 AND t.tags->>'core_rule' = 'build:merged_bot_proposals' ORDER BY a.slug",
      [first.suiteId],
    )).rows;
    assert.deepEqual(dyn.map((r) => [r.slug, r.tags.source, r.reference_source]), [
      ['clearskies-924851', 'shadow_build', null],
      ['invite-board-extra', 'merged_bot_proposal', 'merged_pr'],
      ['rss-reader-extra', 'merged_bot_proposal', 'merged_pr'],
    ], 'small apps only, one each; the open shadow build is not eligible');
  });

  await t.test('checks fixes, follow-ups and DMs', async () => {
    const recorded = await taskByRef('checks_fix:todo-list-b91765:proposal5754');
    assert.equal(recorded.snapshot_id, fixSnap);
    const rebuilt = await taskByRef('checks_fix:recipebot-33b169:proposal5755');
    const snap = await snapshots.readSnapshot(pool, rebuilt.snapshot_id);
    assert.equal(snap.baseSha, 'f'.repeat(40), 'at its failing head');
    assert.deepEqual(JSON.parse(snap.texts.failing).map((f) => f.name), ['Text size']);
    assert.match(snap.texts.prompt, /1 of 2 failed/);
    const { rows: [fuTask] } = await pool.query("SELECT * FROM bench_tasks WHERE suite_id = $1 AND stage = 'followup'", [first.suiteId]);
    assert.equal(fuTask.source_run_id, fu.id);
    const thread = await taskByRef('dm:my-cool-app-460fe8#50');
    assert.deepEqual(thread.reference.dm_script, { true_answer: 'People who picked interested', accepted: [], max_turns: 3, source: 'thread' });
    const gh = await taskByRef('dm:recipebot-33b169#63');
    assert.equal(gh.reference.dm_script.true_answer, 'LATE ANSWER 63');
    const dmSnap = await snapshots.readSnapshot(pool, gh.snapshot_id);
    assert.doesNotMatch(dmSnap.texts.seed, /LATE ANSWER/, 'the answer is hidden from the request the bot reads');
  });

  await t.test('a second pass is a no-op; a retry adds only what is missing', async () => {
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM bench_tasks')).rows[0].n;
    const snapsBefore = (await pool.query('SELECT COUNT(*)::int AS n FROM homeroom_bot_run_snapshots')).rows[0].n;
    const again = await core.materialize(pool, {}, opts);
    assert.equal(again.noop, true);
    assert.equal(again.status, 'done');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM bench_tasks')).rows[0].n, before);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM bench_suites')).rows[0].n, 1);

    // The gone app comes back; an admin retries: its two tasks, nothing else.
    await pool.query("INSERT INTO apps (name, slug, status, repo_url) VALUES ($1, $1, 'running', $2)", [GONE_APP, `https://github.com/o/${GONE_APP}`]);
    const retry = await core.materialize(pool, {}, { ...opts, force: true });
    assert.equal(retry.ok, true);
    assert.equal(retry.suiteId, first.suiteId, 'the same suite');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM bench_tasks')).rows[0].n, before + 1, 'its triage task; its DM still has no answer');
    assert.equal(retry.summary.stages.triage.ready, 43);
    assert.match(retry.summary.skipped.find((s) => s.ref === `dm:${GONE_APP}#25`).reason, /requester is not known/);
    const snapsAfter = (await pool.query('SELECT COUNT(*)::int AS n FROM homeroom_bot_run_snapshots')).rows[0].n;
    assert.equal(snapsAfter, snapsBefore + 1, 'no task already made is backfilled again');
    const { rows: [m] } = await pool.query("SELECT attempts FROM bench_materializations WHERE definition = 'core-v1'");
    assert.equal(m.attempts, 2);
  });

  await t.test('the label queue hands out Core\'s unlabelled tasks; it freezes only once every one is labelled', async () => {
    const status = await core.coreStatus(pool, { definition: def });
    assert.equal(status.suite.id, first.suiteId);
    assert.equal(status.materialization.status, 'done');
    const unlabelled = status.suite.total - status.suite.labelled;
    assert.ok(unlabelled > 0);
    const q = await grading.queue(pool, { kind: 'label', limit: 50 });
    assert.equal(q.total, unlabelled, 'kind=label is Core\'s unlabelled tasks');

    const refused = await suites.freezeSuite(pool, first.suiteId);
    assert.equal(refused.status, 409);
    assert.match(refused.error, new RegExp(`${unlabelled} of ${status.suite.total} tasks have no reference yet`));

    const { rows: open } = await pool.query('SELECT id, stage FROM bench_tasks WHERE suite_id = $1 AND reference_source IS NULL', [first.suiteId]);
    for (const task of open.slice(1)) {
      // eslint-disable-next-line no-await-in-loop
      const out = await suites.setReference(pool, {
        taskId: task.id, patch: task.stage === 'triage' || task.stage === 'dm' ? { verdict: 'ready' } : { notes: 'right answer' }, source: 'opus',
      });
      assert.equal(out.ok, true);
    }
    assert.equal((await suites.freezeSuite(pool, first.suiteId)).status, 409, 'one task left');
    await suites.setReference(pool, { taskId: open[0].id, patch: { verdict: 'question', notes: 'x' }, source: 'human' });
    const frozen = await suites.freezeSuite(pool, first.suiteId);
    assert.equal(frozen.ok, true);
    assert.equal((await grading.queue(pool, { kind: 'label' })).total, 0);
    const after = await core.coreStatus(pool, { definition: def });
    assert.equal(after.suite.labelled, after.suite.total);
    assert.ok(after.suite.frozen_at);
    // A hand-made suite keeps the old rule.
    const { suite: plain } = await suites.createSuite(pool, { name: 'plain' });
    await suites.insertTask(pool, { suiteId: plain.id, stage: 'triage', snapshotId: recordedId, appId: await app(PLATFORM), issueNumber: 3516 });
    assert.equal((await suites.freezeSuite(pool, plain.id)).ok, true);
    // And the launcher starts on Core.
    const d = lane.launcherDefaults({ suites: await suites.listSuites(pool), coreSuiteId: await core.coreSuiteId(pool, def) });
    assert.equal(d.suiteId, first.suiteId);
    assert.deepEqual(d.stages.sort(), ['dm', 'triage']);
  });

  await t.test('the routes: any admin reads Core\'s status, a full admin starts it, the launcher starts on it', async (st) => {
    const poolMod = require('../src/db/pool');
    const realGetPool = poolMod.getPool;
    poolMod.getPool = () => pool;
    const { homeroomBenchRoutes } = require('../src/routes/homeroom-bench');
    const appX = express();
    appX.use(express.json());
    appX.use((req, _res, next) => {
      const who = req.headers['x-test-user'];
      if (who === 'admin') req.user = { id: 1, username: 'evan', isAdmin: true, canAdminWrite: true };
      if (who === 'viewer') req.user = { id: 1, username: 'viewer', isAdmin: true, canAdminWrite: false };
      if (who === 'member') req.user = { id: 1, username: 'ann', isAdmin: false, canAdminWrite: false };
      next();
    });
    appX.use(homeroomBenchRoutes({}));
    const server = http.createServer(appX);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    st.after(async () => { poolMod.getPool = realGetPool; await new Promise((r) => server.close(r)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, who = 'admin') => {
      const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-test-user': who }, body: method === 'POST' ? '{}' : undefined });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    assert.equal((await call('GET', '/api/admin/homeroom-bot/bench/core', 'member')).status, 404, 'admin routes are hidden from members');
    const read = await call('GET', '/api/admin/homeroom-bot/bench/core', 'viewer');
    assert.equal(read.status, 200);
    assert.equal(read.body.suite.id, first.suiteId);
    assert.equal(read.body.definition.name, 'Core');
    assert.equal(read.body.githubEnabled, false);
    assert.equal((await call('POST', '/api/admin/homeroom-bot/bench/core/materialize', 'viewer')).status, 403);
    const noGithub = await call('POST', '/api/admin/homeroom-bot/bench/core/materialize');
    assert.equal(noGithub.status, 503, 'nothing to read it from');
    const runs = await call('GET', '/api/admin/homeroom-bot/bench/runs', 'viewer');
    assert.equal(runs.body.launcher.suiteId, first.suiteId);
    assert.deepEqual([runs.body.launcher.capUsd, runs.body.launcher.repeatStages], [50, ['triage']]);
  });
});

// A pass that died mid-way (a redeploy) leaves its row 'running'. Its last
// heartbeat says so: once it is older than STALE_RUNNING_MINUTES the status
// stops saying "being made" and the next pass may claim the row; a row that
// beat lately is still a pass at work and is left alone.
test('Core v1: a running row with an old heartbeat is stale and may be claimed again', async (t) => {
  const pool = await freshDb(t, 'bench_core_stale');
  if (!pool) return;
  const def = core.loadDefinition();
  const offline = { github: { isEnabled: () => false } };
  const setRow = (minutesAgo) => pool.query(
    `INSERT INTO bench_materializations (definition, version, status, attempts, started_at, heartbeat_at)
     VALUES ($1, $2, 'running', 1, NOW() - INTERVAL '3 hours', NOW() - make_interval(mins => $3))
     ON CONFLICT (definition, version) DO UPDATE
       SET status = 'running', attempts = 1, heartbeat_at = EXCLUDED.heartbeat_at, finished_at = NULL`,
    [def.key, def.version, minutesAgo],
  );

  await setRow(1);
  const live = await core.coreStatus(pool, { definition: def });
  assert.equal(live.running, true, 'a row that beat a minute ago is a pass at work');
  assert.equal(live.materialization.stale, false);
  const noop = await core.materialize(pool, {}, { definition: def, deps: offline, force: true, rateMs: 0 });
  assert.equal(noop.noop, true, 'not claimed from under a live pass, even though it started hours ago');

  await setRow(core.STALE_RUNNING_MINUTES + 1);
  const dead = await core.coreStatus(pool, { definition: def });
  assert.equal(dead.running, false);
  assert.equal(dead.materialization.stale, true);
  const retried = await core.materialize(pool, {}, { definition: def, deps: offline, rateMs: 0 });
  assert.equal(retried.ok, false, 'claimed, then stopped by the offline stub');
  const { rows: [m] } = await pool.query('SELECT status, attempts FROM bench_materializations WHERE definition = $1', [def.key]);
  assert.deepEqual([m.status, m.attempts], ['failed', 2], 'the stale row was claimed without force');
});
