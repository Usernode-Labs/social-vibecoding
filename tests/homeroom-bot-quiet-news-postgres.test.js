'use strict';

// 16 Oct 2026: the bot's news names its request, and some of it rings
// nobody. A bell row read "Needs you / Homeroom / Homeroom · Homeroom bot":
// the requester's row had no title, so the detail carried only the project.
// relayIssuePost now looks the title up (requestTitleFor: Homeroom's own row,
// else GitHub's) and keeps it; and news marked `quiet` (an older request's
// first read that is not ready, a request that names who builds it) is said
// in the chat with the bot and rings nothing.

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
  const bell = async (sent) => {
    const { rows } = await pool.query(
      'SELECT kind, detail FROM notifications WHERE user_id = $1 AND conversation_message_id = $2', [ada.id, sent.messageId],
    );
    return rows[0] || null;
  };

  await t.test('a requester row with no title is named by Homeroom\'s own row of it, and kept', async () => {
    await asked(5308);
    await pool.query(
      `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
       VALUES ($1, 5308, 'Show slots by state', 'Older requests by where they are.', 'general', '{}', $2)`,
      [app.id, ada.id],
    );
    const sent = await dm.relayIssuePost({ pool, app, issueNumber: 5308, kind: 'person', bot, dm: { reason: 'A design call.' } });
    assert.ok(sent?.messageId, 'told in their chat with the bot');
    const row = await bell(sent);
    const words = notifyCopy.botMomentCopy(row.detail);
    assert.deepEqual([words.bellLabel, words.bellSubject, words.bellMeta],
      ['Your decision', 'Show slots by state', 'Homeroom · #5308 · Homeroom bot']);
    const { rows: [kept] } = await pool.query(
      'SELECT issue_title FROM homeroom_bot_requesters WHERE app_id = $1 AND issue_number = 5308', [app.id],
    );
    assert.equal(kept.issue_title, 'Show slots by state', 'kept from then on');
  });

  await t.test('with no title anywhere, the request is named by its number, never by the project alone', async () => {
    await asked(5309);
    const sent = await dm.relayIssuePost({ pool, app, issueNumber: 5309, kind: 'question', bot, dm: { question: 'Which one?', answers: ['A', 'B'] } });
    const words = notifyCopy.botMomentCopy((await bell(sent)).detail);
    assert.deepEqual([words.bellLabel, words.bellSubject, words.bellMeta, words.title],
      ['Question for you', 'Request #5309', 'Homeroom · Homeroom bot', 'Request #5309 · Homeroom']);
  });

  await t.test('quiet news is said, rings nothing, and a question in it still waits for its answer', async () => {
    await asked(5310, 'Tidy the Discover filters');
    const sent = await dm.relayIssuePost({
      pool, app, issueNumber: 5310, kind: 'question', bot, dm: { question: 'Which filter first?', answers: ['Topic', 'Mine'], quiet: true },
    });
    assert.ok(sent?.messageId, 'said in their chat with the bot');
    assert.equal(await bell(sent), null, 'no bell row, so no push');
    const { rows: [msg] } = await pool.query('SELECT content FROM conversation_messages WHERE id = $1', [sent.messageId]);
    assert.match(msg.content, /Which filter first\?/);
    const { rows: [rec] } = await pool.query(
      'SELECT kind, question_status FROM homeroom_bot_dm_messages WHERE message_id = $1', [sent.messageId],
    );
    assert.deepEqual([rec.kind, rec.question_status], ['question', 'open'], 'the bot\'s Needs you list still shows it');
    // A hand-off that names who builds it is quiet too.
    await asked(5311, 'Board view');
    const handOff = await dm.relayIssuePost({
      pool, app, issueNumber: 5311, kind: 'person', bot, dm: { reason: 'Assigned to snait.', builder: 'snait', quiet: true },
    });
    assert.ok(handOff?.messageId);
    assert.equal(await bell(handOff), null);
    // And the same news, not quiet, rings as it did.
    await asked(5312, 'Search box');
    const loud = await dm.relayIssuePost({ pool, app, issueNumber: 5312, kind: 'person', bot, dm: { reason: 'A design call.' } });
    assert.equal((await bell(loud))?.kind, 'build_needs_you');
  });
});
