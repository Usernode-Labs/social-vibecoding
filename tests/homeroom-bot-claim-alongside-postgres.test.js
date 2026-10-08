'use strict';

// #4190: Claim beside the Homeroom bot, against the full PostgreSQL schema
// and through the bot's own refresh (refreshApp).
//
// A claim made once the bot is already on a request (somebody asked it to
// build it, it is reading it, or its build is waiting or under way) means
// "I'm working on this too": it is not a hold, so the bot keeps its work on
// the request and delivers. A claim made BEFORE the bot started on it still
// holds the bot off, as it always did (#17's rule, kept for that side).
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
  const name = `hrbot_alongside_${crypto.randomBytes(6).toString('hex')}`;
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

test('#4190: a claim after the bot started does not hold it off; a claim before still does', { timeout: 120000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;

  let seq = 0;
  async function user(prefix, { synthetic = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic)
       VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
      [synthetic ? prefix : `${prefix}_${++seq}`, synthetic],
    );
    return rows[0];
  }
  const evan = await user('evan');
  const maya = await user('maya');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Plant Pal', 'plant-pal', 'running', $1, 'https://github.com/usernode-bot/plant-pal', 'public', 'public')
     RETURNING id, slug, name, repo_url`,
    [evan.id],
  );
  const claim = (n, ago) => pool.query(
    `INSERT INTO issue_claims (app_id, github_issue_number, user_id, claimed_at)
     VALUES ($1, $2, $3, NOW() - $4::interval)`,
    [app.id, n, maya.id, ago],
  );
  const queue = (n, { priority, reason, enqueued, started = null }) => pool.query(
    `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, enqueued_at, started_at)
     VALUES ($1, $2, $3, $4, NOW() - $5::interval, NOW() - $6::interval)`,
    [app.id, n, priority, reason, enqueued, started],
  );
  // A live 'ready' verdict whose build waits its turn: its read took two
  // minutes and ended `ended` ago.
  const liveBuild = (n, ended) => pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, thread_seen_at, duration_ms,
                                    live_build_waiting_at, created_at)
     VALUES ($1, $2, 'live', 'ready', NOW() - INTERVAL '1 hour', 120000, NOW() - $3::interval, NOW() - $3::interval)
     RETURNING id`,
    [app.id, n, ended],
  );

  // #1: somebody asked the bot to build it ten minutes ago; maya claimed it since.
  await queue(1, { priority: 0, reason: 'admin', enqueued: '10 minutes' });
  await claim(1, '5 minutes');
  // #2: the bot started reading it ten minutes ago (a refresh queued it); maya claimed it since.
  await queue(2, { priority: 2, reason: 'changed', enqueued: '30 minutes', started: '10 minutes' });
  await claim(2, '5 minutes');
  // #3: its build is waiting its turn; maya claimed it while the bot was
  // still reading it (the read began 7 minutes ago, ended 5 minutes ago).
  const { rows: [build3] } = await liveBuild(3, '5 minutes');
  await claim(3, '6 minutes');
  // #4: maya claimed it BEFORE anybody asked the bot to build it.
  await claim(4, '20 minutes');
  await queue(4, { priority: 0, reason: 'admin', enqueued: '10 minutes' });
  // #5: maya claimed it before the bot's read of it began.
  await claim(5, '20 minutes');
  await liveBuild(5, '5 minutes');
  // #6: queued in the background by a refresh but not started: the bot is
  // not on it yet (the request page shows nothing), so a claim holds it off.
  await queue(6, { priority: 2, reason: 'new', enqueued: '30 minutes' });
  await claim(6, '5 minutes');

  await t.test('issueHolders: claims made once the bot was on it are not holds', async () => {
    const holders = await bot.issueHolders(pool, app.id);
    assert.equal(holders.has(1), false, 'asked to build it, then claimed: the bot keeps going');
    assert.equal(holders.has(2), false, 'reading it, then claimed: the bot keeps going');
    assert.equal(holders.has(3), false, 'claimed mid-read, and the build that followed is still the bot\'s');
    assert.deepEqual(holders.get(4)?.map((h) => h.kind), ['claim'], 'claimed before the ask: still a hold');
    assert.deepEqual(holders.get(5)?.map((h) => h.kind), ['claim'], 'claimed before the read: still a hold');
    assert.deepEqual(holders.get(6)?.map((h) => h.kind), ['claim'], 'queued in the background only: still a hold');
  });

  await t.test('the refresh keeps the bot\'s own follow-up on a request claimed beside its build', async () => {
    // A row the bot queued for itself to read #3 again once the build ends.
    await queue(3, { priority: 2, reason: bot.SELF_QUEUED_REASONS[2], enqueued: '1 minute' });
    const github = {
      async fetchPublicIssues() {
        const at = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
        return { issues: [1, 2, 3, 4, 5, 6].map((number) => ({ number, state: 'open', createdAt: at, updatedAt: at })) };
      },
    };
    await bot.refreshApp(pool, app, { github });
    const { rows } = await pool.query(
      'SELECT issue_number FROM homeroom_bot_queue WHERE app_id = $1 ORDER BY issue_number', [app.id],
    );
    const left = rows.map((r) => Number(r.issue_number));
    assert.ok(left.includes(3), 'the build reads as the bot\'s (building), so its follow-up stays');
    assert.ok(left.includes(2), 'the read under way is untouched');
    assert.ok(left.includes(1) && left.includes(4), 'an ask stays queued either way, as before');
    assert.ok(!left.includes(6), 'a background row a person claimed is dropped, as before');
  });

  await t.test('once the bot\'s run is over, a claim made during it is an ordinary hold again', async () => {
    await pool.query('UPDATE homeroom_bot_runs SET build_ok = TRUE WHERE id = $1', [build3.id]);
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 3', [app.id]);
    const holders = await bot.issueHolders(pool, app.id);
    assert.deepEqual(holders.get(3)?.map((h) => h.kind), ['claim']);
  });
});
