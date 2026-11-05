'use strict';

// 16 Oct 2026: the bot's news names its request, and some of it rings
// nobody. A bell row read "Needs you / Homeroom / Homeroom · Homeroom bot":
// the requester's row had no title, so the detail carried only the project.
// relayIssuePost now looks the title up (requestTitleFor: Homeroom's own row,
// else GitHub's) and keeps it; and news marked `quiet` (an older request's
// first read that is not ready, a request that names who builds it) is said
// in the chat with the bot and rings nothing.
//
// 5 Nov 2026 (docs/plans/bot-one-model.md, step 4): a request's news is no
// longer said in the chat with the bot (relayIssuePost is quiet for every
// request but a first version). Its requester's bell rings from the
// request's stage (services/work-state.js bellPushes), so the naming and the
// quiet rule are checked on that bell: the request's name falls back to
// Homeroom's own copy (BELL_FACTS_SQL), read each time, and the quiet rule
// reads the look's run (quietBell: its read_reason, the builder it named).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// Realtime and push are process-wide singletons: nothing to deliver here.
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds) { return memberIds.length; },
    pushToUser() { return 1; },
    pushNotificationToUser() { return 1; },
    pushIssueUpdate() {},
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};

const dm = require('../src/services/homeroom-bot-dm');
const notifyCopy = require('../src/services/homeroom-bot-notify-copy');

test('the bot\'s news names its request, and quiet news rings nobody', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_quiet_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_mode', 'shadow')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
  const { rows: [bot] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username`,
  );
  const { rows: [ada] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ('ada_quiet', 'x', TRUE) RETURNING id, username`,
  );
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url)
     VALUES ('Homeroom', 'hr-quiet', 'running', $1, 'https://github.com/usernode-bot/hr-quiet') RETURNING *`,
    [ada.id],
  );
  const asked = async (n, title = null) => pool.query(
    'INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, $2, $3, $4)',
    [app.id, n, ada.id, title],
  );
  const ws = require('../src/services/work-state');
  // The request's look came to `verdict`: its stage is refreshed, and the
  // bell rows it rang are read back.
  const looked = async (n, verdict, reason = null, { readReason = null, builder = null } = {}) => {
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, reason, read_reason, builder)
       VALUES ($1, $2, 'live', $3, $4, $5, $6)`,
      [app.id, n, verdict, reason, readReason, builder],
    );
    await ws.pushesOf(pool, await ws.refresh(pool, [{ appId: app.id, issueNumber: n }]));
    const { rows } = await pool.query(
      `SELECT kind, detail FROM notifications WHERE user_id = $1 AND app_id = $2 AND detail LIKE $3 ORDER BY id`,
      [ada.id, app.id, `%"i":${n},%`],
    );
    return rows;
  };
  const inChat = async () => (await pool.query(
    'SELECT COUNT(*)::int AS n FROM conversation_messages WHERE sender_id = $1', [bot.id])).rows[0].n;

  await t.test('a requester row with no title is named by Homeroom\'s own row of it', async () => {
    await asked(5308);
    await pool.query(
      `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
       VALUES ($1, 5308, 'Show slots by state', 'Older requests by where they are.', 'general', '{}', $2)`,
      [app.id, ada.id],
    );
    const sent = await dm.relayIssuePost({ pool, app, issueNumber: 5308, kind: 'person', bot, dm: { reason: 'A design call.' } });
    assert.deepEqual([sent.quiet, sent.messageId], [true, null], 'nothing in her chat with the bot');
    const [row] = await looked(5308, 'person', 'A design call.');
    assert.ok(row, 'her bell rings from its stage');
    const words = notifyCopy.botMomentCopy(row.detail);
    assert.deepEqual([words.bellLabel, words.bellSubject, words.bellMeta],
      ['Your decision', 'Show slots by state', 'Homeroom · #5308 · Homeroom bot']);
  });

  await t.test('with no title anywhere, the request is named by its number, never by the project alone', async () => {
    await asked(5309);
    const sent = await dm.relayIssuePost({ pool, app, issueNumber: 5309, kind: 'question', bot, dm: { question: 'Which one?', answers: ['A', 'B'] } });
    assert.equal(sent.messageId, null, 'nothing in her chat with the bot');
    const [row] = await looked(5309, 'question');
    const words = notifyCopy.botMomentCopy(row.detail);
    assert.deepEqual([words.bellLabel, words.bellSubject, words.bellMeta, words.title],
      ['Question for you', 'Request #5309', 'Homeroom · Homeroom bot', 'Request #5309 · Homeroom']);
  });

  await t.test('a question in quiet news still waits for its answer, and the same news, not quiet, rings', async () => {
    await asked(5310, 'Tidy the Discover filters');
    const before = await inChat();
    const sent = await dm.relayIssuePost({
      pool, app, issueNumber: 5310, kind: 'question', bot, dm: { question: 'Which filter first?', answers: ['Topic', 'Mine'], quiet: true },
    });
    assert.deepEqual([sent.quiet, sent.messageId], [true, null]);
    assert.equal(await inChat(), before, 'nothing in her chat with the bot');
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict) VALUES ($1, 5310, 'live', 'question')`, [app.id],
    );
    await ws.refresh(pool, [{ appId: app.id, issueNumber: 5310 }]);
    const { rows: [stored] } = await pool.query(
      `SELECT stage, why, whose_move FROM work_states WHERE app_id = $1 AND item_kind = 'request' AND item_ref = 5310`, [app.id],
    );
    assert.deepEqual([stored.stage, stored.why, stored.whose_move], ['waiting_for_you', 'question', 'requester'],
      'the bot\'s Needs you list still shows it');
    // The same news, not quiet, rings as it did.
    await asked(5312, 'Search box');
    await dm.relayIssuePost({ pool, app, issueNumber: 5312, kind: 'person', bot, dm: { reason: 'A design call.' } });
    assert.deepEqual((await looked(5312, 'person', 'A design call.')).map((r) => r.kind), ['build_needs_you']);
  });

  // 16 Oct 2026: news marked quiet (an older request's first read that is
  // not ready, a request that names who builds it) rang nobody. The stage
  // bell keeps that rule, from the look's run.
  await t.test('news the bot marks quiet still rings nobody', async () => {
    await asked(5313, 'Sort the backlog');
    await dm.relayIssuePost({
      pool, app, issueNumber: 5313, kind: 'question', bot, dm: { question: 'Oldest first?', answers: ['Yes', 'No'], quiet: true },
    });
    assert.deepEqual(await looked(5313, 'question', null, { readReason: 'backlog' }), [], 'an older request\'s first read rings nothing');
    const { rows: [waits] } = await pool.query(
      `SELECT stage, why FROM work_states WHERE app_id = $1 AND item_kind = 'request' AND item_ref = 5313`, [app.id],
    );
    assert.deepEqual([waits.stage, waits.why], ['waiting_for_you', 'question'], 'its stage still shows where it waits');
    // A hand-off that names who builds it is quiet too.
    await asked(5311, 'Board view');
    await dm.relayIssuePost({
      pool, app, issueNumber: 5311, kind: 'person', bot, dm: { reason: 'Assigned to snait.', builder: 'snait', quiet: true },
    });
    assert.deepEqual(await looked(5311, 'person', 'Assigned to snait.', { builder: 'snait' }), [], 'a hand-off to a named builder rings nothing');
    assert.equal(ws.quietBell('ready', { read_reason: 'backlog' }), false, 'ready to try rings, however it was read');
  });
});
