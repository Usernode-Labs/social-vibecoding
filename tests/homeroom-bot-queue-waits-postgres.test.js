// The Homeroom bot's queue snapshot and its move offers' week, against the
// full PostgreSQL schema: why each waiting row waits, read with the rules
// rules/bot-loop.ts READ_CANDIDATES_SQL applies, and the counts from the same statement as the
// rows listed. tests/homeroom-bot-queue-waits.test.js pins the same without
// a database.
//
// Run with: node --test tests/homeroom-bot-queue-waits-postgres.test.js
// (skips when PostgreSQL is not reachable, unless TEST_DATABASE_URL insists
// on one).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const bot = require('../src/services/homeroom-bot');
const move = require('../src/services/homeroom-bot-move');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('why queued requests wait, and the move offers, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_waits_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    bot._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  bot._resetForTests();

  const user = async (username, synthetic = false) => (await pool.query(
    'INSERT INTO users (username, password, is_synthetic) VALUES ($1, \'x\', $2) RETURNING id', [username, synthetic],
  )).rows[0].id;
  const botId = await user('homeroom_bot', true);
  const ada = await user('ada');
  const bea = await user('bea');
  const app = async (slug) => (await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ($1, $1, 'running', $2) RETURNING id`,
    [slug, `https://github.com/usernode-bot/${slug}`],
  )).rows[0].id;
  const racer = await app('type-racer-battle-1c07b0');
  const quiet = await app('quiet-app');
  const notes = await app('notes');
  const queue = async (appId, issue, { started = false, reason = 'new', person = ada } = {}) => {
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, reason, started_at) VALUES ($1, $2, $3, $4)`,
      [appId, issue, reason, started ? new Date() : null],
    );
    await pool.query('INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id) VALUES ($1, $2, $3)', [appId, issue, person]);
  };
  const run = async (appId, issue, cols = {}) => {
    const fields = { app_id: appId, issue_number: issue, mode: 'live', verdict: 'ready', build_note: 'build it', ...cols };
    const keys = Object.keys(fields);
    return (await pool.query(
      `INSERT INTO homeroom_bot_runs (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      keys.map((k) => fields[k]),
    )).rows[0].id;
  };

  // type-racer-battle: its first version (#1) filed and being read; #2 and
  // #5 wait for it, as they did from 10 October with nothing said.
  await pool.query(
    `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, status, issue_number, filed_at)
     VALUES ($1, $2, 'a racing game', 'filed', 1, NOW())`,
    [racer, ada],
  );
  await queue(racer, 1, { started: true });
  await queue(racer, 2, { person: bea });
  await queue(racer, 5, { person: bea, reason: 'admin' });
  // A paused app's request.
  await queue(quiet, 3, { person: bea });
  // notes: #7's build waits its turn; #8 has somebody still writing on it;
  // #9 is next in line.
  await run(notes, 7, { live_build_waiting_at: new Date() });
  await queue(notes, 7, { reason: 'thread', person: bea });
  await queue(notes, 8, { reason: 'thread', person: bea });
  await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at)
     VALUES ($1, $2, 'and one more thing', 'message', 'issue', 8, NOW() - INTERVAL '5 seconds')`,
    [notes, bea],
  );
  await queue(notes, 9, { person: bea });

  await t.test('each waiting row says why, and the counts are the listed set\'s', async () => {
    const q = await bot.queueSnapshot(pool, { mode: 'shadow', pausedApps: ['quiet-app'], perPerson: 3 }, { botId });
    assert.equal(q.depth, 6);
    assert.equal(q.running, 1);
    assert.equal(q.listedWaiting, 6);
    assert.equal(q.listedRunning, 1);
    const why = Object.fromEntries(q.items.map((i) => [`${i.app_slug}#${i.issue_number}`, i.waiting && i.waiting.reason]));
    assert.deepEqual(why, {
      'type-racer-battle-1c07b0#1': null,
      'type-racer-battle-1c07b0#2': 'first_version_pending',
      // An admin's Run now is not held by the first version: its app's one
      // session is taken by #1's read.
      'type-racer-battle-1c07b0#5': 'session_busy',
      'quiet-app#3': 'app_paused',
      'notes#7': 'build_pending',
      'notes#8': 'settling',
      'notes#9': null,
    });
    assert.equal(q.items.find((i) => i.issue_number === 2).waiting.firstVersionIssue, 1);
    assert.equal(q.items[0].issue_number, 1, 'the running rows first');
  });

  await t.test('per person, counting what runs', async () => {
    const q = await bot.queueSnapshot(pool, { mode: 'shadow', pausedApps: [], perPerson: 1 }, { botId });
    // ada's #1 runs, and bea has nothing running: nothing waits on her limit.
    assert.equal(q.items.find((i) => i.issue_number === 9).waiting, null);
    await pool.query(`UPDATE homeroom_bot_queue SET started_at = NOW() WHERE app_id = $1 AND issue_number = 9`, [notes]);
    const after = await bot.queueSnapshot(pool, { mode: 'shadow', pausedApps: [], perPerson: 1 }, { botId });
    assert.equal(after.running, 2);
    assert.equal(after.depth, 5);
    assert.equal(after.items.find((i) => i.app_slug === 'quiet-app').waiting.reason, 'per_person', 'bea\'s #9 runs now');
  });

  await t.test('the move offers of the week, and the platform verdicts that sent none', async () => {
    const offered = await run(notes, 20, { verdict: 'person', about_platform: true });
    await move.noteMoveOffer(pool, offered, 'sent');
    await pool.query(
      `INSERT INTO homeroom_bot_dm_actions (user_id, app_id, kind, title, source_issue_number, status)
       VALUES ($1, $2, 'move_request', 'The header', 20, 'done'), ($1, $2, 'move_request', 'Invites', 21, 'declined')`,
      [ada, notes],
    );
    const noBot = await run(notes, 22, { verdict: 'person', about_platform: true });
    await move.noteMoveOffer(pool, noBot, 'no_bot');
    await run(notes, 23, { verdict: 'person', about_platform: true });
    // Not about Homeroom: nothing is recorded on it.
    const plain = await run(notes, 24, { verdict: 'person' });
    await move.noteMoveOffer(pool, plain, 'no_bot');
    const { rows: [p] } = await pool.query('SELECT move_offer FROM homeroom_bot_runs WHERE id = $1', [plain]);
    assert.equal(p.move_offer, null);

    const m = await move.moveOfferSummary(pool);
    assert.deepEqual({ sent: m.sent, moved: m.moved, kept: m.kept, open: m.open, failed: m.failed }, { sent: 2, moved: 1, kept: 1, open: 0, failed: 0 });
    assert.equal(m.notOffered, 2);
    assert.deepEqual(m.notOfferedByWhy, { no_bot: 1, unrecorded: 1 });
    assert.deepEqual(m.notOfferedRecent.map((r) => [r.issueNumber, r.why]), [[23, 'unrecorded'], [22, 'no_bot']]);
  });
});
