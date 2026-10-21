'use strict';

// Homeroom bot's older requests and the requests it promised (16 Oct 2026),
// against the full PostgreSQL schema and through the bot's own refresh.
//
// - A request the bot found ready and holds only for a free slot is one it
//   is on (#4190): a claim made after that does not keep it off. #5169 was
//   claimed ten hours after the bot told its requester it would build it,
//   and was kept from the bot for good.
// - When a person does take on a request the bot had promised, the
//   requester is told once.
// - What was parked when the bot went on for everyone (9 Oct 2026) is read
//   one at a time, while the project has a free slot and nothing in the
//   bot's queue: the ones its trial run found ready first.
// - The slots page lists every other open request by where the bot is on it.
//
// The queue is the bot-request machine's projection: a runtime of the bot's
// two machines (its work faked, the bot off so the lane grants nothing)
// applies what the refresh appends, and a look's end is its NotOwed.
//
// Skips when no PostgreSQL is reachable, like the repository's other
// postgres tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const bot = require('../src/services/homeroom-bot');
const holds = require('../src/services/homeroom-bot-holds');
const track = require('../src/services/homeroom-bot-track');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const requestMachine = require('../src/workflow/bot-request/machine.ts');
const laneMachine = require('../src/workflow/bot-lane/machine.ts');
const { TURN_STOP } = require('../src/workflow/rules/turn-stop.ts');

function botLoop(pool) {
  const kinds = [...Object.values(requestMachine.WORK), ...Object.values(laneMachine.WORK), TURN_STOP];
  const services = Object.fromEntries(kinds.map((k) => [k, {
    maxAttempts: 1, backoffMs: () => 0, leaseMs: 600, concurrency: 4, async run() { return { outcome: 'done' }; },
  }]));
  return createRuntime({
    pool, pollMs: 50, publish: async () => {}, services,
    machines: [requestMachine.botRequest({ staging: false }), laneMachine.botLane({ staging: false })],
  });
}

