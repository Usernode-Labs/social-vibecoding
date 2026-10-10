'use strict';

// Whose weekly building time a Homeroom bot run counted toward, as the admin
// connector reads it (services/bench/connector-data.js billingOf and
// personWeek, over homeroom-bot.js RUNS_SQL): a run says who paid for it,
// and a person's week lists the charged runs that spent their allowance and
// adds up to what the allowance itself reads (homeroom-bot-dm.js
// weeklySpentCents).
//
// Run with: node --test tests/bot-person-week.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const data = require('../src/services/bench/connector-data');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a run says whose week it counted toward: the asker, the requester, or nobody', () => {
  assert.deepEqual(data.billingOf({ charged: true, payer_user_id: null, payer_username: 'evan' }),
    { charged: true, payer: 'evan', paidAs: 'requester' });
  assert.deepEqual(data.billingOf({ charged: true, payer_user_id: 7, payer_username: 'maya' }),
    { charged: true, payer: 'maya', paidAs: 'asked' });
  assert.deepEqual(data.billingOf({ charged: false, payer_user_id: 7, payer_username: 'maya' }),
    { charged: false, payer: null, paidAs: null }, 'a shadow run or the bot\'s own counts for nobody');
  assert.equal(data.billingOf({}), null, 'a payload without the columns says nothing');
});

test('a person is named by username, with or without its @', () => {
  assert.equal(data.personFilter({ username: '@evan' }), 'evan');
  assert.equal(data.personFilter({ username: ' maya_2 ' }), 'maya_2');
  assert.equal(data.personFilter({ username: 'two words' }), null);
  assert.equal(data.personFilter({}), null);
});

test('the overview carries each run\'s billing, and a person\'s week only when asked', async () => {
  const bot = {
    async adminPayload() {
      return {
        settings: { userWeeklyCents: 5000, adminWeeklyCents: 10000 }, queue: {}, runs: [
          { id: 2, app_slug: 'bread', issue_number: 3, verdict: 'ready', charged: true, payer_user_id: null, payer_username: 'evan', payer_email: 'never@example.com' },
          { id: 1, app_slug: 'bread', issue_number: 4, verdict: 'ready', mode: 'shadow', charged: false },
        ],
      };
    },
  };
  const out = await data.botOverview(null, {}, {}, { bot });
  assert.deepEqual(out.runs.map((r) => r.billing), [
    { charged: true, payer: 'evan', paidAs: 'requester' },
    { charged: false, payer: null, paidAs: null },
  ]);
  assert.equal(out.person, null);
  assert.doesNotMatch(JSON.stringify(out), /never@example\.com/);

  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push(params);
      if (/FROM users WHERE LOWER\(username\)/.test(sql)) return { rows: String(params[0]).toLowerCase() === 'evan' ? [{ id: 5, username: 'evan' }] : [] };
      return { rows: [] };
    },
  };
  const dm = { async weeklyCapCents(_p, settings, id) { return id === 5 ? settings.adminWeeklyCents : 0; }, async weeklySpentCents() { return 0; } };
  const week = await data.botOverview(pool, {}, { username: '@Evan' }, { bot, dm, weekStartUtc: () => new Date('2026-10-05T00:00:00Z') });
  assert.equal(queries[0][0], 'Evan', 'looked up as written, case-insensitively');
  assert.deepEqual([week.person.username, week.person.capCents, week.person.spentCents, week.person.usedUp], ['evan', 10000, 0, false]);
  const nobody = await data.botOverview(pool, {}, { username: 'ghost' }, { bot, dm });
  assert.deepEqual(nobody.person, { username: 'ghost', found: false });
});

