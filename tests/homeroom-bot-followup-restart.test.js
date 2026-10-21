// #4533: a checks fix keeps its time limit across a restart, and a busy
// session is a wait.
//
// PR #4533 (change 7428, request #4524), 9 Oct 2026. The bot's checks fix on
// its PROMOTED proposal ran 38 minutes against its 20: its clock was a timer
// in the process a deploy restarted, and recovery followed the turn through
// the person's tail, which re-arms no clock for a promoted session. Its push
// moved the proposal, but the ledger had no run for it, no checks_revise
// post and no cost. Its retry then asked for a temporary-storage worker
// while a sync with main ran on persistent storage: "Cannot change worker
// storage while a turn is running" was recorded as a platform fault, which
// paused the bot on every project, and every later retry hit session_busy
// and backed off in silence for up to an hour.
//
// A follow-up's turn is now a durable step of its look (bot-request's
// bot.look work, services/durable-turn.js): a restart follows it on its own
// saved deadline, and the look records its outcome as a live turn's. So
// what is left to pin here, without a database: the busy session answered
// before any worker is asked for, and read as a wait (never a fault), from
// the durable record of every kind of work on the session; the fix turn
// dispatched as its look's work item; and the wait shown on the console's
// queue, the connector's and get_change.
// tests/homeroom-bot-followup-restart-postgres.test.js drives the turn's
// durable step against the full schema.
//
// Run with: node --test tests/homeroom-bot-followup-restart.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const followup = require('../src/services/homeroom-bot-followup');
const turnLifecycle = require('../src/services/turn-lifecycle');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const APP = { id: 9, slug: 'recipebot-33b169', name: 'RecipeBot', repo_url: 'https://github.com/usernode-bot/recipebot-33b169', self_hosted: false };
const BOT = { id: 77, username: 'homeroom_bot' };
const SETTINGS = { mode: 'shadow', turnSeconds: 1200, turnInputTokens: 10_000_000 };
const SEEN = '2026-10-01T10:00:00Z';
const ITEM = { id: 31, app_id: 9, issue_number: 50, priority: 1, reason: bot.CHECKS_REASON, thread_seen_at: null };
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const TURN_ID = '6f9c1a52-4b8e-4f43-9a8e-5d1c2b3a4f60';

function results() {
  const rows = [{ name: 'Cooking mode text-size control offers all steps', path: '/#cook', status: 'fail', failureReason: 'expected "Text size"' }];
  for (let i = 1; i < 85; i += 1) rows.push({ name: `check ${i}`, path: '/', status: 'pass' });
  return rows;
}

function checksRow(extra = {}) {
  return {
    id: 5001, app_id: 9, linked_issues: [50], check_state: 'failing', checks_commit_sha: HEAD,
    reviewed_head_sha: HEAD, test_results: results(), slug: APP.slug, name: APP.name, repo_url: APP.repo_url,
    looked: false, ...extra,
  };
}