async function openDatabase(t) {
  let pg;
  try { pg = require('pg'); } catch { t.skip('the pg driver is not installed'); return null; }
  const admin = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 3000, max: 1 });
  try {
    await admin.query('SELECT 1');
  } catch (err) {
    await admin.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip(`no postgres reachable at ${DSN}: ${err.message}`);
    return null;
  }
  const name = `hrbot_older_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: String(url), max: 8 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  return pool;
}

const day = 24 * 60 * 60 * 1000;
const EVERYONE = new Date(Date.now() - 7 * day).toISOString();
const before = (days) => new Date(Date.parse(EVERYONE) - days * day).toISOString();
const after = (days) => new Date(Date.parse(EVERYONE) + days * day).toISOString();

test('the bot keeps its promises and reads its older requests, one at a time', { timeout: 180000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;
  const rt = botLoop(pool);
  t.after(() => rt.stop());

  const { rows: [botUser] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username`,
  );
  const person = async (name) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`, [name],
  )).rows[0];
  const evan = await person('evan');
  const maya = await person('maya');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Plant Pal', 'plant-pal', 'running', $1, 'https://github.com/usernode-bot/plant-pal', 'public', 'public')
     RETURNING id, slug, name, repo_url`,
    [evan.id],
  );
  const run = async (n, { mode = 'live', verdict = 'ready', cap = null, ago = '1 hour', seen = null } = {}) => (await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, cap_suppressed, thread_seen_at, duration_ms, created_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($7::timestamptz, NOW() - $6::interval), 60000, NOW() - $6::interval) RETURNING id`,
    [app.id, n, mode, verdict, cap, ago, seen],
  )).rows[0].id;
  const claim = (n, ago) => pool.query(
    `INSERT INTO issue_claims (app_id, github_issue_number, user_id, claimed_at) VALUES ($1, $2, $3, NOW() - $4::interval)`,
    [app.id, n, maya.id, ago],
  );
  const asked = (n, user, title) => pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, $2, $3, $4)`,
    [app.id, n, user.id, title],
  );

  await t.test('a request held for a slot is one the bot is on: a later claim does not keep it off', async () => {
    // #10: found ready ten hours ago, held for a slot; maya claimed it since.
    await run(10, { cap: 'proposals_per_app', ago: '10 hours' });
    await claim(10, '1 hour');
    // #11: maya claimed it before the bot read it.
    await claim(11, '12 hours');
    await run(11, { cap: 'proposals_per_app', ago: '10 hours' });
    // #12: held, then read again since (a question): the hold is over, and
    // a claim made after the hold is an ordinary one again.
    await run(12, { cap: 'proposals_per_app', ago: '10 hours' });
    await run(12, { verdict: 'question', ago: '5 hours' });
    await claim(12, '1 hour');
    const holders = await bot.issueHolders(pool, app.id);
    assert.equal(holders.has(10), false, 'claimed after the bot promised it: the bot keeps it');
    assert.deepEqual(holders.get(11)?.map((h) => h.kind), ['claim'], 'claimed first: still a hold');
    assert.deepEqual(holders.get(12)?.map((h) => h.kind), ['claim'], 'the promise was over: a hold');
  });

  await t.test('a requester is told once when a person takes on what the bot promised', async () => {
    // #20: evan asked; the bot found it ready and holds it for a slot; maya
    // has a change of her own on it now.
    await asked(20, evan, 'Frost alerts');
    const promise = await run(20, { cap: 'proposals_per_app', ago: '2 hours' });
    await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, linked_issues) VALUES ($1, $2, 'dev/maya-frost', 'active', ARRAY[20])`,
      [app.id, maya.id],
    );
    // #21: evan's, held too, but evan took it on himself: nobody to tell.
    await asked(21, evan, 'Water log');
    await run(21, { cap: 'proposals_per_app', ago: '2 hours' });
    await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, linked_issues) VALUES ($1, $2, 'dev/evan-water', 'active', ARRAY[21])`,
      [app.id, evan.id],
    );
    const holders = await bot.issueHolders(pool, app.id);
    assert.deepEqual(holders.get(20)?.map((h) => [h.kind, h.username]), [['session', 'maya']]);
    const sent = [];
    const dm = { async sendDm(_pool, msg) { sent.push(msg); return { duplicate: false, messageId: 1 }; } };
    const tray = { noteWorkChanged() {} };
    const told = await holds.tellTaken(pool, { app, bot: botUser, holders, deps: { dm, tray } });
    assert.equal(told, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].userId, evan.id);
    assert.equal(sent[0].metadata.kind, 'request_taken');
    assert.equal(sent[0].metadata.takenBy, 'maya');
    assert.equal(sent[0].idempotencyKey, holds.takenKey(app.id, 20, evan.id, promise));
    assert.match(sent[0].content, /^“Frost alerts”: @maya has taken it on, so I'm leaving it to them\./);

    // Once sent, the refresh does not try again: the message is found by its key.
    const { rows: [conv] } = await pool.query(`INSERT INTO conversations (kind) VALUES ('direct') RETURNING id`);
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, status) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
      [conv.id, evan.id, botUser.id],
    );
    await pool.query(
      `INSERT INTO conversation_messages (conversation_id, sender_id, content, idempotency_key) VALUES ($1, $2, 'x', $3)`,
      [conv.id, botUser.id, sent[0].idempotencyKey],
    );
    sent.length = 0;
    assert.equal(await holds.tellTaken(pool, { app, bot: botUser, holders, deps: { dm, tray } }), 0);
    assert.equal(sent.length, 0);
  });

  // The older requests. Filed before the bot went on for everyone, all of them.
  const issues = [
    { number: 30, title: 'Sort by name', body: 'Sort the plants by name.', createdAt: before(10), updatedAt: before(9) },
    { number: 31, title: 'Never read', body: 'A request nobody read.', createdAt: before(4), updatedAt: before(4) },
    { number: 32, title: 'A decision', body: 'Should we?', createdAt: before(2), updatedAt: before(2) },
    { number: 33, title: 'Claimed by maya', body: 'Mine.', createdAt: before(3), updatedAt: before(3) },
    { number: 34, title: 'Ready too, older', body: 'Ready.', createdAt: before(20), updatedAt: before(20) },
    // Filed since: read as new.
    { number: 35, title: 'Brand new', body: 'Just filed.', createdAt: after(5), updatedAt: after(5) },
  ].map((issue) => ({ state: 'open', ...issue }));
  const github = {
    async fetchPublicIssues() { return { issues: issues.map((i) => ({ ...i })), truncatedList: false }; },
    async getIssue() { return null; },
  };
  const settings = { mode: 'live', pausedApps: [], everyoneSince: EVERYONE, voiceSession: true, voiceIssue: true };
  const room = { proposals_per_app: 3, proposals_total: 20, question_tripwire: 10 };
  const dm = { async recordRequester() { return null; }, async sendDm() { return null; } };
  const refresh = async (capRoom = room) => {
    const out = await bot.refreshApp(pool, app, { github, capRoom, bot: botUser, everyoneSince: EVERYONE, settings, dm });
    await rt.drain();
    return out;
  };
  const queued = async () => (await pool.query(
    'SELECT issue_number, reason, priority FROM homeroom_bot_queue WHERE app_id = $1 ORDER BY issue_number', [app.id],
  )).rows.map((r) => `${r.issue_number}:${r.reason}:${r.priority}`);
  // A look at each request still queued ended: nothing is owed it now.
  let looks = 0;
  const lookedAt = async () => {
    const { rows } = await pool.query('SELECT issue_number FROM homeroom_bot_queue WHERE app_id = $1', [app.id]);
    for (const r of rows) {
      await rt.append(requestMachine.MACHINE, requestMachine.requestKey(app.id, r.issue_number), {
        type: 'NotOwed', payload: { appId: app.id, issueNumber: Number(r.issue_number), quiet: false },
      }, { requestKey: `looked:${++looks}`, source: { kind: 'system', name: 'test' } });
    }
    await rt.drain();
  };

  await t.test('older requests: the trial run\'s ready ones first, then the rest, newest first', async () => {
    // What the trial run made of them, before the bot went on for everyone.
    await run(30, { mode: 'shadow', verdict: 'ready', seen: before(9), ago: '20 days' });
    await run(34, { mode: 'shadow', verdict: 'ready', seen: before(20), ago: '25 days' });
    await run(32, { mode: 'shadow', verdict: 'person', seen: before(2), ago: '10 days' });
    await claim(33, '1 hour');
    const older = await bot.backlogFor(pool, app, { issues, settings });
    assert.deepEqual(older.map((p) => p.n), [30, 34, 31, 32], 'ready ones newest first, then never read, then the rest; never a claimed one');
    assert.deepEqual(older.map((p) => p.trial), ['ready', 'ready', null, 'person']);
  });

  await t.test('the refresh reads them one at a time, only when nothing else waits and a slot is free', async () => {
    // A new request goes first, as ever: no older one beside it.
    await refresh();
    assert.deepEqual(await queued(), ['35:new:1']);
    // Read since, its row gone: nothing new to read, so the first older one.
    await run(35, { verdict: 'question', ago: '1 minute', seen: after(6) });
    await lookedAt();
    await refresh();
    assert.deepEqual(await queued(), ['30:backlog:4']);
    // Kept while it waits, and no second one beside it.
    await refresh();
    assert.deepEqual(await queued(), ['30:backlog:4']);
    // Read (it needs a person after all): the next is the other ready one.
    await run(30, { verdict: 'person', ago: '1 minute', seen: before(9) });
    await lookedAt();
    await refresh();
    assert.deepEqual(await queued(), ['34:backlog:4']);
    // No free slot: nothing older is read.
    await lookedAt();
    await refresh({ ...room, proposals_per_app: 0 });
    assert.deepEqual(await queued(), []);
    // A project the bot only tries things on (no capRoom) reads everything
    // in the background, as before: nothing is an older request there.
    await bot.refreshApp(pool, app, { github, capRoom: null, bot: botUser, everyoneSince: EVERYONE, settings, dm });
    await rt.drain();
    assert.ok(!(await queued()).some((row) => row.includes(':backlog:')));
    await lookedAt();
  });

  await t.test('an older request\'s read is nobody\'s building time and says nothing first', async () => {
    assert.equal(bot.BACKLOG_REASON, 'backlog');
    assert.ok(bot.KEPT_WHILE_QUIET_REASONS.includes('backlog'));
    assert.deepEqual(bot.billingOf({ reason: 'backlog', payer_user_id: evan.id }, 'live'), { charged: false, payerUserId: evan.id });
    assert.deepEqual(bot.billingOf({ reason: 'new', payer_user_id: evan.id }, 'live'), { charged: true, payerUserId: evan.id });
  });

  await t.test('the slots page: every other open request, by where the bot is on it', async () => {
    // #31 still waits its turn; #32 too (its trial said a person); #34 is next.
    // #36: read live, needs a person. #37: read live, a question for its requester.
    issues.push({ state: 'open', number: 36, title: 'Pick a colour', body: 'Which blue?', createdAt: after(1), updatedAt: after(1) });
    issues.push({ state: 'open', number: 37, title: 'Which page?', body: 'The list page.', createdAt: after(1), updatedAt: after(1) });
    await run(36, { verdict: 'person', ago: '3 hours', seen: after(1) });
    await run(37, { verdict: 'question', ago: '2 hours', seen: after(1) });
    await rt.append(requestMachine.MACHINE, requestMachine.requestKey(app.id, 34), {
      type: 'Owed', payload: { appId: app.id, issueNumber: 34, reason: 'backlog', priority: 4 },
    }, { requestKey: 'backlog:34', source: { kind: 'system', name: 'refresh' } });
    await rt.drain();
    const view = await track.slotsView(pool, {
      app, settings, deps: { github, liveSvc: { isLiveFor: () => true } },
    });
    assert.deepEqual(view.upNext.map((e) => [e.issueNumber, e.kind, e.position ?? null, e.trial ?? null]), [
      [34, 'queued', null, null],
      [31, 'older', 1, null],
      [32, 'older', 2, 'person'],
    ], 'what waits in the queue, then the older ones in the bot\'s order');
    assert.equal(view.upNext[1].title, 'Never read');
    assert.equal(view.upNext[1].excerpt, 'A request nobody read.');
    assert.deepEqual(view.waitingOn.map((e) => [e.issueNumber, e.track.why]), [[35, 'question'], [37, 'question']]);
    assert.deepEqual(view.leftToPeople.map((e) => [e.issueNumber, e.track.why]), [[30, 'needs_person'], [36, 'needs_person']]);
    // #33 maya claimed: hers, counted only.
    assert.equal(view.withPeople, 1);
    // #30, read live since, needs a person too.
    assert.deepEqual(view.leftToPeople.map((e) => e.issueNumber), [30, 36]);
    const trial = await track.tracksForRequests(pool, { appId: app.id, numbers: [31, 32] });
    assert.equal(trial.size, 0, 'a request only the trial run read has no track');
  });
});
