'use strict';

// #6133's before/after shots: the staging seed that gives the member's chat
// with the bot the quiet line said when a look starts near the end of the
// week's building time. Only the live loop says it and a staging copy never
// runs the bot, so the rows themselves are the fixture.
//
// What a real database is needed for: the chat is a direct conversation with
// its pair and members, the card is the root of its thread, and the seed has
// to stay one card and two lines across boots.
//
// Run with: node --test tests/homeroom-bot-allowance-warning-seed-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the bot\'s near-the-end-of-the-week line is seeded in the member\'s chat with the bot, once', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `hrbot_allowance_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await pool.query(`ALTER TABLE users ALTER COLUMN contact_policy SET DEFAULT 'anyone',
                                 ALTER COLUMN profile_discoverable SET DEFAULT TRUE`);

  const { rows: [member] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic)
     VALUES ('usernode-capture', 'x', TRUE, FALSE) RETURNING id`
  );

  const { seedStagingBotAllowanceWarning } = require('../src/db/migrate');
  const was = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  try {
    await seedStagingBotAllowanceWarning(pool);
    await seedStagingBotAllowanceWarning(pool);
  } finally {
    if (was === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = was;
  }

  const { rows: [bot] } = await pool.query(
    `SELECT id FROM users WHERE username = 'homeroom_bot' AND is_synthetic = TRUE`
  );
  assert.ok(bot, 'the bot\'s account is made the way botAccount reads it');

  const { rows: [pair] } = await pool.query(
    `SELECT conversation_id FROM conversation_direct_pairs
      WHERE user_low_id = LEAST($1::int, $2::int) AND user_high_id = GREATEST($1::int, $2::int)`,
    [member.id, bot.id]
  );
  assert.ok(pair, 'one direct chat with the bot');

  const { rows } = await pool.query(
    `SELECT id, content, idempotency_key, metadata, thread_root_id
       FROM conversation_messages WHERE conversation_id = $1 ORDER BY id`,
    [pair.conversation_id]
  );
  assert.equal(rows.length, 3, 'one card and its two quiet lines, however many boots');
  const [card, reading, low] = rows;
  assert.equal(card.idempotency_key, 'staging-hrbot-allowance-low-card');
  assert.equal(card.metadata.homeroomBot.kind, 'activity');
  assert.equal(card.metadata.homeroomBot.issueNumber, 19);
  assert.equal(card.metadata.homeroomBot.appSlug, undefined, 'no project page: its thread is where the story opens');
  assert.equal(card.thread_root_id, null, 'the card is the thread\'s root');
  assert.equal(reading.thread_root_id, card.id);
  assert.equal(reading.metadata.homeroomBot.step, 'reading');
  assert.equal(reading.content, 'Reading it again.');
  assert.equal(low.thread_root_id, card.id);
  assert.equal(low.metadata.homeroomBot.step, 'allowance_low');
  assert.equal(low.content, 'You\'re close to this week\'s building time.');

  const { rows: [membership] } = await pool.query(
    `SELECT last_read_message_id FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
    [pair.conversation_id, member.id]
  );
  assert.equal(Number(membership.last_read_message_id), Number(low.id), 'read: no Unread badge on the tab');

  const { rows: [counts] } = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM notifications WHERE user_id = $1) AS notifications,
            (SELECT COUNT(*)::int FROM homeroom_bot_runs) AS runs,
            (SELECT COUNT(*)::int FROM homeroom_bot_dm_messages) AS cards`,
    [member.id]
  );
  assert.deepEqual(counts, { notifications: 0, runs: 0, cards: 0 },
    'display rows only: nothing rings, and the week\'s spend (the signal the change reads) is not seeded');

  // A production process seeds none of it.
  const refused = { query() { assert.fail('production must never seed this fixture'); } };
  const before = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'production';
  try { await seedStagingBotAllowanceWarning(refused); }
  finally { process.env.USERNODE_ENV = before; }
});