// runTriage down the checks path, as tests/homeroom-bot-checks-fix.test.js
// drives it, with whether somebody else works on the session (`taken`: the
// answer of followup.sessionTakenElsewhere's read) and what the worker
// answers (`ensureWorker`) up to each test.
function harness({ taken = false, ensureWorker = null } = {}) {
  const calls = { queries: [], ensured: 0, exec: [], taken: [] };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      calls.queries.push({ s, params });
      if (/SELECT id, status, pr_number FROM chat_sessions/.test(s)) return { rows: [{ id: 5001, status: 'promoted', pr_number: 82 }] };
      if (/SELECT id, thread_seen_at FROM homeroom_bot_runs/.test(s)) return { rows: [{ id: 800, thread_seen_at: SEEN }] };
      if (/AS looked/.test(s)) return { rows: [checksRow()] };
      if (/SELECT cs\.\*, a\.slug AS app_slug/.test(s)) {
        return { rows: [{ id: 5001, user_id: 77, app_id: 9, status: 'promoted', branch_name: 'dev/homeroom_bot-5001', pr_number: 82, reviewed_head_sha: HEAD, app_slug: APP.slug, repo_url: APP.repo_url }] };
      }
      if (/AS busy\s+FROM chat_sessions cs WHERE cs\.id = \$1/.test(s)) { calls.taken.push(params); return { rows: [{ busy: taken }] }; }
      if (/COUNT\(\*\)::int AS n FROM homeroom_bot_runs/.test(s)) return { rows: [{ n: 0 }] };
      if (/INSERT INTO homeroom_bot_runs/.test(s)) return { rows: [{ id: 901 }] };
      if (/FROM platform_settings/.test(s)) return { rows: [{ key: 'homeroom_bot_mode', value: 'shadow' }] };
      return { rows: [] };
    },
  };
  const deps = {
    github: {
      isEnabled: () => true,
      getBotUsername: async () => 'usernode-bot',
      async fetchPublicIssue() { return { issue: { number: 50, title: 'Bigger text in cooking mode', body: 'please', state: 'open' } }; },
      async fetchIssueComments() { return { comments: [] }; },
    },
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { calls.ensured += 1; if (ensureWorker) return ensureWorker(); return 'usernode-worker-5001'; },
      async execInWorker(id, opts) {
        calls.exec.push({ id, opts });
        return { lastResultText: '```json\n{"action":"revise","reply":"Renamed.","summary":"It says Text size."}\n```', pushOk: true, sha: NEW_HEAD };
      },
      async stopTurn() {},
      isInFlight: () => false,
      async clearActiveTurn() {},
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; }, estimateRequestedModelCost: () => ({ estimatedCostUsd: null }) },
    limits: { async checkBudget() { return { ok: true }; }, async recordSpend() {} },
    threadContext: {
      async loadIssueThread() { return { messages: [] }; },
      async loadProposalThread() { return { messages: [] }; },
    },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    sessions: {
      buildHeadlessSeed: (n) => `ISSUE #${n}`,
      async runCodexAttemptLoop({ dispatchOnce }) {
        // As runCodexAttemptLoop hands each attempt its logical turn id.
        const r = await dispatchOnce({ logicalTurnId: TURN_ID });
        return { result: r, error: null, estimatedCostUsd: 0.02 };
      },
    },
    activeWorkers: new Set(),
    ws: {},
    sessionLifecycle: {},
    domain: 'app.onhomeroom.com',
    votes: { async reconcileNativeReviewedHead() { return { enforced: true }; } },
  };
  return { pool, deps, calls };
}

// The look a test runs the triage in, as bot-request's bot.look runs it.
const OWNER = Object.freeze({ machine: 'bot-request', key: 'request:9:50', kind: 'bot.look' });

async function triage(t, h, look = bot._newLookForTests({ owner: OWNER })) {
  const real = { post: live.post, seen: live.advanceSeen, onProposal: live.postOnProposal, targets: live.mentionTargets };
  t.after(() => {
    Object.assign(live, { post: real.post, advanceSeen: real.seen, postOnProposal: real.onProposal, mentionTargets: real.targets });
    bot._resetForTests();
  });
  live.post = async () => ({ githubCreatedAt: '2026-10-01T12:05:00Z' });
  live.postOnProposal = async () => ({ postId: 1, thread: true });
  live.advanceSeen = async () => ({ advanced: true });
  live.mentionTargets = async () => [];
  bot._resetForTests();
  const out = await bot._runInLookForTests(look, () => bot.runTriage(h.pool, {}, {
    bot: BOT, app: APP, item: { ...ITEM, followUp: true }, mode: 'shadow', settings: SETTINGS, deps: h.deps,
  }));
  return { ...out, look };
}

const insertedRun = (h) => h.calls.queries.some((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));

// ── A busy session is a wait, never a fault ─────────────────────────────

