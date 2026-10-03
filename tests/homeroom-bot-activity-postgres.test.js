'use strict';

// #3736: activity cards in the Homeroom bot's DM, against the full
// PostgreSQL schema and through the real route.
//
//   - LIFECYCLE: starting work sends the requester one card in their DM with
//     the bot (live, to their sockets), and that card then reads its state
//     from the bot's records as they move: reading the request, writing the
//     plan, building it, and ended in a proposal up for a vote (then live).
//     The next look at the same request is a card of its own; the one before
//     it keeps what it came to.
//   - SCOPING: the signed-in person's cards and nobody else's, whatever the
//     request asks for, and never one on an app they can no longer view.
//   - the staging demo's two cards, in the viewer's own fixture only.
//
// tests/homeroom-bot-activity.test.js pins the pure rules and the client.
// Skips when no PostgreSQL is reachable, like the repository's other
// postgres tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const events = [];
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds, payload) { events.push({ memberIds: [...memberIds], payload }); return memberIds.length; },
    pushToUser() { return 1; },
    pushNotificationToUser() { return 1; },
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};

let routePool = null;
const poolMod = require('../src/db/pool');
poolMod.getPool = () => routePool;

const activity = require('../src/services/homeroom-bot-activity');
const homeroomBot = require('../src/services/homeroom-bot');
const conversations = require('../src/services/conversations');
const { conversationRoutes } = require('../src/routes/conversations');

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
  const name = `hrbot_activity_${crypto.randomBytes(6).toString('hex')}`;
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