test('a person\'s week against the full schema', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `person_week_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8'));

  const user = async (username, isAdmin = false) => (await pool.query(
    `INSERT INTO users (username, password, is_admin) VALUES ($1, 'x', $2) RETURNING id`, [username, isAdmin],
  )).rows[0].id;
  const evan = await user('evan', true);
  const maya = await user('maya');
  const app = (await pool.query(
    `INSERT INTO apps (name, slug, status, view_visibility, collab_visibility) VALUES ('Bread', 'bread', 'running', 'public', 'public') RETURNING id`,
  )).rows[0].id;
  // Evan filed #3 and #4, Maya #5.
  for (const [issue, who] of [[3, evan], [4, evan], [5, maya]]) {
    await pool.query('INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id) VALUES ($1, $2, $3)', [app, issue, who]);
  }
  // Monday 00:00 UTC, as limits.weekStartUtc names it ('YYYY-MM-DD').
  const weekStart = new Date(`${require('../src/services/limits').weekStartUtc()}T00:00:00Z`);
  const run = (issue, { mode = 'live', charged = true, payer = null, read = 0.02, build = 1, at = new Date() } = {}) => pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, cost_usd, build_cost_usd, charged, payer_user_id, build_ok, read_reason, created_at)
     VALUES ($1, $2, $3, 'ready', $4, $5, $6, $7, TRUE, 'new', $8) RETURNING id`,
    [app, issue, mode, read, build, charged, payer, at],
  );
  await run(3);                                          // Evan's request, Evan pays: $1.02
  await run(3, { read: 0.03, build: 0.97 });             // read again after a comment: $1.00
  await run(4, { mode: 'shadow', charged: false });      // a shadow build: nobody pays
  await run(4, { charged: false });                      // the bot fixing its own checks: nobody pays
  await run(5, { payer: evan, read: 0.01, build: 0.5 }); // Evan asked the bot to build Maya's: $0.51, his
  await run(4, { payer: maya, read: 0.01, build: 2 });   // Maya asked for Evan's: hers
  await run(3, { at: new Date(weekStart.getTime() - 60 * 1000) }); // last week

  const dm = require('../src/services/homeroom-bot-dm');
  const settings = { userWeeklyCents: 5000, adminWeeklyCents: 10000 };
  const week = await data.personWeek(pool, settings, 'Evan');
  assert.equal(week.spentCents, await dm.weeklySpentCents(pool, evan), 'the same total the allowance reads');
  assert.deepEqual([week.username, week.capCents, week.spentCents, week.leftCents, week.usedUp], ['evan', 10000, 253, 9747, false]);
  assert.deepEqual(week.runs.map((r) => [r.issueNumber, r.paidAs, r.totalUsd, r.buildState]), [
    [5, 'asked', 0.51, 'built'],
    [3, 'requester', 1, 'built'],
    [3, 'requester', 1.02, 'built'],
  ]);
  assert.deepEqual(week.requests, [
    { app: 'bread', issueNumber: 3, runs: 2, usd: 2.02 },
    { app: 'bread', issueNumber: 5, runs: 1, usd: 0.51 },
  ]);
  assert.equal(week.runsComplete, true);
  assert.equal(week.weekStart, weekStart.toISOString());
  const theirs = await data.personWeek(pool, settings, 'maya');
  assert.deepEqual([theirs.capCents, theirs.spentCents, theirs.runs.map((r) => r.issueNumber)], [5000, 201, [4]]);

  // The ledger's own page carries each run's payer, as the overview reads it.
  const bot = require('../src/services/homeroom-bot');
  const rows = [];
  for await (const chunk of bot.iterateRunsForExport(pool, {})) rows.push(...chunk);
  const billed = rows.map((r) => [Number(r.issue_number), r.mode, data.billingOf(r)]);
  assert.deepEqual(billed, [
    [3, 'live', { charged: true, payer: 'evan', paidAs: 'requester' }], // last week's: his, in last week
    [4, 'live', { charged: true, payer: 'maya', paidAs: 'asked' }],
    [5, 'live', { charged: true, payer: 'evan', paidAs: 'asked' }],
    [4, 'live', { charged: false, payer: null, paidAs: null }],
    [4, 'shadow', { charged: false, payer: null, paidAs: null }],
    [3, 'live', { charged: true, payer: 'evan', paidAs: 'requester' }],
    [3, 'live', { charged: true, payer: 'evan', paidAs: 'requester' }],
  ]);
});