test('somebody else working on the proposal: the fix waits before asking for a worker, and only it waits', async (t) => {
  // The 16:26 sync with main, read off its durable record.
  const h = harness({ taken: true });
  const out = await triage(t, h);
  assert.equal(out.reason, 'refused', 'the ordinary busy refusal');
  assert.equal(out.detail, 'session_busy');
  assert.equal(out.followUp, true, 'a follow-up\'s own wait, not its app\'s');
  assert.deepEqual(h.calls.taken, [[5001, OWNER.machine, OWNER.key]],
    'asked of the proposal\'s session, with the look\'s own work item, whose turn is never somebody else\'s');
  assert.equal(h.calls.ensured, 0, 'no worker asked for a storage it cannot have under a running turn');
  assert.equal(h.calls.exec.length, 0);
  assert.ok(!insertedRun(h), 'a wait writes no failed run');
  // The look says it waits; its request's instance backs it off and its row
  // says why (queueWait), and nothing pauses the whole bot.
  assert.equal(out.look.out.queue, 'busy');
  assert.equal(out.look.out.error, 'session_busy');
  assert.equal(out.look.out.fix, null, 'and no round on the head is reported as having ended');
});

test('sessionTakenElsewhere: every kind of work on the session, from its durable record, except the look\'s own turn', async () => {
  const sw = require('../src/workflow/session-work.ts');
  const asked = [];
  const pool = (busy) => ({ async query(sql, params) { asked.push({ sql: String(sql), params }); return { rows: [{ busy }] }; } });
  assert.equal(await followup.sessionTakenElsewhere(pool(false), 5001, OWNER), false);
  assert.equal(await followup.sessionTakenElsewhere(pool(true), 5001, OWNER), true);
  assert.deepEqual(asked[0].params, [5001, OWNER.machine, OWNER.key]);
  const sql = asked[0].sql;
  // A turn on the session is somebody else's unless its record names this
  // look's work item.
  assert.match(sql, /cs\.active_turn IS NOT NULL\s+AND NOT \(cs\.active_turn->'owner'->>'machine' IS NOT DISTINCT FROM \$2\s+AND cs\.active_turn->'owner'->>'key' IS NOT DISTINCT FROM \$3\)/);
  assert.match(sql, /FROM local_agent_turns t/, 'a turn on a local agent');
  // #4575: before & after shots hold the proposal from their first build,
  // but wrote no turn record until their agent started, minutes later. A
  // follow-up that started in that gap took the session, and the shots
  // failed with "durable active turn could not be persisted".
  assert.ok(sql.includes(sw.shotsRunningSql('cs.id')), 'a before & after shots run under way');
  assert.ok(sql.includes(sw.operationsLiveSql('cs.id')), 'an operation an old flow holds');
  assert.ok(sql.includes(sw.syncWorkingSql('cs.id')), 'a sync with main');
  assert.ok(sql.includes(sw.buildHoldSql('cs')), 'a durable build');
  assert.equal(await followup.sessionTakenElsewhere(pool(false), 5001, null), false);
  assert.deepEqual(asked.at(-1).params, [5001, null, null], 'with no owner, any turn on the session is somebody else\'s');
  const down = { async query() { throw new Error('db down'); } };
  assert.equal(await followup.sessionTakenElsewhere(down, 5001, OWNER), false,
    'an unreadable row is no reason to wait: the turn\'s own start still refuses a busy session');
});

test('the worker refusing to change its storage under a running turn is the same wait, not a platform fault', async (t) => {
  const thrown = Object.assign(new Error('Cannot change worker storage while a turn is running'), { code: 'session_busy' });
  const busy = harness({ ensureWorker: () => { throw thrown; } });
  const refused = await triage(t, busy);
  assert.equal(refused.reason, 'refused');
  assert.equal(refused.detail, 'session_busy');
  assert.equal(refused.look.out.queue, 'busy', 'a wait for this request alone');
  assert.ok(!insertedRun(busy), 'no "worker:" run in the ledger');
  // Any other worker failure is still the platform's.
  const h = harness({ ensureWorker: () => { throw new Error('exceeded quota: persistentvolumeclaims'); } });
  const out = await triage(t, h);
  assert.equal(out.reason, 'infra');
  assert.match(out.detail, /^worker: exceeded quota/);
  assert.equal(out.look.out.queue, 'fault', 'the lane pauses on the platform\'s fault');
  assert.ok(!insertedRun(h), 'a platform fault writes no failed run either');
  // worker.js keeps its own guard, now saying what it is.
  assert.match(read('src/services/worker.js'),
    /throw Object\.assign\(new Error\('Cannot change worker storage while a turn is running'\), \{ code: 'session_busy' \}\);/);
});

