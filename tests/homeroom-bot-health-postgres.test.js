'use strict';

// The Homeroom bot dashboard's rollout health (services/homeroom-bot-health.js)
// against the full PostgreSQL schema: each figure counts what it says, over
// the last week, and leaves out what is older or somebody else's.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const health = require('../src/services/homeroom-bot-health');
const { BOT_USERNAME } = require('../src/services/homeroom-bot-live');
const { createSchemaDatabase } = require('./lib/schema-database');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('rollout health against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'bot_health_' + crypto.randomBytes(6).toString('hex');
  await createSchemaDatabase(admin, name);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2) RETURNING id`,
    [username, synthetic],
  )).rows[0].id;
  const bot = await user(BOT_USERNAME, true);
  const ada = await user('ada');
  const app = (await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url) VALUES ('Seed swap', 'seed-swap', 'running', $1, 'https://github.com/x/seed-swap') RETURNING id`,
    [ada],
  )).rows[0].id;

  // Proposals: filed `filedHoursAgo`, put up `upHoursAgo`, now `status`.
  let issue = 0;
  async function proposal({ owner = bot, status, filedHoursAgo, upHoursAgo }) {
    const n = ++issue;
    await pool.query(
      `INSERT INTO issues (app_id, github_issue_number, title, created_by, created_at) VALUES ($1, $2, 'Staging demo request', $3, NOW() - make_interval(hours => $4))`,
      [app, n, ada, filedHoursAgo],
    );
    const session = (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, promoted_at) VALUES ($1, $2, $3, NOW() - make_interval(hours => $4)) RETURNING id`,
      [app, owner, status, upHoursAgo],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id) VALUES ($1, $2, 'live', 'ready', $3)`,
      [app, n, session],
    );
  }
  await proposal({ status: 'merged', filedHoursAgo: 10, upHoursAgo: 9 }); // 1 h
  await proposal({ status: 'merged', filedHoursAgo: 30, upHoursAgo: 27 }); // 3 h
  await proposal({ status: 'archived', filedHoursAgo: 50, upHoursAgo: 40 }); // 10 h, withdrawn
  await proposal({ status: 'paused', filedHoursAgo: 60, upHoursAgo: 55 }); // 5 h, closed on GitHub
  await proposal({ status: 'promoted', filedHoursAgo: 3, upHoursAgo: 1 }); // 2 h, still up
  await proposal({ status: 'active', filedHoursAgo: 8, upHoursAgo: 4 }); // 4 h, being proposed again
  await proposal({ status: 'merged', filedHoursAgo: 400, upHoursAgo: 300 }); // before the week
  await proposal({ owner: ada, status: 'merged', filedHoursAgo: 5, upHoursAgo: 4 }); // a person's

  // Questions in Ada's DM with the bot.
  const conversation = (await pool.query(`INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id`, [bot])).rows[0].id;
  async function question(status, askedHoursAgo, answeredAfterMinutes = null) {
    const message = (await pool.query(
      `INSERT INTO conversation_messages (conversation_id, sender_id, content) VALUES ($1, $2, 'Staging demo question') RETURNING id`,
      [conversation, bot],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind, question_status, created_at, answered_at)
       VALUES ($1, $2, $3, $4, 1, 'question', $5, NOW() - make_interval(hours => $6),
               CASE WHEN $7::int IS NULL THEN NULL ELSE NOW() - make_interval(hours => $6) + make_interval(mins => $7::int) END)`,
      [message, ada, conversation, app, status, askedHoursAgo, answeredAfterMinutes],
    );
  }
  await question('answered', 20, 10);
  await question('answered', 30, 30);
  await question('answered', 40, 50);
  await question('closed', 50);
  await question('open', 5);
  await question('open', 24 * 20); // asked before the week, still waiting
  // A message that was news, not a question.
  await question(null, 2);

  // Runs and builds this week, and one before it.
  const run = (verdict, extra = {}) => pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, budget_stop, build_ok, created_at)
     VALUES ($1, 99, 'live', $2, $3, $4, NOW() - make_interval(hours => $5))`,
    [app, verdict, extra.budgetStop || null, extra.buildOk ?? null, extra.hoursAgo || 1],
  );
  await run('question');
  await run('failed');
  await run('failed', { budgetStop: 'wall clock' });
  await run('ready', { buildOk: false });
  await run('ready', { buildOk: true });
  await run('failed', { hoursAgo: 24 * 9 });

  // DM answers: fine, recovered, recovered after a claim, failed, broken.
  const turn = (error, failures, fallback, hoursAgo = 1) => pool.query(
    `INSERT INTO homeroom_bot_dm_turns (user_id, error, failures, fallback, created_at) VALUES ($1, $2, $3, $4, NOW() - make_interval(hours => $5))`,
    [ada, error, failures, fallback, hoursAgo],
  );
  await turn(null, [], null);
  await turn(null, ['r1:rate_limited:429'], null);
  await turn(null, ['claims:filed'], null);
  await turn('invalid_request', ['r1:invalid_request:400'], 'plain');
  await turn('turn_failed:timeout', ['plain:timeout'], 'broken');
  await turn('invalid_request', [], 'plain', 24 * 10);

  const h = await health.rolloutHealth(pool, { botUsername: BOT_USERNAME });

  await t.test('proposals: the week\'s, the bot\'s own, by how they ended, with the median wait from the request', () => {
    // The ready runs above point at no session, so they are not proposals.
    assert.deepEqual(
      { up: h.proposals.up, merged: h.proposals.merged, closed: h.proposals.closed, open: h.proposals.open, settled: h.proposals.settled },
      { up: 6, merged: 2, closed: 2, open: 2, settled: 4 },
    );
    assert.equal(h.proposals.mergeRate, 0.5);
    assert.equal(h.proposals.timed, 6);
    // 1, 2, 3, 4, 5 and 10 hours.
    assert.ok(Math.abs(h.proposals.medianHoursToProposal - 3.5) < 0.01, `median ${h.proposals.medianHoursToProposal}`);
    assert.ok(Math.abs(h.proposals.slowestHoursToProposal - 10) < 0.01);
  });

  await t.test('questions: the week\'s by how they ended, and every one still waiting', () => {
    assert.deepEqual(
      { asked: h.questions.asked, answered: h.questions.answered, settledOtherwise: h.questions.settledOtherwise, waitingOfAsked: h.questions.waitingOfAsked, waiting: h.questions.waiting },
      { asked: 5, answered: 3, settledOtherwise: 1, waitingOfAsked: 1, waiting: 2 },
    );
    assert.ok(Math.abs(h.questions.medianMinutesToAnswer - 30) < 0.01);
    const oldestDays = (Date.now() - Date.parse(h.questions.oldestWaitingAt)) / 86400000;
    assert.ok(oldestDays > 19.9 && oldestDays < 20.1, 'the oldest still waiting, whenever it was asked');
  });

  await t.test('turns and DM answers: failures, without budget stops or last week', () => {
    // The proposals' eight ready runs are this week's turns too.
    assert.deepEqual(h.turns, { runs: 13, failed: 1, builds: 2, buildsFailed: 1 });
    assert.deepEqual(h.chat, { turns: 5, failed: 2, unanswered: 1, recovered: 2, claimsCaught: 1 });
  });

  await t.test('too little behind a figure is no verdict; enough is', () => {
    assert.equal(h.watch.mergeRate, false, 'half merged is not under half');
    assert.equal(h.watch.hoursToProposal, false);
    assert.equal(h.watch.questionsWaiting, false, '1 of 5 waiting');
    assert.equal(h.watch.turnFailures, true, '2 of 15 is more than 1 in 10');
    assert.equal(h.watch.chatFailures, null, '5 answers is too few');
  });
});
