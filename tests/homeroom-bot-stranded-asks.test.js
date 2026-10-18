'use strict';

// #5217: an update the Homeroom bot queued and never ran. recordAsk puts an
// update's follow-up first in the queue, but that answers null when a row
// for the app and issue is already claimed, and some ends of the loop
// delete the row without re-queueing the asks waiting (runFollowUp's
// no_new_replies, runTriage's not_open and has_proposal and the claim
// race). Nothing read homeroom_bot_change_asks on its own, so such an ask
// sat 'queued' for hours. These pin the sweep that puts it back:
//
//   - a stranded ask (queued, half an hour old, the bot's own promoted
//     change, no queue row for the app and issue) is re-queued as
//     voice_update, first in the queue, at the asker's cost;
//   - nothing is re-queued when the ask is young, or has a queue row
//     (claimed or waiting), or its change merged, or it is older than
//     7 days, or the voice on changes is off;
//   - and the lane's five-minute sweep (bot-lane's bot.sweep) runs it: the
//     voice_update row is there after it.
//
// The re-queue is a bot-request Owed (enqueueFront), so the workflow
// runtime runs here on this database, its pipeline only (no timers, no
// work): the queue row is that machine's projection. Against the full
// schema, like the other bot postgres tests. Skips when no PostgreSQL is
// reachable.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../src/services/homeroom-bot');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

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
  const name = `hrbot_stranded_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: String(url), max: 8 });
  pool.on('error', () => {});
  const platform = require('../src/workflow/platform.ts');
  require('../src/db/pool').getPool = () => pool;
  t.after(async () => {
    await platform.stopWorkflow().catch(() => {});
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  await platform.startWorkflow({ databaseUrl: String(url), dataEncryptionKey: 'synthetic-key', wfPoolMax: 4, wfSlots: 2 }, { loops: false });
  return pool;
}

const LIVE = { mode: 'live' };
const VOICE_OFF = { mode: 'live', voiceSession: false };

async function seedScene(pool, { status = 'promoted', issueNumber = 12, botName = null } = {}) {
  let seq = 0;
  const { rows: [botUser] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic, has_platform_access)
     VALUES ($1, 'x', TRUE, TRUE) RETURNING id, username`,
    [botName || `homeroom_bot_${crypto.randomBytes(4).toString('hex')}_${++seq}`],
  );
  const { rows: [evan] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access)
     VALUES ($1, 'x', TRUE) RETURNING id, username`,
    [`evan_${crypto.randomBytes(4).toString('hex')}`],
  );
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Todo List', $2, 'running', $1, 'https://github.com/usernode-bot/todo-list', 'public', 'public')
     RETURNING *`,
    [evan.id, `todo-list-${crypto.randomBytes(4).toString('hex')}`],
  );
  const { rows: [change] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, linked_issues, promoted_at)
     VALUES ($1, $2, 'dev/homeroom_bot-blue', $3, 'Blue header', $4, NOW()) RETURNING *`,
    [app.id, botUser.id, status, [issueNumber]],
  );
  const askOf = async (ageMinutes, { askerId = evan.id } = {}) => {
    const { rows: [ask] } = await pool.query(
      `INSERT INTO homeroom_bot_change_asks
         (app_id, session_id, issue_number, asker_id, instruction, created_at)
       VALUES ($1, $2, $3, $4, 'Add storing a screenshot of the app, and include it in the emails',
               NOW() - make_interval(mins => $5)) RETURNING id`,
      [app.id, change.id, issueNumber, askerId, ageMinutes],
    );
    return ask;
  };
  return { botUser, evan, app, change, askOf };
}

const queueRows = async (pool, appId) => (await pool.query(
  `SELECT app_id, issue_number, priority, reason, requested_by, started_at FROM homeroom_bot_queue WHERE app_id = $1`,
  [appId],
)).rows;

test('the stranded-ask sweep', { timeout: 180000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;

  await t.test('an ask nobody ran is re-queued, first in the queue, at the asker\'s cost', async () => {
    const scene = await seedScene(pool);
    await scene.askOf(40);
    const n = await bot.sweepStrandedAsks(pool, { id: scene.botUser.id }, LIVE, {});
    assert.equal(n, 1, 'the follow-up went back in the queue');
    const rows = await queueRows(pool, scene.app.id);
    assert.deepEqual(rows.map((r) => ({
      issue_number: r.issue_number, priority: r.priority, reason: r.reason, requested_by: r.requested_by,
    })), [{ issue_number: 12, priority: 0, reason: 'voice_update', requested_by: scene.evan.id }],
    'the same enqueueFront recordAsk makes: front of the queue, the asker pays');
    assert.equal(rows[0].app_id, scene.app.id);
  });

  await t.test('nothing is re-queued while the ask is not stranded', async () => {
    // Each scene is a project of its own: its queue is its own.
    const young = await seedScene(pool);
    await young.askOf(5);
    assert.equal(await bot.sweepStrandedAsks(pool, { id: young.botUser.id }, LIVE, {}), 0, 'five minutes old: the normal path is still its own');
    assert.deepEqual(await queueRows(pool, young.app.id), []);

    const withWaitingRow = await seedScene(pool, { issueNumber: 13 });
    await withWaitingRow.askOf(40);
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason) VALUES ($1, 13, 2, 'refresh')`,
      [withWaitingRow.app.id],
    );
    assert.equal(await bot.sweepStrandedAsks(pool, { id: withWaitingRow.botUser.id }, LIVE, {}), 0, 'a queue row waits already: nothing to do');
    assert.equal((await queueRows(pool, withWaitingRow.app.id)).length, 1, 'and the row that was there stands');

    const withClaimedRow = await seedScene(pool, { issueNumber: 14 });
    await withClaimedRow.askOf(40);
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, started_at) VALUES ($1, 14, 0, 'voice_update', NOW())`,
      [withClaimedRow.app.id],
    );
    assert.equal(await bot.sweepStrandedAsks(pool, { id: withClaimedRow.botUser.id }, LIVE, {}), 0, 'a claimed row means a turn is on it');

    const merged = await seedScene(pool, { issueNumber: 15, status: 'merged' });
    await merged.askOf(40);
    assert.equal(await bot.sweepStrandedAsks(pool, { id: merged.botUser.id }, LIVE, {}), 0, 'a change that merged is the has_proposal path\'s, not the sweep\'s');
    assert.deepEqual(await queueRows(pool, merged.app.id), []);

    const ancient = await seedScene(pool, { issueNumber: 16 });
    await ancient.askOf(7 * 24 * 60 + 60);
    assert.equal(await bot.sweepStrandedAsks(pool, { id: ancient.botUser.id }, LIVE, {}), 0, 'older than 7 days: left alone');
    assert.deepEqual(await queueRows(pool, ancient.app.id), []);

    const off = await seedScene(pool, { issueNumber: 17 });
    await off.askOf(40);
    assert.equal(await bot.sweepStrandedAsks(pool, { id: off.botUser.id }, VOICE_OFF, {}), 0, 'the voice off on changes: the sweep does nothing');
    assert.deepEqual(await queueRows(pool, off.app.id), []);
  });

  await t.test('#5217: the lane\'s sweep runs it, and the row it queues is there after', async () => {
    // The sweep acts for the bot itself (ensureBotUser), and only while it
    // is on.
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ($1, 'live')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [bot.KEY_MODE]);
    const scene = await seedScene(pool, { issueNumber: 24, botName: bot.BOT_USERNAME });
    await scene.askOf(40);
    const out = await bot.sweep({}, pool, {
      deps: {
        worker: { async listWorkerVolumes() { return []; } },
        dm: { async sweepUnproposedBuilds() { return null; } },
      },
    });
    assert.equal(out.strandedAsks, 1, 'the sweep reports what it re-queued');
    const rows = await queueRows(pool, scene.app.id);
    assert.deepEqual(rows.map((r) => [r.issue_number, r.priority, r.reason, r.requested_by]),
      [[24, 0, 'voice_update', scene.evan.id]], 'the app, issue, reason and asker of the ask, as recordAsk queued it first');
  });
});