test('a read refused its worker\'s storage under a running turn waits too, rather than pausing the bot', async (t) => {
  t.after(() => bot._resetForTests());
  bot._resetForTests();
  const queries = [];
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      queries.push({ s, params });
      if (/SELECT \* FROM chat_sessions/.test(s)) {
        return { rows: [{ id: 501, user_id: 77, app_id: 9, branch_name: 'main', agent_backend: 'codex_openrouter', agent_model: 'z-ai/glm-5.3-flash' }] };
      }
      return { rows: [] };
    },
  };
  const deps = {
    github: {
      isEnabled: () => true,
      async fetchPublicIssue() { return { issue: { number: 12, title: 'Pins drift', body: 'They drift.', state: 'open' } }; },
      async fetchIssueComments() { return { comments: [] }; },
    },
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { throw Object.assign(new Error('Cannot change worker storage while a turn is running'), { code: 'session_busy' }); },
    },
    agentTurn: {},
    limits: { async checkBudget() { return { ok: true }; } },
    threadContext: { async loadIssueThread() { return { messages: [] }; } },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    sessions: { buildHeadlessSeed: () => 'SEED' },
  };
  const app = { ...APP, slug: 'todo' };
  const look = bot._newLookForTests({ owner: { machine: 'bot-request', key: 'request:9:12', kind: 'bot.look' } });
  const out = await bot._runInLookForTests(look, () => bot.runTriage(pool, {}, {
    bot: BOT, app, item: { id: 32, app_id: 9, issue_number: 12, priority: 1, reason: 'new', thread_seen_at: null },
    mode: 'shadow', settings: { ...SETTINGS, pausedApps: ['todo'] }, deps,
  }));
  assert.equal(out.reason, 'refused');
  assert.equal(out.detail, 'session_busy');
  assert.equal(look.out.queue, 'busy', 'a wait, never the lane\'s fault pause');
  assert.ok(!queries.some((q) => /INSERT INTO homeroom_bot_runs/.test(q.s)));
});

// ── The fix turn is its look's ──────────────────────────────────────────

