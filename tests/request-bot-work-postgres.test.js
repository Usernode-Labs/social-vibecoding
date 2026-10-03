'use strict';

// #17: a request the Homeroom bot is building says so, against the full
// PostgreSQL schema and through the real issue routes.
//
// The bot's own sessions are never a request's `in_progress` (routes/issues.js
// leaves synthetic authors out on purpose, which tests/homeroom-bot.test.js
// pins), so a request it was building read "Unassigned" on its page, its main
// button was Start work, and Claim was offered. A claim then told the bot to
// leave the request alone (homeroom-bot.js issueHolders), mid-build.
//
// What is pinned here:
//   - homeroom-bot-progress.js botWorkByIssue reads what the bot is doing on
//     ONE project's requests with projectsBusy's own two reads: a request it
//     is reading now (a claimed queue row, other than a follow-up on its own
//     proposal), and one it is building (a live ready run with no proposal
//     yet). By issue number, { what, since }.
//   - and a live build WAITING for the project's build slot, by the bot's own
//     "live build waiting or under way" rule (homeroom-bot.js classifyIssue,
//     liveCandidates): building too, since it began to wait. It can wait a
//     whole other build's length, and a claim in that time would make the
//     bot step back just the same.
//   - GET /api/apps/:slug/github-issues and /github-issues/:number carry it
//     as each open request's `bot`, and still never as `in_progress`.
//
// Skips when no PostgreSQL is reachable, like the repository's other
// postgres tests; required when TEST_DATABASE_URL is set.
//
// Run with: node --test tests/request-bot-work-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// The routes read their pool at construction; point it at the test database
// before they are required.
let routePool = null;
const poolMod = require('../src/db/pool');
poolMod.getPool = () => routePool;

// GitHub, answered in-process: the open requests, and one closed one.
const github = require('../src/services/github');
const GH = [3, 4, 6, 7, 8].map((n) => ({
  number: n, title: `Request ${n}`, body: '', labels: ['usernode'],
  updatedAt: '2026-10-03T10:00:00Z', htmlUrl: `https://github.com/o/plant-pal/issues/${n}`, user: 'someone',
}));
github.isEnabled = () => true;
github.fetchPublicIssues = async () => ({ issues: GH.filter((i) => i.number !== 8), truncatedList: false });
github.fetchPublicIssue = async (_owner, _repo, n) => {
  const issue = GH.find((i) => i.number === n);
  if (!issue) return { issue: null };
  return { issue: n === 8 ? { ...issue, state: 'closed', closedAt: '2026-10-03T11:00:00Z' } : { ...issue, state: 'open' } };
};

