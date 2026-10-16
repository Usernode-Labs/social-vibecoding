'use strict';

// A first version's plan from Make it (services/first-version-plan.js),
// end to end against the real schema, routes and DM: its maker's made
// screen reads its questions off GET /api/apps/:slug, Submit keeps the
// answers (POST /api/apps/:slug/first-version/answers, the maker's alone),
// and when the bot comes to the request it builds from that plan with no
// triage turn (homeroom-bot.js planFromEarly): at once when it is decided,
// with the chat's plan card sent without a ring and shown as being built;
// else it waits for them as before, and their Submit goes ahead with it.
// A plan that failed is read by the triage as it always was.
//
// Newcomer run four, 12-13 October 2026: the plan took a 33-second triage
// turn after the project was set up, and reached its maker as a card whose
// Build it they found 4.5 minutes after Make it.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/first-version-early-plan-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const { Pool } = require('pg');

const { loadTsx } = require('./lib/render-tsx');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const MADE = 'frontend/src/features/first-session/made.tsx';

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Realtime and push are process-wide singletons (the bot's DM sends through
// them), and the apps router's infrastructure is not what this is about.
const pushed = [];
stub(require.resolve('../src/services/ws'), new Proxy({
  pushConversationEvent: (_audience, event) => { pushed.push(event); return 1; },
  pushToUser: () => 1, pushNotificationToUser: () => 1,
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
const live = require('../src/services/homeroom-bot-live');
const { appRoutes } = require('../src/routes/apps');

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

test('a first version planned at Make it: answered on the made screen, built with no triage turn', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `fv_early_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  pool = new Pool({ connectionString: String(url), max: 6 });
  const env = process.env.USERNODE_ENV;
  delete process.env.USERNODE_ENV;
  // The bot session's slot moves are the proposal machine's
  // (session-lifecycle's takeSlot and restSession): the workflow runtime runs
  // here, on this database, its pipeline only (no timers, no work).
  const platform = require('../src/workflow/platform.ts');
  t.after(async () => {
    if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env;
    await platform.stopWorkflow();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  // Applied twice, as every deploy does: idempotent.
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await platform.startWorkflow({ databaseUrl: String(url), dataEncryptionKey: 'synthetic-key', wfPoolMax: 4, wfSlots: 2 }, { loops: false });

  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2)
     RETURNING id, username, is_synthetic AS "isSynthetic", has_platform_access AS "hasPlatformAccess"`,
    [username, synthetic],
  )).rows[0];
  const BOT = await user('homeroom_bot', true);
  const evan = await user('evan_t1013');
  const maya = await user('maya_t1013');
  const set = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
  await set('homeroom_bot_mode', 'live');

  const project = async (slug, number) => {
    const { rows: [inserted] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, repo_url)
       VALUES ($1, $2, 'running', $3, 'private', 'private', $4) RETURNING id`,
      [`Club Votes ${number}`, slug, evan.id, `https://github.com/o/${slug}`],
    );
    const app = (await pool.query('SELECT id, slug, name, community_id, repo_url FROM apps WHERE id = $1', [inserted.id])).rows[0];
    for (const m of [evan, maya]) {
      await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, m.id]);
      await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [app.id, m.id]);
    }
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, first_version, asked_text)
       VALUES ($1, 1, $2, 'First version of Club Votes', TRUE, 'Polls for our club')`,
      [app.id, evan.id],
    );
    return app;
  };
  const firstVersion = (app, { plan = PLAN, status = 'ready' } = {}) => pool.query(
    `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, bot_builds, status, issue_number, early_plan_status, early_plan, early_plan_at)
     VALUES ($1, $2, 'Polls for our club', TRUE, 'filed', 1, $3, $4::jsonb, NOW())`,
    [app.id, evan.id, status, plan ? JSON.stringify(plan) : null],
  );

  let viewer = evan;
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { req.user = { id: viewer.id, username: viewer.username }; next(); });
  server.use(appRoutes({}));
  const listening = server.listen(0);
  await new Promise((resolve) => listening.once('listening', resolve));
  t.after(() => {
    if (typeof listening.closeAllConnections === 'function') listening.closeAllConnections();
    listening.close();
  });
  const base = `http://127.0.0.1:${listening.address().port}`;
  const { madeAppOf, madeAppUrl, askedQuestions, answersUrl } = loadTsx(MADE);
  const read = async (slug) => {
    const res = await fetch(`${base}${madeAppUrl(slug)}`);
    assert.equal(res.status, 200);
    return madeAppOf(await res.json()).firstVersion;
  };
  // The same-origin guard reads the browser's own headers.
  const submit = (slug, answers) => fetch(`${base}${answersUrl(slug)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ answers }),
  });

  // The bot's read, with GitHub and the worker stubbed: a triage turn is
  // counted, never expected unless the plan from Make it failed.
  const turns = [];
  const github = {
    isEnabled: () => true,
    getBotUsername: async () => 'usernode-bot',
    async fetchPublicIssue(_o, _r, number) {
      return { issue: { number, title: 'First version of Club Votes', body: 'Polls for our club', state: 'open', createdAt: '2026-10-13T10:00:00Z', updatedAt: '2026-10-13T10:00:00Z' } };
    },
    async fetchIssueComments() { return { comments: [] }; },
    async createIssueComment() { return { id: 1, created_at: new Date().toISOString() }; },
  };
  const deps = {
    github,
    domain: 'example.test', sessionLifecycle: {}, notifications: null,
    worker: {
      async ensureWorkerImage() {}, async ensureWorker() { return 'w'; },
      async execInWorker() {
        turns.push(Date.now());
        const verdict = { verdict: 'ready', build_note: 'Polls.', plan: ['Polls'], choices: [] };
        return { lastResultText: `\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\`` };
      },
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
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason) VALUES ($1, 1, 0, 'new')
       RETURNING id, issue_number, reason`,
      [app.id],
    );
    return bot.runTriage(pool, {}, { bot: BOT, app, item, mode: 'shadow', settings, deps });
  };
  const runOf = async (id) => (await pool.query('SELECT * FROM homeroom_bot_runs WHERE id = $1', [id])).rows[0];
  const cardOf = async (runId) => (await pool.query(
    `SELECT m.id, m.metadata->'homeroomBot' AS meta, m.metadata FROM homeroom_bot_dm_messages d
       JOIN conversation_messages m ON m.id = d.message_id WHERE d.run_id = $1 AND d.kind = 'plan'`,
    [runId],
  )).rows[0];

  await t.test('answered on the made screen before the bot reads it: built at once, with no triage turn and no question in the chat', async () => {
    const app = await project('club-votes', 1);
    await firstVersion(app);
    const asking = await read(app.slug);
    assert.equal(asking.line, 'planning');
    assert.deepEqual(askedQuestions(asking), QS, 'the made screen asks the plan\'s questions');
    // Another member reads neither the plan nor its questions, and cannot answer them.
    viewer = maya;
    try {
      assert.equal((await read(app.slug)).early, undefined);
      const refused = await submit(app.slug, ['Only you']);
      assert.equal(refused.status, 403);
      assert.equal((await refused.json()).error, 'not_the_maker');
    } finally { viewer = evan; }
    const res = await submit(app.slug, ['Only you', null]);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, building: false, answers: ['Only you', null] });
    // Once: a second Submit changes nothing.
    const again = await submit(app.slug, ['Anyone in the club', 'After everyone votes']);
    assert.deepEqual((await again.json()).answers, ['Only you', null]);
    const answered = await read(app.slug);
    assert.equal(answered.line, 'building', 'the bot builds it now, it does not plan it');
    assert.equal(askedQuestions(answered), null);

    const result = await triage(app);
    assert.equal(result.early, true);
    assert.equal(result.acted, 'build_queued');
    assert.equal(turns.length, 0, 'no triage turn');
    const run = await runOf(result.runId);
    assert.equal(run.verdict, 'ready');
    assert.equal(run.model, 'z-ai/glm-5.3-flash');
    assert.equal(Number(run.cost_usd), 0);
    assert.ok(run.live_build_waiting_at, 'its build waits its turn');
    assert.equal(run.awaiting_go_at, null, 'no Build it to wait for');
    assert.deepEqual(run.plan.chosen.map((c) => c.answer), ['Only you', 'As votes come in'], 'the answers, the suggested one for one left alone');
    assert.match(run.build_note, /^One screen: the open polls\. Its primary action is New poll\./);
    // Newcomer run seven (14 Oct 2026): the made screen showed its maker the
    // questions alone, so the plan's lines are its own, in the sketch, and
    // only the answers are theirs, winning where a line differs.
    assert.ok(run.build_note.endsWith([
      '',
      '',
      live.PLAN_LINES_HEAD,
      '- Make a poll in a few taps',
      '- Everyone votes once',
      '- See who won',
      '',
      live.MADE_SCREEN_CHOICES_HEAD,
      '- Who can make a poll? Only you',
      '- When do results show? As votes come in',
    ].join('\n')), run.build_note);
    assert.doesNotMatch(run.build_note, /Approved by the creator, who tapped Build it|from the plan they were shown/, 'never said to be approved under Build it');
    const split = live.splitApprovedPlan(run.build_note);
    assert.match(split.sketch, /- Make a poll in a few taps/, 'the lines are the plan\'s sketch');
    assert.ok(split.approved.startsWith(live.MADE_SCREEN_CHOICES_HEAD));
    assert.equal(run.plan.planShown, false, 'kept, so a run a restart sends back writes the same note');
    const card = await cardOf(result.runId);
    assert.equal(card.meta.status, 'answered', 'the chat\'s card says it is being built');
    assert.equal(card.meta.chosen, 'build');
    assert.deepEqual(card.meta.choices, ['Only you', 'As votes come in']);
    assert.equal(card.meta.moment ?? null, null, 'sent without a ring: nothing waits on them');
    const fv = (await pool.query('SELECT answered_at FROM homeroom_bot_first_versions WHERE app_id = $1', [app.id])).rows[0];
    assert.ok(fv.answered_at);
    // The queue row is used up, and the next read of its state is the build.
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM homeroom_bot_queue WHERE app_id = $1', [app.id])).rows[0].n, 0);
    const building = await read(app.slug);
    assert.deepEqual([building.step, building.line], [4, 'building']);
    assert.deepEqual(building.phase && building.phase.key, 'starting', 'N4: its build waits its turn: no spec turn yet, so nothing is drawn (run five)');
  });

  await t.test('not answered yet: the plan waits for its maker as before, and their Submit goes ahead with it', async () => {
    const app = await project('club-votes-2', 2);
    await firstVersion(app);
    const result = await triage(app);
    assert.equal(result.acted, 'awaiting_go');
    assert.equal(turns.length, 0, 'still no triage turn');
    const card = await cardOf(result.runId);
    assert.equal(card.meta.status, 'open', 'Build it in the chat, as today');
    assert.equal(card.meta.moment, 'needs_you', 'and it rings: it waits on them');
    const waiting = await read(app.slug);
    assert.equal(waiting.line, 'plan');
    assert.deepEqual(askedQuestions(waiting), QS, 'the same questions on the made screen');
    const res = await submit(app.slug, [null, 'After everyone votes']);
    assert.deepEqual(await res.json(), { ok: true, building: true, answers: [null, 'After everyone votes'] });
    const run = await runOf(result.runId);
    assert.ok(run.live_build_waiting_at);
    assert.deepEqual(run.plan.chosen.map((c) => c.answer), ['Anyone in the club', 'After everyone votes']);
    // Run seven: Submit on the made screen, not Build it under the card.
    assert.ok(run.build_note.endsWith(`\n\n${live.MADE_SCREEN_CHOICES_HEAD}\n- Who can make a poll? Anyone in the club\n- When do results show? After everyone votes`), run.build_note);
    assert.doesNotMatch(run.build_note, /Approved by the creator/);
    assert.equal(run.plan.planShown, false);
    const decided = await cardOf(result.runId);
    assert.equal(decided.meta.status, 'answered');
    assert.deepEqual(decided.meta.choices, ['Anyone in the club', 'After everyone votes']);
    assert.equal(askedQuestions(await read(app.slug)), null);
  });

  await t.test('a plan that asks nothing goes ahead the moment the bot reads it', async () => {
    const app = await project('club-votes-3', 3);
    await firstVersion(app, { plan: { ...PLAN, questions: [] } });
    assert.equal((await read(app.slug)).line, 'building', 'nothing to ask: decided');
    const result = await triage(app);
    assert.equal(result.acted, 'build_queued');
    assert.equal(turns.length, 0);
    const run = await runOf(result.runId);
    assert.deepEqual(run.plan.chosen, []);
    // Run seven: nothing was put to its maker, so nothing is approved.
    assert.ok(run.build_note.endsWith(`\n\n${live.PLAN_LINES_HEAD}\n- Make a poll in a few taps\n- Everyone votes once\n- See who won`), run.build_note);
    assert.equal(live.splitApprovedPlan(run.build_note).approved, '');
  });

  await t.test('a plan that failed at Make it: the triage reads the request, as it always did', async () => {
    const app = await project('club-votes-4', 4);
    await firstVersion(app, { plan: null, status: 'failed' });
    const result = await triage(app);
    assert.equal(result.early, undefined);
    assert.equal(turns.length, 1, 'one triage turn');
    assert.equal(result.acted, 'awaiting_go', 'its plan waits for Build it');
  });
});