test('a fix turn is dispatched as its look\'s work item, on its own clock, and its outcome is the look\'s', async (t) => {
  const h = harness();
  const out = await triage(t, h);
  assert.equal(out.verdict, 'revise');
  assert.equal(h.calls.exec.length, 1, 'one turn');
  assert.deepEqual(h.calls.exec[0].opts.owner, OWNER,
    'its record names the look (a restart follows it by that, and a Stop reaches its machine)');
  assert.equal(h.calls.exec[0].opts.mode, 'build');
  assert.equal(out.look.out.queue, 'consume', 'the look\'s end consumes its debt');
  assert.deepEqual(out.look.out.fix, { outcome: 'looked' }, 'and tells the change machine the round looked at the head');
  // No record mark of the bot's own: the turn's deadline is the durable
  // step's (durable-turn.js), not a field the bot stamps on the record.
  assert.ok(!h.calls.queries.some((q) => /jsonb_set\(active_turn/.test(q.s)));
  assert.equal(followup.TURN_MARK, undefined);
  assert.equal(bot.finishRecoveredFollowUp, undefined);
  assert.equal(bot.recoveryDeadline, undefined);
});

test('stampTurn writes one owner key on the exact turn and never a field the lifecycle owns', async () => {
  const asked = [];
  const db = { async query(sql, params) { asked.push({ sql, params }); return { rows: [{ id: 1 }], rowCount: 1 }; } };
  assert.equal(await turnLifecycle.stampTurn(db, { sessionId: 7, turnId: 'turn-1', key: 'homeroomBotFollowUp', value: { a: 1 } }), true);
  assert.match(asked[0].sql, /active_turn->>'turnId' = \$2/, 'compare-and-set on the turn');
  assert.deepEqual(asked[0].params, [7, 'turn-1', 'homeroomBotFollowUp', '{"a":1}']);
  for (const key of ['phase', 'turnId', 'startedAt', 'mode', 'tail', 'restarts', 'stopRequestedAt', 'Bad', '']) {
    await assert.rejects(turnLifecycle.stampTurn(db, { sessionId: 7, turnId: 'turn-1', key, value: 1 }), /not a key/, key);
  }
  await assert.rejects(turnLifecycle.stampTurn(db, { sessionId: 7, turnId: null, key: 'homeroomBotFollowUp', value: 1 }), /turnId required/);
  const missed = { async query() { return { rows: [], rowCount: 0 }; } };
  assert.equal(await turnLifecycle.stampTurn(missed, { sessionId: 7, turnId: 'turn-1', key: 'homeroomBotFollowUp', value: 1 }), false,
    'a turn that no longer holds the session is not stamped');
});

// ── 4. The wait, where people look ──────────────────────────────────────

test('queueWait: its own refusal, then its payer\'s week, then the bot\'s fault pause; a wait that is over is none', () => {
  const now = Date.parse('2026-10-09T16:30:00Z');
  const later = '2026-10-09T16:40:00.000Z';
  assert.deepEqual(bot.queueWait({ wait_reason: 'session_busy', wait_until: later }, { now }), { reason: 'session_busy', until: later });
  assert.equal(bot.queueWait({ wait_reason: 'session_busy', wait_until: '2026-10-09T16:20:00Z' }, { now }), null);
  assert.equal(bot.queueWait({ started_at: '2026-10-09T16:29:00Z', wait_reason: 'session_busy', wait_until: later }, { now }), null,
    'a running row is not waiting');
  assert.deepEqual(bot.queueWait({ held_until: later }, { now }), { reason: 'allowance', until: later });
  assert.deepEqual(bot.queueWait({}, { now, fault: { until: Date.parse(later) } }), { reason: 'platform_fault', until: later });
  assert.equal(bot.queueWait({}, { now }), null);
  const src = read('src/services/homeroom-bot.js');
  assert.match(src, /q\.held_until, q\.wait_reason, q\.wait_until, q\.waiting_total, q\.running_total,\n\s+a\.slug AS app_slug/);
  assert.match(src, /const items = rows\.map\(\(\{ waiting_total: _w, running_total: _r, \.\.\.q \}\) => \(\{ \.\.\.q, waiting: queueWait\(q, ctx\) \}\)\);/);
  // The fault pause from the bot's lane instance (bot-lane), read from
  // Postgres: the same answer in every process (loopMemory).
  assert.match(src, /fault: mem\.fault, now, off: settings\.mode === 'off'/);
  assert.match(src, /async function loopMemory\(pool, now = Date\.now\(\)\) \{/);
  assert.match(src, /if \(d\.fault && until\(d\.fault\.until\) > now\) out\.fault = /);
  // The row's own wait is the backoff its request's instance keeps, written
  // by its projection (bot-request), and cleared while it looks.
  assert.match(read('src/workflow/bot-request/machine.ts'),
    /looking \? null : d\.backoff\?\.reason \?\? null, looking \? null : d\.backoff\?\.until \?\? null\]/);
  assert.match(read('src/db/schema.sql'), /ALTER TABLE homeroom_bot_queue ADD COLUMN IF NOT EXISTS wait_reason TEXT;\nALTER TABLE homeroom_bot_queue ADD COLUMN IF NOT EXISTS wait_until TIMESTAMPTZ;/);
});

test('get_homeroom_bot\'s queue items carry the wait as a code and a time', async () => {
  const data = require('../src/services/bench/connector-data');
  const fake = {
    adminPayload: async () => ({
      settings: {}, bot: null, totals: {}, runs: [],
      queue: { depth: 2, items: [
        { app_slug: 'recipebot', issue_number: 50, reason: 'checks_failing', enqueued_at: '2026-10-09T16:00:00Z', waiting: { reason: 'session_busy', until: '2026-10-09T16:40:00Z' } },
        { app_slug: 'recipebot', issue_number: 51, reason: 'new', enqueued_at: '2026-10-09T16:01:00Z', waiting: { reason: 'Not a code!', until: '2026-10-09T16:40:00Z' } },
        { app_slug: 'recipebot', issue_number: 52, reason: 'new', enqueued_at: '2026-10-09T16:02:00Z', waiting: null },
      ] },
    }),
  };
  const out = await data.botOverview(null, {}, {}, { bot: fake });
  assert.deepEqual(out.queue.items.map((i) => i.waiting), [
    { reason: 'session_busy', until: '2026-10-09T16:40:00.000Z' }, null, null,
  ]);
  assert.match(read('src/services/mcp-tools.js'), /the queue \(each item\\'s waiting, when it waits: why, session_busy for a turn running on its session/);
});

test('the console\'s queue says why a row waits and until when', () => {
  globalThis.window = globalThis.window || globalThis;
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { QueueItems, waitLine } = loadTsx('frontend/src/features/admin/admin-homeroom-bot.tsx', {
    stubs: {
      './admin-console.js': {
        AdminUI: new Proxy({}, {
          get: (_t, key) => (['btn', 'badge'].includes(key) ? new Proxy({}, { get: (_u, k) => `${key}-${String(k)}` }) : String(key)),
        }),
      },
      '../../lib/legacy-portals': { mountLegacyPortal() {}, unmountLegacyPortal() {} },
    },
  });
  const until = '2026-10-09T16:40:00Z';
  assert.match(waitLine({ reason: 'session_busy', until }), /^waiting: a turn is running on its session, until \S/);
  assert.match(waitLine({ reason: 'allowance', until }), /^waiting: its payer's week is used up, until /);
  assert.match(waitLine({ reason: 'platform_fault', until }), /^waiting: the bot is backing off a platform fault, until /);
  assert.match(waitLine({ reason: 'something_new', until: null }), /^waiting: something new$/);
  assert.equal(waitLine(null), '');
  const html = renderToHtml(createElement(QueueItems, { items: [
    { id: 1, issue_number: 50, priority: 1, reason: 'checks_failing', enqueued_at: '', started_at: null, app_slug: 'r', app_name: 'RecipeBot', waiting: { reason: 'session_busy', until } },
    { id: 2, issue_number: 51, priority: 1, reason: 'new', enqueued_at: '', started_at: null, app_slug: 'r', app_name: 'RecipeBot', waiting: null },
  ] }));
  assert.match(html, /id="admin-homeroom-bot-queue"/);
  assert.match(html, /<span>RecipeBot<\/span><span class="muted">#50<\/span><span class="muted" data-queue-waiting="session_busy">waiting: a turn is running on its session, until /);
  assert.match(html, /<span>RecipeBot<\/span><span class="muted">#51<\/span><\/li>/, 'a row next in line says nothing more');
  assert.match(renderToHtml(createElement(QueueItems, { items: [] })), /Nothing queued\./);
});

test('get_change says when the running turn started and what kind it is', async () => {
  const tools = require('../src/services/mcp-tools');
  const shape = (live) => tools.shapeChange({ id: 7428, app_slug: 'homeroom', status: 'promoted', branch_name: 'b' }, live, '', 'external');
  assert.deepEqual(shape({ busy: true, turn: { startedAt: '2026-10-09T16:20:00Z', kind: 'sync' } }).runningTurn,
    { startedAt: '2026-10-09T16:20:00.000Z', kind: 'sync' });
  assert.deepEqual(shape({ busy: true, turn: { startedAt: 'never', kind: 'Not a code' } }).runningTurn, { startedAt: null, kind: null });
  assert.equal(shape({ busy: false, turn: null }).runningTurn, null);
  assert.equal(shape(null).runningTurn, null);
  assert.deepEqual(shape({ busy: true, turn: { startedAt: '2026-10-09T16:20:00Z', kind: 'homeroom_bot_follow_up' } }).runningTurn,
    { startedAt: '2026-10-09T16:20:00.000Z', kind: 'homeroom_bot_follow_up' });
  // The bot's follow-up is known by its record's owner: a turn its request's
  // look runs (bot-request).
  const sessions = read('src/routes/sessions.js');
  assert.match(sessions, /const own = turnLifecycle\.ownerOf\(durableTurn\);\n\s+turn = \{\n\s+startedAt: durableTurn\.startedAt \|\| null,\n\s+kind: own\?\.machine === 'bot-request' \? 'homeroom_bot_follow_up' : \(durableTurn\.mode \|\| null\),/);
  assert.match(sessions, /busy, progress, phase, stopping, stopRequestedAt, stoppable, estimate, turn,/);
});

// #4575: the bot's build and review-fix turns on a session wait for a
// before & after shots run under way there, bounded, as the Mayor's do.
test('a bot turn waits out the shots run on its session, at most its bound', async () => {
  // Whether a run is under way, and the wait for its end, are the shots
  // machine's state (services/shots-state.js shotsRunning, waitForShotsRun).
  const waits = [];
  assert.equal(await live.waitOutShotsRun(5001, { shotsRunning: async () => false }), 'idle');
  assert.equal(await live.waitOutShotsRun(5001, {
    shotsRunning: async () => true,
    shotsWait: async (id, o) => { waits.push([id, o.timeoutMs]); return 'finished'; },
    shotsWaitMs: 60_000,
  }), 'finished');
  assert.deepEqual(waits, [[5001, 60_000]]);
  assert.equal(await live.waitOutShotsRun(5001, {
    shotsRunning: async () => true, shotsWait: async () => 'timeout', shotsWaitMs: 5,
  }), 'timeout');
  // A read that fails does not hold the turn back.
  assert.equal(await live.waitOutShotsRun(5001, { shotsRunning: async () => { throw new Error('db'); } }), 'idle');

  // The runner waits it out before its turn's clock starts: a shots run
  // that outlasts the turn's whole budget costs the turn none of it. The
  // clock is durable-turn.js runTurn's, armed before it dispatches.
  const stops = [];
  const dispatched = [];
  let shotsDone;
  const shots = new Promise((resolve) => { shotsDone = resolve; });
  const runTurn = live.buildTurnRunner({
    pool: { async query() { return { rows: [] }; } },
    config: {}, bot: BOT, session: { id: 5001, app_id: APP.id, repo_url: APP.repo_url },
    model: 'z-ai/glm-5.3-flash', branchName: 'dev/homeroom_bot-5001', containerName: 'sv-worker-s5001',
    deps: {
      worker: { async stopTurn(id) { stops.push(id); return true; } },
      sessions: { async runCodexAttemptLoop() { dispatched.push(Date.now()); return { result: { pushOk: true, ahead: 1, sha: NEW_HEAD } }; } },
      agentTurn: {},
      activeWorkers: { add() {}, delete() {} },
      shotsRunning: async (id) => id === 5001,
      shotsWait: async () => { await shots; return 'finished'; },
      shotsWaitMs: 60_000,
    },
  });
  const turn = runTurn({ prompt: 'Fix the failing check.', budgetMs: 200, commitMsg: 'Fix', progress: { note() {} } });
  await new Promise((r) => { setTimeout(r, 400); });
  assert.deepEqual(dispatched, [], 'not dispatched while the shots run is under way');
  shotsDone();
  const out = await turn;
  assert.equal(dispatched.length, 1, 'dispatched once it is over');
  assert.deepEqual(stops, [], 'the wait is not charged to the turn\'s own clock');
  assert.equal(out.stopped, false);
  assert.equal(out.routed.result.sha, NEW_HEAD);
});
