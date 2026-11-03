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

const progress = require('../src/services/homeroom-bot-progress');
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
    const { rows: [row] } = await pool.query(track.REQUEST_ROWS_SQL, [app.id, [6228]]);
    assert.equal(Number(row.reply_id), Number(msg.id));
    assert.equal(Number(row.reply_user_id), Number(evan.id));
    const state = progress.stageOf(row, { now: new Date() });
    assert.equal(state.stage, 'reading');
    assert.equal(state.reply, true);
    assert.equal(state.waiting, true);
    // The track draws it as the existing planning state, with its own line.
    const job = track.jobOfRow(row, { stageOf: progress.stageOf, outcomeOf: () => null });
    assert.equal(job.reply, true);
    const t2 = track.trackOf({ job });
    assert.equal(t2.state, 'planning');
    assert.equal(t2.why, 'reply');
  });

  await t.test('the bot page\'s facts say Reading the reply, not Decide', async () => {
    const facts = await ai.requestFacts(pool, [{ app_id: app.id, number: 6228, slug: 'homeroom' }], evan.id, {
      settings: { mode: 'on' },
    });
    const f = facts.get('homeroom#6228');
    assert.equal(f.replyWaits, true);
    assert.equal(f.handedBack, true);
    const row = { state: 'open', kind: 'request', number: 6228, request_state: 'open', request_at: new Date().toISOString(), created_at: new Date().toISOString() };
    assert.equal(ai.standing(row, evan.id, new Date(), null, null, f).what, 'reading_reply');
  });

  await t.test('a reply older than the window with no queue row goes back to Decide', async () => {
    await pool.query('DELETE FROM chat_messages WHERE thread_type = $1', ['issue']);
    await reply(3);
    const facts = await ai.requestFacts(pool, [{ app_id: app.id, number: 6228, slug: 'homeroom' }], evan.id, {
      settings: { mode: 'on' },
    });
    const f = facts.get('homeroom#6228');
    assert.equal(f.replyWaits, false);
    const row = { state: 'open', kind: 'request', number: 6228, request_state: 'open', request_at: new Date().toISOString(), created_at: new Date().toISOString() };
    assert.equal(ai.standing(row, evan.id, new Date(), null, null, f).what, 'decide');
  });
});