test('the Homeroom bot DM\'s activity cards: one per piece of work, read from its records, the viewer\'s own', { timeout: 120000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;
  routePool = pool;

  let seq = 0;
  async function user(prefix, { synthetic = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic)
       VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
      [synthetic ? prefix : `${prefix}_${++seq}`, synthetic],
    );
    return rows[0];
  }
  async function setting(key, value) {
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  }
  async function project(slug, owner, { visibility = 'public' } = {}) {
    const { rows: [inserted] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
       VALUES ($1, $2, 'running', $3, $4, $5, $5) RETURNING id`,
      [slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), slug, owner.id,
        `https://github.com/usernode-bot/${slug}`, visibility],
    );
    const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [inserted.id]);
    return app;
  }

  const bot = await user('homeroom_bot', { synthetic: true });
  const ada = await user('ada');
  const sam = await user('sam');
  const lee = await user('lee');
  const seeds = await project('seed-swap', ada);
  const samsApp = await project('sam-shop', sam);
  const hidden = await project('hidden-lab', sam, { visibility: 'private' });
  await setting('homeroom_bot_mode', 'shadow');
  await setting('homeroom_bot_dm_users', JSON.stringify([ada.username, sam.username]));
  await setting('homeroom_bot_live_apps', JSON.stringify(['seed-swap', 'sam-shop', 'hidden-lab']));
  const settings = await homeroomBot.readSettings(pool);

  await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES
       ($1, 3, $4, 'Sort by date'), ($1, 4, $4, 'Dark mode'), ($1, 5, $4, 'Export'),
       ($2, 9, $5, 'Sam''s secret'), ($3, 2, $4, 'Hidden thing'), ($1, 6, $6, 'Lee''s idea')`,
    [seeds.id, samsApp.id, hidden.id, ada.id, sam.id, lee.id],
  );
  const requester = (who, title) => ({ userId: who.id, username: who.username, issueTitle: title, firstVersion: false });
  async function claim(app, issueNumber) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, started_at)
       VALUES ($1, $2, 1, 'new', NOW()) RETURNING id`,
      [app.id, issueNumber],
    );
    return row.id;
  }
  async function run(app, issueNumber, fields) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_session_id)
       VALUES ($1, $2, 'live', $3, $4) RETURNING id`,
      [app.id, issueNumber, fields.verdict, fields.buildSessionId || null],
    );
    return row.id;
  }
  const asAda = { id: ada.id, username: ada.username, isAdmin: false };
  const asSam = { id: sam.id, username: sam.username, isAdmin: false };
  const cardsOf = async (who) => (await activity.cardsFor(pool, { user: who, settings })).cards;
  const byId = async (who, id) => (await cardsOf(who)).find((card) => card.messageId === id);

  let first;
  await t.test('starting work sends the requester one card, live, quoting nothing they did not start here', async () => {
    const job = await claim(seeds, 3);
    const from = events.length;
    first = await activity.startCard(pool, {
      app: seeds, issueNumber: 3, requester: requester(ada, 'Sort by date'), bot, jobKey: job, settings,
    });
    assert.ok(first?.messageId, 'sent');
    const message = await conversations.getMessage(pool, asAda, first.conversationId, first.messageId);
    assert.equal(message.sender.id, bot.id);
    assert.deepEqual(message.metadata.homeroomBot, {
      kind: 'activity', appSlug: 'seed-swap', appName: 'Seed swap', issueNumber: 3, issueTitle: 'Sort by date', mirrors: true,
    });
    assert.match(message.content, /^\*\*Seed swap\*\* · request #3: Sort by date\n\nI'm working on this now\./);
    assert.equal(message.reply, null);
    assert.ok(events.slice(from).some((e) => e.payload.type === 'conversation_message_created'
      && e.payload.messageId === first.messageId && e.memberIds.includes(ada.id)), 'it reaches their open DM at once');

    const again = await activity.startCard(pool, {
      app: seeds, issueNumber: 3, requester: requester(ada, 'Sort by date'), bot, jobKey: job, settings,
    });
    assert.equal(again.messageId, first.messageId, 'the same piece of work started again keeps its card');
    assert.equal(again.duplicate, true);
    const { rows } = await pool.query(`SELECT kind FROM homeroom_bot_dm_messages WHERE user_id = $1`, [ada.id]);
    assert.deepEqual(rows.map((r) => r.kind), ['activity'], 'recorded once, as the bot\'s news about the request');
  });

  await t.test('the card moves through the steps as the records do, and ends in the proposal', async () => {
    let card = await byId(asAda, first.messageId);
    assert.equal(card.state, 'working');
    assert.deepEqual([card.stage, card.step, card.of, card.stepName], ['reading', 1, 6, 'Read the request']);
    assert.match(card.doing, /^reading the request/);
    assert.equal(card.links.request, '#app/seed-swap/dev/issues/3');
    assert.ok(Date.parse(card.startedAt) <= Date.now());

    // Read: the queue row goes and the run says build it, in its session.
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 3', [seeds.id]);
    const { rows: [build] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title)
       VALUES ($1, $2, 'bot-build', 'active', 'Sort by date') RETURNING id`,
      [seeds.id, bot.id],
    );
    const runId = await run(seeds, 3, { verdict: 'ready', buildSessionId: build.id });
    card = await byId(asAda, first.messageId);
    assert.deepEqual([card.state, card.stage, card.step, card.stepName], ['working', 'planning', 2, 'Write a plan']);

    // Its plan posted: building.
    await pool.query(
      `INSERT INTO homeroom_bot_posts (app_id, issue_number, run_id, kind) VALUES ($1, 3, $2, 'spec')`,
      [seeds.id, runId],
    );
    card = await byId(asAda, first.messageId);
    assert.deepEqual([card.state, card.stage, card.step, card.stepName, card.doing], ['working', 'building', 3, 'Build it', 'building it']);

    // Built: its proposal is up for a vote.
    await pool.query(`UPDATE chat_sessions SET status = 'promoted', promoted_at = NOW() WHERE id = $1`, [build.id]);
    await pool.query('UPDATE homeroom_bot_runs SET build_ok = TRUE, proposal_session_id = $2 WHERE id = $1', [runId, build.id]);
    card = await byId(asAda, first.messageId);
    assert.equal(card.state, 'done');
    assert.equal(card.outcome, 'proposed');
    assert.equal(card.links.proposal, `#app/seed-swap/dev/proposals/${build.id}`);
    assert.ok(card.endedAt, 'when it went up');
    assert.equal(card.step, undefined, 'a card done says what it came to, not a step');

    await pool.query(`UPDATE chat_sessions SET status = 'merged' WHERE id = $1`, [build.id]);
    assert.equal((await byId(asAda, first.messageId)).outcome, 'live');
  });

  await t.test('a question ends a card; the next look at the request is a card of its own', async () => {
    const asking = await activity.startCard(pool, {
      app: seeds, issueNumber: 4, requester: requester(ada, 'Dark mode'), bot, jobKey: await claim(seeds, 4), settings,
    });
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 4', [seeds.id]);
    await run(seeds, 4, { verdict: 'question' });
    const asked = await byId(asAda, asking.messageId);
    assert.equal(asked.state, 'done');
    assert.equal(asked.outcome, 'question');

    // Answered: the bot looks again, and that is a new piece of work.
    const again = await activity.startCard(pool, {
      app: seeds, issueNumber: 4, requester: requester(ada, 'Dark mode'), bot, jobKey: await claim(seeds, 4), settings,
    });
    assert.notEqual(again.messageId, asking.messageId);
    const cards = await cardsOf(asAda);
    assert.deepEqual(cards.slice(0, 2).map((c) => c.messageId), [again.messageId, asking.messageId], 'newest first');
    assert.equal(cards[0].state, 'working');
    assert.equal(cards[0].stage, 'reading');
    assert.equal(cards[1].outcome, 'question', 'the card before keeps what it came to');

    // A look that ended with nothing recorded (its row gone, no run): stopped.
    const lost = await activity.startCard(pool, {
      app: seeds, issueNumber: 5, requester: requester(ada, 'Export'), bot, jobKey: await claim(seeds, 5), settings,
    });
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 5', [seeds.id]);
    assert.equal((await byId(asAda, lost.messageId)).outcome, 'stopped');
  });

  await t.test('nobody else\'s cards, never an app they cannot view, and none for somebody the bot does not DM', async () => {
    const samsCard = await activity.startCard(pool, {
      app: samsApp, issueNumber: 9, requester: requester(sam, 'Sam\'s secret'), bot, jobKey: await claim(samsApp, 9), settings,
    });
    const hiddenCard = await activity.startCard(pool, {
      app: hidden, issueNumber: 2, requester: requester(ada, 'Hidden thing'), bot, jobKey: await claim(hidden, 2), settings,
    });
    const notOnList = await activity.startCard(pool, {
      app: seeds, issueNumber: 6, requester: requester(lee, 'Lee\'s idea'), bot, jobKey: await claim(seeds, 6), settings,
    });
    assert.equal(notOnList, null, 'lee is not somebody the bot talks to in a DM');

    const adas = await cardsOf(asAda);
    assert.ok(!adas.some((c) => c.messageId === samsCard.messageId), 'sam\'s card is not ada\'s');
    assert.ok(!adas.some((c) => c.messageId === hiddenCard.messageId), 'a private app she cannot view is left out');
    assert.deepEqual((await cardsOf(asSam)).map((c) => c.messageId), [samsCard.messageId],
      'sam\'s own, and not ada\'s card on sam\'s app');

    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [hidden.id, ada.id]);
    assert.ok((await cardsOf(asAda)).some((c) => c.messageId === hiddenCard.messageId), 'once she can view it, it shows');
    await pool.query('DELETE FROM app_collaborators WHERE app_id = $1 AND user_id = $2', [hidden.id, ada.id]);

    assert.deepEqual(await activity.cardsFor(pool, { user: null }), { cards: [] });
  });

  await t.test('the route answers for the signed-in person only, whatever it is asked', async () => {
    const app = express();
    app.use(express.json());
    let actor = asAda;
    app.use((req, _res, next) => { req.user = actor; next(); });
    app.use(conversationRoutes({}, { pool }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => server.close());
    const call = async (as, url) => {
      actor = as;
      const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
      return { status: res.status, body: await res.json(), headers: res.headers };
    };
    const own = await call(asAda, '/api/conversations/homeroom-bot/activity');
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(own.body, JSON.parse(JSON.stringify(await activity.cardsFor(pool, { user: asAda }))));
    assert.ok(own.body.cards.some((c) => c.messageId === first.messageId));
    for (const query of [`?user_id=${sam.id}`, `?userId=${sam.id}`, `?username=${sam.username}`, `?conversationId=${first.conversationId}`]) {
      const asked = await call(asAda, `/api/conversations/homeroom-bot/activity${query}`);
      assert.deepEqual(asked.body, own.body, query);
    }
    const his = await call(asSam, '/api/conversations/homeroom-bot/activity');
    assert.ok(!his.body.cards.some((c) => c.messageId === first.messageId));
    // Off staging, `?demo=1` is the real answer too.
    const demo = await call(asAda, '/api/conversations/homeroom-bot/activity?demo=1');
    assert.deepEqual(demo.body, own.body);
  });

  await t.test('a staging preview shows the demo DM\'s two cards, in the viewer\'s own fixture only', async () => {
    const staging = require('../src/services/staging-messages');
    const env = process.env.USERNODE_ENV;
    process.env.USERNODE_ENV = 'staging';
    try {
      const viewer = await user('viewer');
      const other = await user('other');
      const conversationId = await staging.ensureBotDmFixture(pool, viewer);
      await staging.ensureBotDmFixture(pool, viewer);
      const page = await conversations.listMessages(pool, viewer, conversationId, {});
      const cards = (page.messages || page).filter((m) => m.metadata?.homeroomBot?.kind === 'activity')
        .sort((a, b) => a.id - b.id);
      assert.deepEqual(cards.map((m) => m.metadata.homeroomBot.issueNumber), [9, 14], 'two cards, the one going newest, once');
      const demo = await activity.demoCards(pool, viewer);
      const going = demo.cards.find((c) => c.state === 'working');
      const ended = demo.cards.find((c) => c.state === 'done');
      assert.equal(going.messageId, cards[1].id);
      assert.deepEqual([going.step, going.of, going.stepName], [3, 6, 'Build it']);
      assert.equal(ended.messageId, cards[0].id);
      assert.equal(ended.outcome, 'proposed');
      const { rows } = await pool.query('SELECT 1 FROM homeroom_bot_dm_messages WHERE user_id = $1', [viewer.id]);
      assert.equal(rows.length, 0, 'a demo card stands for no request: nothing is recorded or posted');
      assert.deepEqual(await activity.demoCards(pool, other), { cards: [] }, 'another viewer\'s fixture is not theirs');
    } finally {
      if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env;
    }
  });
});
