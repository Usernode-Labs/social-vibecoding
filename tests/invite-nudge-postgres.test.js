'use strict';

// The bring-a-friend nudge (src/services/invite-nudge.js) against the REAL
// schema in a throwaway PostgreSQL database: required when TEST_DATABASE_URL
// is set, skipped when no server is reachable.
//
// What this pins:
//   1. A person's first act in ONE project, from the records the admin
//      Journey reads a first act from, narrowed to the project.
//   2. Who is owed a nudge: joined in the last 14 days (a membership, or a
//      private member's redemption), first act there in the last 48 hours;
//      never the maker, a test account, a synthetic account, a service
//      identity or somebody the bot does not work for; one project a person.
//   3. Once per person per project, ever, and one a week across projects.
//   4. The message in their chat with the bot, its buttons, and Not now.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/invite-nudge-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Realtime and push are process-wide singletons the bot's DM sends through.
const pushed = [];
stub(require.resolve('../src/services/ws'), {
  pushConversationEvent: (ids, event) => { pushed.push({ ids, event }); return 1; },
  pushToUser: () => 1, pushNotificationToUser: () => 1,
  sendSystemMessage: async () => ({ id: 1 }), pushIssueUpdate() {},
});
stub(require.resolve('../src/services/mobile-push'), { scheduleBadgeSync() { return false; } });

let pool = null;
require('../src/db/pool').getPool = () => pool;

const nudges = require('../src/services/invite-nudge');
const mayor = require('../src/services/homeroom-bot-mayor');
const { none: inertSteps } = require('../src/services/durable-steps');

