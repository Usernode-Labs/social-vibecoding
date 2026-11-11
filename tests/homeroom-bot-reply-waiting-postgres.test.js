'use strict';

// #6228 (3 Nov 2026): a person's reply on a request Homeroom bot handed
// back, against the full PostgreSQL schema. The reply is read from
// chat_messages by the same LATERAL both the progress and the track read,
// and the Homeroom bot page's facts read the same rule, so the request
// leaves Decide as soon as the reply is stored.
//
// Skips when no database is reachable, unless TEST_DATABASE_URL is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const track = require('../src/services/homeroom-bot-track');
const ai = require('../src/services/ai-work');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('#6228: a stored reply reads as waiting to be read, for the track and the bot page', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_reply_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  await pool.query("INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE)");
  const { rows: [evan] } = await pool.query("INSERT INTO users (username, password) VALUES ('evan', 'x') RETURNING id");
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url, created_by)
     VALUES ('homeroom', 'homeroom', 'running', 'https://github.com/usernode-bot/homeroom', $1) RETURNING id`,
    [evan.id],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, created_at)
     VALUES ($1, 6228, 'live', 'person', NOW() - interval '10 minutes')`,
    [app.id],
  );
  const reply = async (agoMinutes) => pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at)
     VALUES ($1, $2, 'yep do it', 'message', 'issue', 6228, NOW() - make_interval(mins => $3)) RETURNING id`,
    [app.id, evan.id, agoMinutes],
  );

  await t.test('the newest reply after the look is read from the request thread', async () => {
    const { rows: [msg] } = await reply(1);
    // The thread's reply line reads the newest reply after the look, and
    // the request's stored work state: about to read it (`soon`).
    const replyStatus = require('../src/services/homeroom-bot-reply-status');
    const read = await replyStatus.readStatus(pool, { appId: app.id, place: { type: 'issue', ref: 6228 } });
    assert.deepEqual([read.replyId, read.authorId, read.status], [Number(msg.id), Number(evan.id), 'will_read']);
    // The track draws the same stored work state: reading, its line the reply.
    const tracks = await track.tracksForRequests(pool, { appId: app.id, numbers: [6228] });
    assert.deepEqual([tracks.get(6228).work.stage, tracks.get(6228).work.line], ['reading', { code: 'reply', soon: true }]);
  });

  // 5 Nov 2026: the bot page reads the request's stored work state
  // (services/work-state.js), refreshed from the same records.
  const ws = require('../src/services/work-state');
  const thread = () => ({ state: 'open', kind: 'request', number: 6228, request_id: 1, request_state: 'open', own: true,
    request_at: new Date().toISOString(), created_at: new Date().toISOString() });
  const stored = async () => {
    await ws.refresh(pool, [{ appId: app.id, issueNumber: 6228 }]);
    return (await ws.forRequests(pool, app.id, [6228])).get(6228);
  };

  await t.test('the stored state says Reading your reply, not Decide', async () => {
    const state = await stored();
    assert.deepEqual([state.stage, state.line], ['reading', { code: 'reply', soon: true }]);
    assert.equal(ai.standing(thread(), evan.id, new Date(), null, state, { decides: true }).group, 'next');
  });

  await t.test('a reply older than the window with no queue row goes back to Decide', async () => {
    await pool.query('DELETE FROM chat_messages WHERE thread_type = $1', ['issue']);
    await reply(3);
    const state = await stored();
    assert.deepEqual([state.stage, state.why], ['waiting_for_you', 'decide']);
    assert.equal(ai.standing(thread(), evan.id, new Date(), null, state, { decides: true }).group, 'needs');
  });
});