const progress = require('../src/services/homeroom-bot-progress');
const { issueRoutes } = require('../src/routes/issues');

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
  const name = `request_bot_work_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: String(url), max: 6 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  return pool;
}

test('a request the Homeroom bot is reading or building, by issue, through the real routes', { timeout: 120000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;
  routePool = pool;

  const { rows: [bot] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic)
     VALUES ('homeroom_bot', 'x', TRUE, TRUE) RETURNING id`,
  );
  const { rows: [ada] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ('ada', 'x', TRUE) RETURNING id, username`,
  );
  const project = async (slug) => {
    const { rows: [row] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
       VALUES ($1, $1, 'running', $2, $3, 'public', 'public') RETURNING id`,
      [slug, ada.id, `https://github.com/o/${slug}`],
    );
    return row.id;
  };
  const plantPal = await project('plant-pal');
  const other = await project('other-app');

  const session = async (appId, status, linked = []) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, session_title, linked_issues)
     VALUES ($1, $2, $3, 'Homeroom bot', $4::int[]) RETURNING id`,
    [appId, bot.id, status, linked],
  )).rows[0].id;
  const run = async (appId, issue, extra = {}) => {
    const cols = { app_id: appId, issue_number: issue, mode: 'live', verdict: 'ready', ...extra };
    const keys = Object.keys(cols);
    const { rows: [row] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      keys.map((k) => cols[k]),
    );
    return row.id;
  };

  await t.test('nothing under way is an empty map', async () => {
    const work = await progress.botWorkByIssue(pool, plantPal);
    assert.equal(work.size, 0);
    assert.equal((await progress.botWorkByIssue(pool, null)).size, 0, 'no project, nothing asked');
  });

  // Request 3: being read now. Request 4: being built (its queue row is gone,
  // its build session is active). Both on Plant Pal.
  await pool.query(
    `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, started_at)
     VALUES ($1, 3, 1, 'new', NOW() - INTERVAL '2 minutes')`,
    [plantPal],
  );
  const building = await session(plantPal, 'active', [4]);
  await run(plantPal, 4, { build_session_id: building });

  await t.test('reading and building, by issue number', async () => {
    const work = await progress.botWorkByIssue(pool, plantPal);
    assert.deepEqual([...work.keys()].sort(), [3, 4]);
    assert.equal(work.get(3).what, 'reading');
    assert.equal(work.get(4).what, 'building');
    assert.ok(work.get(4).since instanceof Date || typeof work.get(4).since === 'string', 'with when it started');
  });

  await t.test('only this project, and nothing the bot is not doing this minute', async () => {
    // Waiting in the queue, unread: not being read.
    await pool.query(`INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason) VALUES ($1, 5, 1, 'new')`, [plantPal]);
    // A build that proposed already: done building.
    const proposal = await session(plantPal, 'promoted');
    await run(plantPal, 7, { proposal_session_id: proposal });
    // A build that ended without a proposal is not building.
    await run(plantPal, 10, { build_session_id: await session(plantPal, 'paused'), build_ok: false });
    // Shadow triage builds nothing.
    await run(plantPal, 9, { mode: 'shadow' });
    // Another project's build is that project's.
    await run(other, 3, { build_session_id: await session(other, 'active') });
    const work = await progress.botWorkByIssue(pool, plantPal);
    assert.deepEqual([...work.keys()].sort(), [3, 4]);
    assert.deepEqual([...(await progress.botWorkByIssue(pool, other)).keys()], [3]);
  });

  await t.test('a build waiting for the project\'s build slot is the bot building it, since it began to wait', async () => {
    // Request 6's verdict came in while request 4's build held the slot: it
    // waits its turn, with no build session yet. projectsBusy does not count
    // it (it holds nothing up yet), and the request page used to read
    // "Unassigned" and offer Claim for as long as it waited.
    const waitingSince = new Date(Date.now() - 25 * 60 * 1000);
    await run(plantPal, 6, { live_build_waiting_at: waitingSince, created_at: new Date(Date.now() - 26 * 60 * 1000) });
    const work = await progress.botWorkByIssue(pool, plantPal);
    assert.deepEqual([...work.keys()].sort((a, b) => a - b), [3, 4, 6]);
    assert.equal(work.get(6).what, 'building');
    assert.equal(new Date(work.get(6).since).getTime(), waitingSince.getTime(), 'since it began to wait');

    // Read now and waiting for its build at once: building wins, as above.
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, started_at) VALUES ($1, 6, 0, 'dm_answer', NOW())`,
      [plantPal],
    );
    assert.equal((await progress.botWorkByIssue(pool, plantPal)).get(6).what, 'building');
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 6', [plantPal]);

    // Past the abandoned-build sweep's window a waiting run holds nothing,
    // exactly as the bot reads it.
    await run(plantPal, 12, {
      live_build_waiting_at: new Date(Date.now() - 9 * 86400000), created_at: new Date(Date.now() - 9 * 86400000),
    });
    assert.ok(!(await progress.botWorkByIssue(pool, plantPal)).has(12));
    assert.equal(require('../src/services/homeroom-bot').ABANDONED_LIVE_WINDOW_DAYS, 7,
      'the window is the bot\'s own constant, not a copy');
  });

  await t.test('a request read and built at once is building', async () => {
    // The read lane picking up a request whose build is still running.
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, started_at)
       VALUES ($1, 4, 1, 'changed', NOW())`,
      [plantPal],
    );
    assert.equal((await progress.botWorkByIssue(pool, plantPal)).get(4).what, 'building');
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 4', [plantPal]);
  });

  await t.test('the issue routes carry it as `bot`, and never as in_progress', async () => {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => { req.user = { id: ada.id, username: ada.username }; next(); });
    server.use(issueRoutes({}));
    const listener = await new Promise((resolve) => {
      const l = server.listen(0, '127.0.0.1', () => resolve(l));
    });
    try {
      const base = `http://127.0.0.1:${listener.address().port}`;
      const get = async (p) => {
        const res = await fetch(base + p);
        assert.equal(res.status, 200, p);
        return res.json();
      };
      const { issues } = await get('/api/apps/plant-pal/github-issues');
      const byNumber = new Map(issues.map((i) => [i.number, i]));
      assert.equal(byNumber.get(3).bot.what, 'reading');
      assert.equal(byNumber.get(4).bot.what, 'building');
      assert.ok(Date.parse(byNumber.get(4).bot.since), 'a time the client can read');
      assert.equal(byNumber.get(6).bot.what, 'building', 'a build waiting its turn too');
      assert.equal(byNumber.get(7).bot, null, 'a proposed request is not being built');
      // The bot's build session even names request 4 here, and it is still
      // nobody's in_progress: the rule that keeps a bot off the claim list.
      assert.equal(byNumber.get(4).in_progress, null);
      assert.equal(byNumber.get(4).headless, null);

      assert.equal((await get('/api/apps/plant-pal/github-issues/4')).issue.bot.what, 'building',
        'the request opened by its address says so too');
      assert.equal((await get('/api/apps/plant-pal/github-issues/7')).issue.bot, null);
      assert.equal((await get('/api/apps/plant-pal/github-issues/8')).issue.bot, null,
        'a closed request has nothing being built on it');
    } finally {
      listener.close();
    }
  });
});