test('the bring-a-friend nudge, against the real schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'invite_nudge_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const person = async (username, cols = {}) => {
    const base = { has_platform_access: true, ...cols };
    const keys = Object.keys(base);
    return Number((await one(
      `INSERT INTO users (username, password, ${keys.join(', ')})
       VALUES ($1, 'x', ${keys.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
      [username, ...keys.map((k) => base[k])])).id);
  };
  const bot = await person('homeroom_bot', { is_synthetic: true });
  const maker = await person('maker');
  // The community is the AFTER INSERT trigger's, so it is read back.
  const project = async (slug, { status = 'running', selfHosted = false } = {}) => {
    await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, self_hosted, view_visibility, collab_visibility)
       VALUES ($1, $2, $3, $4, $5, 'public', 'public')`,
      [slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), slug, status, maker, selfHosted]);
    const row = await one('SELECT id, slug, name, community_id FROM apps WHERE slug = $1', [slug]);
    await pool.query(
      `INSERT INTO community_members (community_id, user_id, source, joined_at)
       VALUES ($1, $2, 'creator', NOW() - INTERVAL '1 day') ON CONFLICT (community_id, user_id) DO NOTHING`,
      [row.community_id, maker]);
    return { id: Number(row.id), slug: row.slug, name: row.name, communityId: Number(row.community_id) };
  };
  const join = (app, userId, { days = 2, source = 'joined' } = {}) => pool.query(
    `INSERT INTO community_members (community_id, user_id, source, joined_at)
     VALUES ($1, $2, $3, NOW() - make_interval(days => $4::int))
     ON CONFLICT (community_id, user_id) DO UPDATE SET joined_at = EXCLUDED.joined_at, source = EXCLUDED.source`,
    [app.communityId, userId, source, days]);
  const ago = (hours) => `${Number(hours)} hours`;
  const act = {
    message: (app, userId, hours, { deleted = false, type = 'message' } = {}) => pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, created_at, deleted_at)
       VALUES ($1, $2, 'Hello', $3, NOW() - $4::interval, CASE WHEN $5::boolean THEN NOW() END)`,
      [app.id, userId, type, ago(hours), deleted]),
    change: async (app, userId, hours) => Number((await one(
      `INSERT INTO chat_sessions (app_id, user_id, created_at) VALUES ($1, $2, NOW() - $3::interval) RETURNING id`,
      [app.id, userId, ago(hours)])).id),
    request: async (app, userId, hours) => Number((await one(
      `INSERT INTO issues (app_id, title, created_by, created_at) VALUES ($1, 'A wish', $2, NOW() - $3::interval) RETURNING id`,
      [app.id, userId, ago(hours)])).id),
    voteChange: async (app, userId, hours) => {
      const session = await act.change(app, maker, 100);
      await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote, created_at) VALUES ($1, $2, 'yes', NOW() - $3::interval)`,
        [session, userId, ago(hours)]);
    },
    voteRequest: async (app, userId, hours) => {
      const issue = await act.request(app, maker, 100);
      await pool.query(`INSERT INTO issue_votes (issue_id, user_id, vote, created_at) VALUES ($1, $2, 'up', NOW() - $3::interval)`,
        [issue, userId, ago(hours)]);
    },
    app: (app, userId, days) => pool.query(
      `INSERT INTO app_activity (app_id, user_id, seconds_spent, date) VALUES ($1, $2, 60, CURRENT_DATE - $3::int)`,
      [app.id, userId, days]),
  };

  const runClub = await project('run-club');
  const bookSwap = await project('book-swap');
  const stopped = await project('old-thing', { status: 'stopped' });
  const platform = await project('homeroom-own', { selfHosted: true });

  await t.test('the first act in one project, from the records the Journey reads', async () => {
    const pia = await person('pia');
    await join(runClub, pia);
    await act.app(runClub, pia, 3);
    await act.message(runClub, pia, 24);
    await act.message(bookSwap, pia, 1);
    const first = await nudges.firstActIn(pool, { userId: pia, appId: runClub.id });
    assert.equal(first.kind, 'app', 'the day they used its app, three days before the message');
    assert.equal((await nudges.firstActIn(pool, { userId: pia, appId: bookSwap.id })).kind, 'message', 'each project its own');
    assert.equal(await nudges.firstActIn(pool, { userId: pia, appId: stopped.id }), null, 'nothing done there');

    const quin = await person('quin');
    await act.message(runClub, quin, 5, { deleted: true });
    await act.message(runClub, quin, 4, { type: 'system' });
    assert.equal(await nudges.firstActIn(pool, { userId: quin, appId: runClub.id }), null, 'a deleted message, or not a message, is no act');
    await act.voteChange(runClub, quin, 2);
    assert.equal((await nudges.firstActIn(pool, { userId: quin, appId: runClub.id })).kind, 'vote');
    const rui = await person('rui');
    await act.voteRequest(runClub, rui, 3);
    await act.request(runClub, rui, 1);
    assert.equal((await nudges.firstActIn(pool, { userId: rui, appId: runClub.id })).kind, 'vote', 'a vote on a request, before their own');
    const sol = await person('sol');
    await act.request(runClub, sol, 2);
    assert.equal((await nudges.firstActIn(pool, { userId: sol, appId: runClub.id })).kind, 'request');
    const tam = await person('tam');
    await act.change(runClub, tam, 1);
    assert.equal((await nudges.firstActIn(pool, { userId: tam, appId: runClub.id })).kind, 'change');
    // Somebody else's acts there are not theirs.
    assert.equal(await nudges.firstActIn(pool, { userId: tam, appId: bookSwap.id }), null);
  });

  const ids = async () => new Map((await nudges.due(pool)).map((d) => [d.userId, d]));

  await t.test('who is owed one: new, a fresh first act, and somebody the bot works for', async () => {
    const usernameOf = async (id) => (await one('SELECT username FROM users WHERE id = $1', [id])).username;
    const named = async () => {
      const out = {};
      for (const [id, d] of await ids()) out[await usernameOf(id)] = [d.appId, d.act];
      return out;
    };
    for (const n of ['quin', 'rui', 'sol', 'tam']) {
      const id = Number((await one('SELECT id FROM users WHERE username = $1', [n])).id);
      await join(runClub, id);
    }
    const uma = await person('uma');
    await join(runClub, uma, { days: 13 });
    await act.message(runClub, uma, 47);
    // Joined too long ago, and a first act too long ago.
    const vic = await person('vic');
    await join(runClub, vic, { days: 15 });
    await act.message(runClub, vic, 1);
    // pia's first act in Run Club was three days ago; she joined nothing else yet.
    // Never asked: the maker, a test account, a synthetic account, a service
    // identity, somebody not let in, and anybody restricted or anonymised.
    await act.message(runClub, maker, 1);
    const tester = await person('tester_1', { test_account_created_at: new Date() });
    const demo = await person('demo_partner', { is_synthetic: true });
    const capture = await person('usernode-capture');
    const waiting = await person('waiting', { has_platform_access: false });
    const muted = await person('muted', { participation_restricted_at: new Date() });
    for (const id of [tester, demo, capture, waiting, muted]) {
      await join(runClub, id);
      await act.message(runClub, id, 1);
    }
    // Neither a project that is not running nor the platform's own community.
    const wes = await person('wes');
    for (const app of [stopped, platform]) { await join(app, wes); await act.message(app, wes, 1); }
    assert.deepEqual(await named(), {
      quin: [runClub.id, 'vote'], rui: [runClub.id, 'vote'], sol: [runClub.id, 'request'], tam: [runClub.id, 'change'],
      uma: [runClub.id, 'message'],
    });
  });

  await t.test('a private member is owed one too, joined by the redemption that let them in', async () => {
    const pm = await person('pm', { has_platform_access: false, private_member_since: new Date() });
    // A membership row from before, and the redemption applied two days ago.
    await join(bookSwap, pm, { days: 30 });
    await act.message(bookSwap, pm, 2);
    assert.equal((await ids()).has(pm), false, 'the membership alone is too old');
    const invite = await one(
      `INSERT INTO community_invites (token, community_id, app_id, created_by, expires_at)
       VALUES ('tok-pm', $1, $2, $3, NOW() + INTERVAL '7 days') RETURNING id`, [bookSwap.communityId, bookSwap.id, maker]);
    await pool.query(
      `INSERT INTO community_invite_redemptions (invite_id, user_id, status, applied_at)
       VALUES ($1, $2, 'joined', NOW() - INTERVAL '2 days')`, [invite.id, pm]);
    assert.deepEqual([(await ids()).get(pm)?.appId, (await ids()).get(pm)?.act], [bookSwap.id, 'message']);
  });

  await t.test('one project a person: their most recent first act', async () => {
    const xia = await person('xia');
    await join(runClub, xia); await act.message(runClub, xia, 20);
    await join(bookSwap, xia); await act.request(bookSwap, xia, 3);
    const owed = (await nudges.due(pool)).filter((d) => d.userId === xia);
    assert.deepEqual(owed.map((d) => [d.appId, d.act]), [[bookSwap.id, 'request']]);
  });

  const steps = () => inertSteps();
  const uma = Number((await one('SELECT id FROM users WHERE username = $1', ['uma'])).id);
  let nudge = null;

  // 14 Nov 2026: the nudge is a bell row (kind `invite_nudge`), not a message
  // in Main Chat, which is gone. No chat message, no card, no push.
  await t.test('nudged once: a bell row for the project, no chat message, and never again for that project', async () => {
    const before = Number((await one('SELECT COUNT(*) AS n FROM notifications')).n);
    const messagesBefore = Number((await one('SELECT COUNT(*) AS n FROM conversation_messages')).n);
    const sent = await nudges.nudge(pool, { userId: uma, appId: runClub.id }, steps());
    assert.equal(sent.said, 'sent');
    nudge = await one('SELECT * FROM invite_nudges WHERE user_id = $1 AND app_id = $2', [uma, runClub.id]);
    assert.equal(nudge.act, 'message');
    assert.ok(nudge.sent_at && Number(nudge.notification_id) === Number(sent.notificationId));
    assert.deepEqual([nudge.card_id, nudge.message_id], [null, null], 'no card and no message');
    const row = await one('SELECT * FROM notifications WHERE id = $1', [nudge.notification_id]);
    assert.deepEqual(
      [row.kind, row.detail, Number(row.user_id), Number(row.app_id), Number(row.source_user_id), row.conversation_id,
        row.conversation_message_id, row.read_at],
      ['invite_nudge', 'message', uma, runClub.id, bot, null, null, null]);
    assert.equal(Number((await one('SELECT COUNT(*) AS n FROM notifications')).n), before + 1, 'one bell row');
    assert.equal(Number((await one('SELECT COUNT(*) AS n FROM conversation_messages')).n), messagesBefore, 'nothing is said in the chat');
    assert.equal(Number((await one(`SELECT COUNT(*) AS n FROM bot_cards WHERE user_id = $1 AND kind = 'invite_friends'`, [uma])).n), 0);
    assert.equal(Number((await one(`SELECT COUNT(*) AS n FROM mobile_push_kind_categories WHERE kind = 'invite_nudge'`)).n), 0,
      'it wakes no phone, as the message rang nothing');
    // The bell lists it, under its project.
    const listed = await require('../src/services/notifications').listForUser(pool, uma, {});
    const mine = (listed.items || listed).find((n) => n.kind === 'invite_nudge');
    assert.deepEqual([mine.detail, mine.app_slug, mine.app_name], ['message', 'run-club', 'Run Club']);
    // The send again (a retried step) rings nothing twice.
    assert.deepEqual(await nudges.send(pool, { nudgeId: nudge.id, userId: uma, appId: runClub.id, act: 'message', slug: 'run-club', name: 'Run Club' }),
      { said: 'sent', notificationId: Number(nudge.notification_id) });
    assert.equal(Number((await one('SELECT COUNT(*) AS n FROM notifications')).n), before + 1);
    // Once per project, ever: asked again, nothing; the sweep no longer lists them.
    assert.deepEqual(await nudges.nudge(pool, { userId: uma, appId: runClub.id }, steps()), { skipped: 'not_due' });
    assert.equal((await ids()).has(uma), false);
    assert.equal(Number((await one('SELECT COUNT(*) AS n FROM invite_nudges WHERE user_id = $1', [uma])).n), 1);
  });

  await t.test('two claims at once for one person: one nudge', async () => {
    const sol = Number((await one('SELECT id FROM users WHERE username = $1', ['sol'])).id);
    const deps = { settings: await require('../src/services/homeroom-bot').readSettings(pool) };
    const both = await Promise.all([1, 2].map(() => nudges.claim(pool, { userId: sol, appId: runClub.id, deps })));
    assert.equal(both.filter((c) => c.nudgeId).length, 1);
    assert.deepEqual(both.filter((c) => !c.nudgeId), [{ skipped: 'not_due' }]);
    assert.equal(Number((await one('SELECT COUNT(*) AS n FROM invite_nudges WHERE user_id = $1', [sol])).n), 1);
    // The claim rings nothing: its bell row is the send's.
    assert.equal(Number((await one(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1 AND kind = 'invite_nudge'`, [sol])).n), 0);
  });

  await t.test('one a week across projects', async () => {
    const xia = Number((await one('SELECT id FROM users WHERE username = $1', ['xia'])).id);
    assert.equal((await nudges.nudge(pool, { userId: xia, appId: bookSwap.id }, steps())).said, 'sent');
    // Run Club is owed too, but not this week.
    assert.equal((await ids()).has(xia), false);
    assert.deepEqual(await nudges.nudge(pool, { userId: xia, appId: runClub.id }, steps()), { skipped: 'not_due' });
    // A week on (its first act there kept fresh), Run Club's turn comes.
    await pool.query(`UPDATE invite_nudges SET created_at = NOW() - INTERVAL '8 days' WHERE user_id = $1`, [xia]);
    assert.deepEqual([(await ids()).get(xia)?.appId], [runClub.id]);
    assert.equal((await nudges.nudge(pool, { userId: xia, appId: runClub.id }, steps())).said, 'sent');
  });

  // A nudge sent as a chat card, before nudges moved to the bell, keeps its
  // Not now: the card and its message written as that send wrote them.
  await t.test('Not now on a nudge sent as a chat card before: decided once, recorded, and never asked again', async () => {
    const dmSvc = require('../src/services/homeroom-bot-dm');
    const botUser = await dmSvc.botAccount(pool);
    const old = await dmSvc.sendDm(pool, {
      bot: botUser, userId: uma, content: dmSvc.inviteNudgeText({ act: 'message', appName: 'Run Club' }),
      idempotencyKey: `hrbot-invite-nudge-${nudge.id}`,
      metadata: dmSvc.inviteNudgeMeta({ slug: 'run-club', appName: 'Run Club', act: 'message', actionId: null }),
      card: {
        kind: dmSvc.INVITE_NUDGE_KIND, appId: runClub.id, title: 'Invite friends to Run Club',
        onInsert: (db, { cardId }) => db.query('UPDATE invite_nudges SET card_id = $2 WHERE id = $1', [nudge.id, cardId]),
      },
    });
    await pool.query('UPDATE invite_nudges SET message_id = $2 WHERE id = $1', [nudge.id, old.messageId]);
    nudge = await one('SELECT * FROM invite_nudges WHERE id = $1', [nudge.id]);
    const card = Number(nudge.card_id);
    assert.ok(card > 0);
    const user = { id: uma };
    const deps = { ws: { pushConversationEvent: (ids, event) => { pushed.push({ ids, event }); return 1; } } };
    assert.deepEqual(await mayor.decideOfferTap(pool, {}, { user, actionId: card, choice: 'yes', deps }),
      { ok: false, status: 400, error: 'choice must be no', code: 'no_such_choice' }, 'Invite people is the device\'s');
    assert.deepEqual(await mayor.decideOfferTap(pool, {}, { user: { id: maker }, actionId: card, choice: 'no', deps }),
      { ok: false, status: 404, error: 'No such choice', code: 'no_such_offer' }, 'only theirs');
    const out = await mayor.decideOfferTap(pool, {}, { user, actionId: card, choice: 'no', deps });
    assert.deepEqual(out, { ok: true, choice: 'no', label: 'Not now' });
    assert.equal((await one('SELECT status FROM bot_cards WHERE id = $1', [card])).status, 'declined');
    assert.ok((await one('SELECT dismissed_at FROM invite_nudges WHERE id = $1', [nudge.id])).dismissed_at);
    const meta = (await one('SELECT metadata FROM conversation_messages WHERE id = $1', [nudge.message_id])).metadata.homeroomBot;
    assert.deepEqual([meta.status, meta.answer, meta.chosen], ['answered', 'Not now', 'no']);
    assert.ok(pushed.some((p) => p.event.type === 'conversation_message_updated' && Number(p.event.messageId) === Number(nudge.message_id)));
    // A second tap, here or on another device: decided already.
    const again = await mayor.decideOfferTap(pool, {}, { user, actionId: card, choice: 'no', deps });
    assert.deepEqual([again.ok, again.status, again.error], [false, 409, 'already_decided']);
    // Weeks on, still never asked again for Run Club.
    await pool.query(`UPDATE invite_nudges SET created_at = NOW() - INTERVAL '30 days' WHERE id = $1`, [nudge.id]);
    await act.message(runClub, uma, 1);
    assert.equal((await ids()).has(uma), false);
  });

  await t.test('somebody who blocked the bot: nothing rings, and they are not asked again', async () => {
    const tam = Number((await one('SELECT id FROM users WHERE username = $1', ['tam'])).id);
    // Claimed while the bot still worked for them; blocked before the send.
    const settings = await require('../src/services/homeroom-bot').readSettings(pool);
    const claimed = await nudges.claim(pool, { userId: tam, appId: runClub.id, deps: { settings } });
    assert.ok(claimed.nudgeId);
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)', [tam, bot]);
    const sent = await nudges.send(pool, claimed);
    assert.deepEqual(sent, { said: 'not_sent' });
    const row = await one('SELECT * FROM invite_nudges WHERE user_id = $1', [tam]);
    assert.deepEqual([row.sent_at, row.notification_id, row.card_id], [null, null, null]);
    assert.equal(Number((await one(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1 AND kind = 'invite_nudge'`, [tam])).n), 0);
    assert.equal((await ids()).has(tam), false);
  });
});
