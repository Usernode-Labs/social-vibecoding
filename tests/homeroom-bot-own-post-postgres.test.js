'use strict';

// #6806: a refresh does not read the bot's own post on a request as a
// change. The "It's live" note (homeroom-bot-live.js, through
// requests.comment) moves the issue's updated_at, so the next refresh used
// to queue a look at the request, and that look's start added a stray
// "Reading it." to the first version's thread.
//
// Against the full PostgreSQL schema and through the bot's own refresh
// (refreshApp), which is where the read is made: the bot's comment alone
// queues nothing, and a later edit is still read.
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
  const name = `hrbot_own_post_${crypto.randomBytes(6).toString('hex')}`;
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

test('the bot\'s own post on a request queues no look; a later edit does', { timeout: 180000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;

  const { rows: [evan] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ('evan', 'x', TRUE) RETURNING id`,
  );
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Plant Pal', 'plant-pal', 'running', $1, 'https://github.com/usernode-bot/plant-pal', 'public', 'public')
     RETURNING id, slug, name, repo_url`,
    [evan.id],
  );
  const seenAt = new Date(Date.now() - 60 * 60 * 1000);
  const postedAt = new Date(Date.now() - 5 * 60 * 1000);
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, thread_seen_at, duration_ms, created_at)
     VALUES ($1, 1, 'live', 'ready', $2, 60000, $2)`,
    [app.id, seenAt.toISOString()],
  );
  // requests.comment() as the bot writes it: posted as 'homeroom', no user.
  await pool.query(
    `INSERT INTO request_comments (app_id, number, author_login, user_id, body, created_at)
     VALUES ($1, 1, 'homeroom', NULL, 'It''s live.', $2)`,
    [app.id, postedAt.toISOString()],
  );
  const githubAt = (at) => ({
    async fetchPublicIssues() {
      return {
        issues: [{
          number: 1, title: 'Make it', state: 'open', createdAt: seenAt.toISOString(), updatedAt: at.toISOString(),
        }],
      };
    },
  });
  const settings = { mode: 'shadow' };

  // The comment moved updated_at a second later, and nothing else since.
  const own = await bot.refreshApp(pool, app, { github: githubAt(new Date(postedAt.getTime() + 1000)), settings });
  assert.equal(own.queued, 0, 'no look is queued for the bot\'s own post');

  // A title or text edit a minute after the post is not the post's doing.
  const edited = await bot.refreshApp(pool, app, { github: githubAt(new Date(postedAt.getTime() + 60 * 1000)), settings });
  assert.equal(edited.queued, 1, 'a later edit is still read');
});
