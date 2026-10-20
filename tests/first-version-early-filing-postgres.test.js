'use strict';

// Newcomer run nine (15 Oct 2026): from the made screen's Submit to the first
// version's spec took 40 s, 18 of them waiting for the starter app to be
// built, deployed and answering before its request was filed, though the
// request needs only the repository. A first version is filed by its
// project's making once its setup has made the repository with the starter
// and its card (src/workflow/app-creation/, app.firstRequest:
// homeroom-bot-dm.js fileFirstRequest), while the project is still being
// set up; the bot's refresh takes such a project in (homeroom-bot.js
// listApps), and its read is started first (firstVersionsToRead). Against
// the real schema, routes and DM:
//
//   - filed once: a try that stopped after GitHub made the issue finds its
//     own by the marker in its body, and never files a second;
//   - the maker's answers before it is filed go ahead the moment the bot
//     reads it, and a Submit after it goes ahead with the plan waiting;
//   - creation failing after the go-ahead stops the build before it starts,
//     with the words a build that could not start always had, and nothing of
//     it running.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/first-version-early-filing-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
// The made screen's Submit (frontend/src/features/first-session/made.tsx
// answersUrl), the maker's alone.
const answersUrl = (slug) => `/api/apps/${encodeURIComponent(slug)}/first-version/answers`;

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Realtime and push are process-wide singletons (the bot's DM sends through
// them), and the apps router's infrastructure is not what this is about.
stub(require.resolve('../src/services/ws'), new Proxy({
  pushConversationEvent: () => 1, pushToUser: () => 1, pushNotificationToUser: () => 1,
  sendSystemMessage: async () => ({ id: 1 }), pushIssueUpdate() {},
}, { get: (target, key) => (key in target ? target[key] : (key === 'then' ? undefined : () => 1)) }));
stub(require.resolve('../src/services/mobile-push'), { scheduleBadgeSync() { return false; } });
stub(require.resolve('../src/services/app-creator'), { createApp: async () => {} });
stub(require.resolve('../src/services/app-forker'), { forkApp: async () => {} });
stub(require.resolve('../src/services/caddy'), { productionHostname: (slug) => `${slug}.example.test`, USERNODE_DOMAIN: 'example.test' });
stub(require.resolve('../src/services/docker'), { getHostPort: async () => null });
stub(require.resolve('../src/services/main-drift-poller'), { checkAndRedeployOne: async () => ({}) });
stub(require.resolve('../src/services/app-secrets'), {});
stub(require.resolve('../src/services/rename-pr'), {});
stub(require.resolve('../src/services/staging'), { rebuildProduction: async () => ({}), MissingSecretsError: class extends Error {} });

let pool = null;
require('../src/db/pool').getPool = () => pool;

const bot = require('../src/services/homeroom-bot');
const dm = require('../src/services/homeroom-bot-dm');
const { appRoutes } = require('../src/routes/apps');
const { steps: makeSteps } = require('../src/workflow/kernel/steps.ts');

const QS = [
  { question: 'Who can make a poll?', answers: ['Anyone in the club', 'Only you'] },
  { question: 'When do results show?', answers: ['As votes come in', 'After everyone votes'] },
];
const PLAN = {
  bullets: ['Make a poll in a few taps', 'Everyone votes once', 'See who won'],
  questions: QS,
  buildNote: 'One screen: the open polls. Its primary action is New poll.',
  model: 'z-ai/glm-5.3-flash',
};
const CARD = { kind: 'card', emoji: '🗳️', tagline: 'Polls for the club', points: ['Vote once', 'See who won'] };

test('a first version filed while its project is set up', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `fv_early_file_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  pool = new Pool({ connectionString: String(url), max: 6 });
  const env = process.env.USERNODE_ENV;
  delete process.env.USERNODE_ENV;
  t.after(async () => {
    if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env;
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2)
     RETURNING id, username, is_synthetic AS "isSynthetic", has_platform_access AS "hasPlatformAccess"`,
    [username, synthetic],
  )).rows[0];
  const BOT = await user('homeroom_bot', true);
  const evan = await user('evan_t1015');
  await pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_mode', 'live')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );

  // A project being set up, as POST /api/apps leaves it, with its first
  // version recorded (startFirstVersion) and its plan from Make it written.
  const project = async (slug, { status = 'creating', repo = true, plan = PLAN, botBuilds = true } = {}) => {
    const { rows: [inserted] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, repo_url)
       VALUES ($1, $2, $3, $4, 'private', 'private', $5) RETURNING id`,
      [`Club Votes ${slug}`, slug, status, evan.id, repo ? `https://github.com/usernode-bot/${slug}` : null],
    );
    const app = (await pool.query('SELECT id, slug, name, community_id, repo_url, self_hosted FROM apps WHERE id = $1', [inserted.id])).rows[0];
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, evan.id]);
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [app.id, evan.id]);
    await pool.query(
      `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, bot_builds, early_plan_status, early_plan, early_plan_at)
       VALUES ($1, $2, 'Polls for our club, so we can decide things together.', $3, 'ready', $4::jsonb, NOW())`,
      [app.id, evan.id, botBuilds, plan ? JSON.stringify(plan) : null],
    );
    return app;
  };
  const setApp = (app, sql, params = []) => pool.query(`UPDATE apps SET ${sql} WHERE id = $1`, [app.id, ...params]);
  const fvOf = async (app) => (await pool.query(
    'SELECT status, issue_number, attempts FROM homeroom_bot_first_versions WHERE app_id = $1', [app.id],
  )).rows[0];

  // GitHub, as the filing and the bot's read and build see it.
  const created = [];
  const comments = [];
  const github = {
    isEnabled: () => true,
    safeMention: (s) => s,
    parseGithubUrl: (u) => {
      const m = String(u).match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
      return m ? { owner: m[1], repo: m[2] } : null;
    },
    async createIssue(owner, repo, body) { created.push({ owner, repo, ...body }); return { number: 1 }; },
    noteIssueCreated() {},
    getBotUsername: async () => 'usernode-bot',
    async fetchPublicIssue(_o, _r, number) {
      return { issue: { number, title: 'First version', body: 'Polls for our club', state: 'open', createdAt: '2026-10-15T10:00:00Z', updatedAt: '2026-10-15T10:00:00Z' } };
    },
    async fetchIssueComments() { return { comments: [] }; },
    async createIssueComment(_o, _r, n, text) { comments.push({ n, text }); return { id: comments.length, created_at: new Date().toISOString() }; },
  };
  // The making's work: its steps kept as the kernel keeps them.
  const file = (app, { kept = { value: null }, last = false } = {}) => dm.fileFirstRequest(pool, {}, app.id, {
    steps: makeSteps({ resumeFrom: kept.value, checkpoint: async (v) => { kept.value = v; } }), last, deps: { github },
  });
  const woken = [];
  const realNote = bot.noteIssueActivity;
  bot.noteIssueActivity = (args) => { woken.push(args); return true; };
  t.after(() => { bot.noteIssueActivity = realNote; });

  await t.test('filed once, as its making asks: the issue under the maker\'s name, its rows, the bot woken', async () => {
    const app = await project('cv-card');
    await pool.query(`INSERT INTO app_sketches (app_id, user_id, status, design, model, ready_at, committed_at)
                      VALUES ($1, $2, 'ready', $3::jsonb, 'fallback', NOW(), NOW())`, [app.id, evan.id, JSON.stringify(CARD)]);
    woken.length = 0;
    assert.deepEqual(await file(app), { issueNumber: 1 }, 'filed while it is still being set up');
    const issue = created.at(-1);
    assert.equal(issue.repo, 'cv-card');
    assert.equal(issue.title, 'First version of Club Votes cv-card');
    assert.match(issue.body, /Polls for our club, so we can decide things together\./, 'the description');
    assert.match(issue.body, /\*\*Featured card:\*\* .*\(`design\/sketch\.json`\): "Polls for the club"/, 'and the card, committed');
    assert.match(issue.body, new RegExp(`<!-- homeroom-first-version:app-${app.id} -->$`), 'its marker, to be found again');
    assert.deepEqual(await fvOf(app), { status: 'filed', issue_number: 1, attempts: 1 });
    const requester = await dm.requesterOf(pool, app.id, 1);
    assert.equal(requester.userId, evan.id);
    assert.equal(requester.firstVersion, true);
    assert.deepEqual(woken, [{ appId: app.id, issueNumber: 1, reason: 'first_version' }], 'the bot is woken for it, its project refreshed at once');
    assert.deepEqual(await file(app), { skipped: 'filed' }, 'filed once');
    assert.equal(created.filter((c) => c.repo === 'cv-card').length, 1);
  });

  await t.test('a try that stopped after GitHub made the issue finds its own, and files no second', async () => {
    const app = await project('cv-twice');
    const before = created.length;
    github.findIssueByMarker = async (owner, repo, marker) => (marker === `<!-- homeroom-first-version:app-${app.id} -->` ? { number: 7 } : null);
    // The try before it asked GitHub (its step said so) and stopped before
    // it kept the answer.
    const kept = { value: { asked: true } };
    assert.deepEqual(await file(app, { kept }), { issueNumber: 7 });
    assert.equal(created.length, before, 'no second issue');
    assert.deepEqual(await fvOf(app), { status: 'filed', issue_number: 7, attempts: 1 });
    // Its rows were written, and the try that resumes after that writes
    // none twice.
    await pool.query(`UPDATE homeroom_bot_first_versions SET status = 'filing' WHERE app_id = $1`, [app.id]);
    const resumed = { value: { asked: true, issue: 7 } };
    assert.deepEqual(await file(app, { kept: resumed }), { issueNumber: 7 });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM issues WHERE app_id = $1 AND github_issue_number = 7', [app.id]);
    assert.equal(rows[0].n, 1, 'one issue row');
    delete github.findIssueByMarker;
  });

  await t.test('a row left filing is taken once nothing else can be filing it; one filed meanwhile is left to its filer', async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ours = process.env.GIT_SHA;
    process.env.GIT_SHA = 'this-build';
    const older = () => pool.query(`INSERT INTO platform_processes (id, release, role, state) VALUES ('older-pod', 'older-build', 'conductor', 'draining')`);
    const gone = () => pool.query(`DELETE FROM platform_processes WHERE id IN ('older-pod', 'our-pod')`);
    const filing = (app) => dm.fileFirstRequest(pool, {}, app.id, {
      steps: makeSteps({ resumeFrom: null, checkpoint: async () => {} }), deps: { github, claimWaitMs: 10 },
    });
    try {
      // An older build's process died filing it, or is filing it still.
      const app = await project('cv-left');
      await pool.query(`UPDATE homeroom_bot_first_versions SET status = 'filing' WHERE app_id = $1`, [app.id]);
      await older();
      await pool.query(`INSERT INTO platform_processes (id, release, role, state) VALUES ('our-pod', 'this-build', 'conductor', 'serving')`);
      const left = filing(app);
      await sleep(60);
      assert.equal(created.filter((c) => c.repo === 'cv-left').length, 0, 'waits while a process of the older build lives');
      await pool.query(`DELETE FROM platform_processes WHERE id = 'older-pod'`);
      assert.deepEqual(await left, { issueNumber: 1 }, 'taken once it is gone');
      assert.equal(created.filter((c) => c.repo === 'cv-left').length, 1);
      // Past that build's own lapse, taken whatever lives.
      const stale = await project('cv-stale');
      await pool.query(`UPDATE homeroom_bot_first_versions SET status = 'filing', created_at = now() - interval '31 minutes' WHERE app_id = $1`, [stale.id]);
      await older();
      assert.deepEqual(await filing(stale), { issueNumber: 1 });
      // One the older build filed while this waited is its own.
      const done = await project('cv-done');
      await pool.query(`UPDATE homeroom_bot_first_versions SET status = 'filing' WHERE app_id = $1`, [done.id]);
      const waiting = filing(done);
      await sleep(30);
      await pool.query(`UPDATE homeroom_bot_first_versions SET status = 'filed', issue_number = 3 WHERE app_id = $1`, [done.id]);
      assert.deepEqual(await waiting, { skipped: 'filed' });
      assert.equal(created.filter((c) => c.repo === 'cv-done').length, 0);
    } finally {
      await gone();
      if (ours === undefined) delete process.env.GIT_SHA; else process.env.GIT_SHA = ours;
    }
  });

  await t.test('a try that stopped after recording the issue still tells of it; a filed one with nothing kept is left', async () => {
    const app = await project('cv-told');
    const kept = { value: null };
    assert.deepEqual(await file(app, { kept }), { issueNumber: 1 });
    // Stopped before its announcement was kept.
    const { announce, ...rest } = kept.value;
    assert.equal(announce, true);
    woken.length = 0;
    assert.deepEqual(await file(app, { kept: { value: rest } }), { issueNumber: 1 });
    assert.deepEqual(woken, [{ appId: app.id, issueNumber: 1, reason: 'first_version' }]);
    assert.deepEqual(await file(app), { skipped: 'filed' });
    assert.equal(created.filter((c) => c.repo === 'cv-told').length, 1);
  });

  await t.test('a failure is tried again while tries are left; the last is recorded and told to its maker', async () => {
    const app = await project('cv-fails');
    const realCreate = github.createIssue;
    github.createIssue = async () => { throw new Error('GitHub is down'); };
    try {
      await assert.rejects(file(app), /GitHub is down/);
      assert.equal((await fvOf(app)).status, 'filing', 'held while it is tried again');
      assert.deepEqual(await file(app, { last: true }), { failed: 'GitHub is down' });
      assert.equal((await fvOf(app)).status, 'failed');
    } finally {
      github.createIssue = realCreate;
    }
  });

  await t.test('the bot\'s refresh takes in a project being set up once its first version is filed', async () => {
    const waiting = await project('cv-waiting');
    const filed = await project('cv-filed');
    const theirs = await project('cv-theirs', { botBuilds: false });
    const failed = await project('cv-failed', { status: 'error' });
    for (const app of [filed, theirs, failed]) {
      await pool.query(`UPDATE homeroom_bot_first_versions SET status = 'filed', issue_number = 1 WHERE app_id = $1`, [app.id]);
    }
    const listed = (await bot.listApps(pool)).map((a) => a.slug);
    assert.ok(listed.includes('cv-filed'), 'filed, and the bot builds it');
    assert.ok(!listed.includes('cv-waiting'), 'nothing filed yet');
    assert.ok(!listed.includes('cv-theirs'), 'a first version left to the group');
    assert.ok(!listed.includes('cv-failed'), 'a creation that failed');
    assert.ok(listed.includes('cv-card'), 'a project that runs, as always');
  });

  // The made screen and the bot's read, as first-version-early-plan-postgres
  // drives them, on a project that is still being set up.
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { req.user = { id: evan.id, username: evan.username }; next(); });
  server.use(appRoutes({}));
  const listening = server.listen(0);
  await new Promise((resolve) => listening.once('listening', resolve));
  t.after(() => {
    if (typeof listening.closeAllConnections === 'function') listening.closeAllConnections();
    listening.close();
  });
  const base = `http://127.0.0.1:${listening.address().port}`;
  const submit = (slug, answers) => fetch(`${base}${answersUrl(slug)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ answers }),
  });
  const turns = [];
  const deps = {
    github,
    domain: 'example.test', sessionLifecycle: {}, notifications: { hydrateAndPush: async () => {}, notifyIssueMentions: () => {} },
    worker: {
      async ensureWorkerImage() {}, async ensureWorker() { return 'w'; },
      async execInWorker() { turns.push(Date.now()); return { lastResultText: '' }; },
      isInFlight: () => false, async clearActiveTurn() {}, async stopTurn() {},
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    limits: { async checkBudget() { return { ok: true }; }, async recordSpend() {} },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    sessions: {
      buildHeadlessSeed: () => 'seed',
      async runCodexAttemptLoop({ dispatchOnce }) { return { result: await dispatchOnce({}), estimatedCostUsd: 0.05 }; },
    },
    activeWorkers: new Set(),
  };
  const settings = { mode: 'live', turnSeconds: 60, continueReads: false };
  const triage = async (app) => {
    const { rows: [item] } = await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason) VALUES ($1, 1, 1, 'new')
       RETURNING id, issue_number, reason, priority`,
      [app.id],
    );
    return bot.runTriage(pool, {}, { bot: BOT, app, item, mode: 'shadow', settings, deps });
  };
  const runOf = async (id) => (await pool.query('SELECT * FROM homeroom_bot_runs WHERE id = $1', [id])).rows[0];

  await t.test('answered before it is filed: built the moment the bot reads it, while the project is set up', async () => {
    const app = await project('cv-before');
    const res = await submit(app.slug, ['Only you', null]);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, building: false, answers: ['Only you', null] }, 'nothing filed yet to build');
    assert.deepEqual(await file(app), { issueNumber: 1 });
    const result = await triage(app);
    assert.equal(result.early, true);
    assert.equal(result.acted, 'build_queued', 'gone ahead with no Build it');
    assert.equal(turns.length, 0, 'no triage turn');
    const run = await runOf(result.runId);
    assert.ok(run.live_build_waiting_at, 'its build waits its turn');
    assert.deepEqual(run.plan.chosen.map((c) => c.answer), ['Only you', 'As votes come in']);
    assert.equal((await pool.query('SELECT status FROM apps WHERE id = $1', [app.id])).rows[0].status, 'creating');
  });

  let waitingApp = null;
  let waitingRunId = null;
  await t.test('answered after it is filed: the plan waits for the maker, and their Submit goes ahead with it', async () => {
    const app = await project('cv-after');
    assert.deepEqual(await file(app), { issueNumber: 1 });
    const result = await triage(app);
    assert.equal(result.acted, 'awaiting_go');
    const res = await submit(app.slug, [null, 'After everyone votes']);
    assert.deepEqual(await res.json(), { ok: true, building: true, answers: [null, 'After everyone votes'] });
    const run = await runOf(result.runId);
    assert.ok(run.live_build_waiting_at);
    assert.equal(run.awaiting_go_at, null);
    assert.deepEqual(run.plan.chosen.map((c) => c.answer), ['Anyone in the club', 'After everyone votes']);
    waitingApp = app;
    waitingRunId = result.runId;
  });

  await t.test('creation failing after the go-ahead: the build stops before it starts, as one that could not start does', async () => {
    assert.ok(waitingRunId, 'the go-ahead above');
    const app = waitingApp;
    await setApp(app, `status = 'error'`);
    const run = await runOf(waitingRunId);
    comments.length = 0;
    const out = await bot.buildOne(pool, {}, { bot: BOT, app, run, settings, deps });
    assert.deepEqual(out, { ran: true, verdict: 'ready', runId: waitingRunId, acted: 'build_failed' });
    const after = await runOf(waitingRunId);
    assert.equal(after.build_ok, false);
    assert.equal(after.build_error, bot.SETUP_FAILED_BEFORE);
    assert.equal(after.live_build_waiting_at, null, 'no longer waiting for a slot');
    assert.equal(after.proposal_session_id, null, 'no proposal');
    assert.equal(after.build_session_id, null);
    const { rows: sessions } = await pool.query('SELECT id FROM chat_sessions WHERE app_id = $1 AND user_id = $2', [app.id, BOT.id]);
    assert.deepEqual(sessions, [], 'nothing of it ever ran: no session, branch or worker');
    // Said in the words a build that could not start has always had.
    assert.equal(comments.length, 1);
    assert.match(comments[0].text, /^Homeroom bot couldn't get started on building this\. Reply here/);
    // And a second look finds nothing waiting to build.
    assert.equal(bot.autoRetryable({ ok: false, error: bot.SETUP_FAILED_DURING, setupFailed: true, specMd: '# Plan' }), false);
  });
});
