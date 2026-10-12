'use strict';

// A ready verdict a cap held is reused when its turn comes (cap_freed), as
// long as the request has not changed since it was read: no model turn, no
// "looking at this" note, a new run that names the one it reused at no cost,
// and then acted on as a fresh ready verdict is (built, or held again
// without the held note said twice). A request that changed is read again.
//
// Runs runTriage against the full PostgreSQL schema when a database is
// reachable, like the repository's other postgres tests; GitHub, the
// worker and the DM are stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const bot = require('../src/services/homeroom-bot');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// ── What a read saw ─────────────────────────────────────────────────────

test('the fingerprint is the request as people wrote it, the bot\'s own posts left out', () => {
  const issue = { title: 'Dark mode', body: 'Please add it. https://h.test/issue-images/abc' };
  const comments = [{ id: 1, author: 'evan', body: 'Yes please' }];
  const threadMessages = [{ author: 'maya', body: 'Me too', createdAt: '2026-10-10T00:00:00.000Z' }];
  const base = bot.readFingerprintOf({ issue, comments, threadMessages, botLogins: ['usernode-bot', 'homeroom_bot'] });
  assert.equal(base.v, 1);
  assert.match(base.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual([base.comments, base.lastCommentId, base.messages], [1, '1', 1]);
  const same = (over) => bot.readFingerprintOf({
    issue, comments, threadMessages, botLogins: ['usernode-bot', 'homeroom_bot'], ...over,
  }).hash === base.hash;
  assert.ok(same({
    comments: [...comments, { id: 2, author: 'usernode-bot[bot]', body: 'Held: the cap is full.' }],
    threadMessages: [...threadMessages, { author: 'homeroom_bot', body: 'Held.', createdAt: '2026-10-11T00:00:00.000Z' }],
  }), 'the held note the bot posted after the read is no change');
  assert.ok(!same({ issue: { ...issue, title: 'Dark mode, and a light one' } }), 'a new title');
  assert.ok(!same({ issue: { ...issue, body: 'Please add it. https://h.test/issue-images/xyz' } }), 'another screenshot');
  assert.ok(!same({ comments: [...comments, { id: 3, author: 'evan', body: 'And a toggle' }] }), 'a comment');
  assert.ok(!same({ comments: [{ ...comments[0], body: 'Yes please, today' }] }), 'a comment edited');
  assert.ok(!same({ threadMessages: [...threadMessages, { author: 'maya', body: 'Any news?', createdAt: '2026-10-11T00:00:00.000Z' }] }), 'a message');
});

test('the console and the connector show a reused run', () => {
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(tsx, /\{run\.reused_run_id \? <span className=\{`\$\{AdminUI\.badge\.outline\} ml-1`\} data-homeroom-bot-reused=\{run\.reused_run_id\}>reused<\/span> : null\}/);
  const src = read('src/services/homeroom-bot.js');
  assert.match(src, /r\.read_reason, r\.reused_run_id,/);
  assert.ok(bot.EXPORT_COLUMNS.includes('reused_run_id'));
  assert.match(read('src/services/bench/connector-data.js'), /reused: r\.reused_run_id != null,\n\s+reusedFrom: num\(r\.reused_run_id\),/);
});

// ── runTriage against the real schema ───────────────────────────────────

test('a held ready verdict is reused while its request is unchanged, and read again once it changes', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_reuse_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
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
    `INSERT INTO users (username, password, is_synthetic) VALUES ($1, 'x', $2) RETURNING id, username`,
    [username, synthetic],
  )).rows[0];
  const BOT = await user('homeroom_bot', true);
  const ada = await user('ada');
  const app = (await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('RSS', 'rss', 'running', 'https://github.com/o/rss')
     RETURNING id, slug, name, repo_url`,
  )).rows[0];
  // The bot's proposals up for a vote on this app: the per-app cap, full.
  const capped = [];
  for (let i = 0; i < 5; i += 1) {
    capped.push((await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues)
       VALUES ($1, $2, $3, 'promoted', FALSE, '{99}') RETURNING id`,
      [app.id, BOT.id, `bot-${i}`],
    )).rows[0].id);
  }

  const issue = {
    number: 24, title: 'Dark mode', body: 'Please add it.', state: 'open',
    createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z',
  };
  const comments = [{ id: 1, author: 'ada-gh', body: 'The header too.', createdAt: '2026-10-10T00:01:00Z' }];
  const githubPosts = [];
  const turns = [];
  const github = {
    isEnabled: () => true,
    getBotUsername: async () => 'usernode-bot',
    async fetchPublicIssue() { return { issue: { ...issue } }; },
    async fetchIssueComments() { return { comments: comments.map((c) => ({ ...c })) }; },
    async createIssueComment(_o, _r, _n, body) {
      githubPosts.push(body);
      return { id: 1000 + githubPosts.length, created_at: new Date().toISOString() };
    },
  };
  let messageId = 0;
  const ws = new Proxy({}, { get: () => async () => ({ id: (messageId += 1) }) });
  const dm = new Proxy({
    async recordRequester() { return { userId: ada.id, username: 'ada', firstVersion: false }; },
    async requesterOf() { return { userId: ada.id, username: 'ada', firstVersion: false }; },
    async overWeeklyAllowance() { return false; },
    hasBot: () => false,
  }, { get: (target, key) => (key in target ? target[key] : (key === 'then' ? undefined : async () => null)) });
  const verdict = { verdict: 'ready', build_note: 'Add a dark theme toggle to the header.', reason: 'Small and clear.' };
  const deps = {
    github, ws, dm, domain: 'example.test', sessionLifecycle: {}, notifications: null,
    worker: {
      async ensureWorkerImage() {}, async ensureWorker() { return 'w'; },
      async execInWorker() { turns.push(Date.now()); return { lastResultText: `\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\`` }; },
      isInFlight: () => false, async clearActiveTurn() {}, async stopTurn() {},
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    limits: { async checkBudget() { return { ok: true }; }, async recordSpend() {} },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    sessions: {
      buildHeadlessSeed: () => 'seed',
      async runCodexAttemptLoop({ dispatchOnce }) { return { result: await dispatchOnce({}), estimatedCostUsd: 0.12 }; },
    },
    activeWorkers: new Set(),
  };
  const settings = { mode: 'shadow', turnSeconds: 60, continueReads: false };
  const queue = async (reason) => (await pool.query(
    `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason)
     VALUES ($1, 24, 2, $2)
     ON CONFLICT (app_id, issue_number) DO UPDATE SET reason = EXCLUDED.reason, started_at = NULL
     RETURNING id, issue_number, reason`,
    [app.id, reason],
  )).rows[0];
  const triage = async (reason) => bot.runTriage(pool, {}, {
    bot: BOT, app, item: await queue(reason), mode: 'shadow', settings, deps,
  });
  const posts = async () => (await pool.query(
    'SELECT kind FROM homeroom_bot_posts WHERE app_id = $1 AND issue_number = 24 ORDER BY id', [app.id],
  )).rows.map((r) => r.kind);
  const runOf = async (id) => (await pool.query('SELECT * FROM homeroom_bot_runs WHERE id = $1', [id])).rows[0];

  // 1. Read with the cap full: a ready verdict, held, and what it read recorded.
  const first = await triage('new');
  assert.equal(first.verdict, 'ready');
  assert.equal(first.acted, 'held');
  assert.equal(turns.length, 1);
  const heldRun = await runOf(first.runId);
  assert.equal(heldRun.cap_suppressed, 'proposals_per_app');
  assert.match(heldRun.read_fingerprint.hash, /^[0-9a-f]{64}$/, 'the read records what it saw');
  assert.equal(heldRun.reused_run_id, null);
  assert.deepEqual(await posts(), ['looking', 'held_proposals_per_app']);
  // What the bot posted since is not a change to the request.
  comments.push({ id: 2, author: 'usernode-bot[bot]', body: 'Held: five proposals are up.', createdAt: '2026-10-10T00:05:00Z' });
  await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref)
     VALUES ($1, $2, 'Held: five proposals are up.', 'message', 'issue', 24)`,
    [app.id, BOT.id],
  );
  issue.updatedAt = '2026-10-10T00:05:01Z';

  // 2. Its turn comes while the cap is full again: reused and held again,
  // with no read, no looking note and no second held note.
  const again = await triage(bot.CAP_FREED_REASON);
  assert.equal(again.reused, first.runId);
  assert.equal(again.acted, 'held');
  assert.equal(turns.length, 1, 'no model turn');
  assert.deepEqual(await posts(), ['looking', 'held_proposals_per_app'], 'nothing said: no looking note, no held note twice');
  const heldAgain = await runOf(again.runId);
  assert.equal(heldAgain.reused_run_id, first.runId);
  assert.equal(heldAgain.read_reason, 'cap_freed');
  assert.equal(heldAgain.cap_suppressed, 'proposals_per_app');
  assert.equal(Number(heldAgain.cost_usd), 0);
  assert.equal(heldAgain.build_note, verdict.build_note);
  assert.equal(heldAgain.read_fingerprint.hash, heldRun.read_fingerprint.hash);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM homeroom_bot_queue')).rows[0].n, 0, 'the queue row is used up');

  // 3. Room at last: reused and built, as a fresh ready verdict is.
  await pool.query(`UPDATE chat_sessions SET status = 'merged' WHERE id = $1`, [capped[0]]);
  const built = await triage(bot.CAP_FREED_REASON);
  assert.equal(built.reused, again.runId);
  assert.equal(built.acted, 'build_queued');
  assert.equal(turns.length, 1, 'still no model turn');
  assert.deepEqual(await posts(), ['looking', 'held_proposals_per_app'], 'no looking note');
  const buildRun = await runOf(built.runId);
  assert.equal(buildRun.cap_suppressed, null);
  assert.ok(buildRun.live_build_waiting_at, 'its build waits its turn in the lane');
  assert.equal(buildRun.build_note, verdict.build_note, 'built from the held verdict\'s note');
  assert.equal(buildRun.reused_run_id, again.runId);

  // 4. Held again, then the request changes: read again, as before.
  await pool.query(`UPDATE chat_sessions SET status = 'promoted' WHERE id = $1`, [capped[0]]);
  await pool.query('UPDATE homeroom_bot_runs SET live_build_waiting_at = NULL WHERE id = $1', [built.runId]);
  const reheld = await triage('new');
  assert.equal(reheld.acted, 'held');
  assert.equal(turns.length, 2);
  await pool.query(`UPDATE chat_sessions SET status = 'merged' WHERE id = $1`, [capped[0]]);
  comments.push({ id: 3, author: 'ada-gh', body: 'And the footer, please.', createdAt: '2026-10-10T01:00:00Z' });
  const changed = await triage(bot.CAP_FREED_REASON);
  assert.equal(turns.length, 3, 'a request that changed is read again');
  assert.equal(changed.reused, undefined);
  assert.equal(changed.acted, 'build_queued');
  assert.equal((await runOf(changed.runId)).reused_run_id, null);
  assert.equal((await runOf(changed.runId)).read_reason, 'cap_freed');
});
