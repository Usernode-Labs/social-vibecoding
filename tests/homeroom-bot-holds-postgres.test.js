'use strict';

// #3751: the Homeroom bot, mentioned on a request a person holds, against
// the full PostgreSQL schema and through the bot's own refresh (refreshApp).
//
// The case from Todo List #75: the bot held the request on a cap, somebody
// claimed it, and three days later "@homeroom_bot try again?" came to
// nothing. Here the mention is answered once with who holds it, a second
// mention is the go-ahead and queues the request, the go-ahead lasts, and a
// hold that starts after it keeps the bot off again.
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
const holds = require('../src/services/homeroom-bot-holds');

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
  const name = `hrbot_holds_${crypto.randomBytes(6).toString('hex')}`;
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

test('a mention on a claimed request is answered, a second one is the go-ahead, through the refresh', { timeout: 120000 }, async (t) => {
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
  const homeroomBot = await user('homeroom_bot', { synthetic: true });
  const evan = await user('evan');
  const chin = await user('chinchan');
  const sam = await user('sam');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Todo List', 'todo-list', 'running', $1, 'https://github.com/usernode-bot/todo-list', 'public', 'public')
     RETURNING id, slug, name, repo_url`,
    [evan.id],
  );

  // Three days ago: the bot looked, a cap held it, and chinchan claimed it.
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, cap_suppressed, thread_seen_at, created_at)
     VALUES ($1, 75, 'live', 'ready', 'proposals_per_app', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')`,
    [app.id],
  );
  await pool.query(
    `INSERT INTO issue_claims (app_id, github_issue_number, user_id, claimed_at) VALUES ($1, 75, $2, NOW() - INTERVAL '3 days')`,
    [app.id, chin.id],
  );
  const say = async (who, content, when = 'NOW()') => pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at)
     VALUES ($1, $2, $3, 'message', 'issue', 75, ${when})`,
    [app.id, who.id, content],
  );

  const comments = [];
  const messages = [];
  const github = {
    async fetchPublicIssues() {
      return { issues: [{ number: 75, state: 'open', createdAt: '2026-09-30T15:40:00Z', updatedAt: '2026-09-30T15:41:00Z' }] };
    },
    async createIssueComment(owner, repo, n, text) { comments.push({ n, text }); return { id: comments.length }; },
  };
  const ws = {
    async sendBotMessage(p, appId, { content, thread }) {
      messages.push({ content, thread });
      return { id: 9000 + messages.length };
    },
  };
  const notifications = { async createMentionNotifications() { return []; }, async hydrateAndPush() {} };
  const refresh = () => bot.refreshApp(pool, app, {
    github, bot: homeroomBot, ws, notifications, capRoom: { proposals_per_app: 1, proposals_total: 1, question_tripwire: 1 },
  });
  const queued = async () => (await pool.query(
    'SELECT issue_number, reason FROM homeroom_bot_queue WHERE app_id = $1', [app.id],
  )).rows;
  const posts = async () => (await pool.query(
    `SELECT kind FROM homeroom_bot_posts WHERE app_id = $1 ORDER BY id`, [app.id],
  )).rows.map((r) => r.kind);

  await t.test('who holds it, and since when, on the real schema', async () => {
    const holders = await bot.issueHolders(pool, app.id);
    assert.deepEqual([...holders.keys()], [75]);
    const [hold] = holders.get(75);
    assert.deepEqual([hold.kind, hold.username], ['claim', chin.username]);
    assert.ok(hold.since);
  });

  await t.test('a comment that does not mention the bot gets nothing', async () => {
    await say(evan, 'any news on this?', "NOW() - INTERVAL '10 minutes'");
    const out = await refresh();
    assert.equal(out.queued, 0);
    assert.deepEqual(await posts(), []);
  });

  await t.test('a mention is answered once, with who holds it, and the request stays theirs', async () => {
    await say(evan, '@homeroom_bot try again?', "NOW() - INTERVAL '5 minutes'");
    assert.equal((await refresh()).queued, 0);
    assert.deepEqual(await posts(), [holds.LEAVING_KIND]);
    assert.match(messages[0].content,
      new RegExp(`^@${evan.username} ${chin.username} claimed this request 3 days ago, so Homeroom bot is leaving it to them\\. If you still want Homeroom bot to build it, mention it here again and it will go ahead\\.$`));
    assert.deepEqual(messages[0].thread, { type: 'issue', ref: 75 });
    await refresh();
    assert.deepEqual(await posts(), [holds.LEAVING_KIND], 'one answer per mention');
    assert.deepEqual(await queued(), []);
  });

  await t.test('a second mention is the go-ahead: the holder is told, and the request is queued', async () => {
    // evan claims it himself in between, as on #75: his own claim is no reason to stop.
    await pool.query(`INSERT INTO issue_claims (app_id, github_issue_number, user_id) VALUES ($1, 75, $2)`, [app.id, evan.id]);
    await say(evan, '@homeroom_bot yes, please build it');
    const out = await refresh();
    assert.equal(out.queued, 1);
    assert.deepEqual(await queued(), [{ issue_number: 75, reason: 'changed' }]);
    assert.deepEqual(await posts(), [holds.LEAVING_KIND, holds.GOING_KIND]);
    assert.match(messages[1].content,
      new RegExp(`^@${chin.username} ${evan.username} asked Homeroom bot to build this anyway, so it is taking it up now\\.`));
    // It lasts: the next refresh keeps it queued and says nothing more.
    await refresh();
    assert.deepEqual(await queued(), [{ issue_number: 75, reason: 'changed' }]);
    assert.equal(messages.length, 2);
  });

  await t.test('somebody starting on it after the go-ahead keeps the bot off it again', async () => {
    await pool.query(
      'INSERT INTO issue_claims (app_id, github_issue_number, user_id) VALUES ($1, 75, $2)',
      [app.id, sam.id],
    );
    const out = await refresh();
    assert.equal(out.queued, 0);
    assert.deepEqual(await queued(), [], 'its row leaves the queue, as any held request\'s does');
    assert.equal(messages.length, 2, 'and nobody mentioned the bot, so it says nothing');
  });

  await t.test('only on a live app: a shadow app neither answers nor goes ahead', async () => {
    await say(evan, '@homeroom_bot please');
    const out = await bot.refreshApp(pool, app, { github, bot: homeroomBot, ws, notifications, capRoom: null });
    assert.equal(out.queued, 0);
    assert.equal(messages.length, 2);
  });
});
