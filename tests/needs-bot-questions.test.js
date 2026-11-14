'use strict';

// #6019: Homeroom bot's questions in Needs you. The bot asks in a request's
// public discussion, so Needs you holds the questions nobody answered yet,
// each opening its request, where it is answered; the chat with the bot is
// private (homeroom-bot-mayor.js offerPost).
//
// What this pins:
//   1. GET /api/workshop/bot-questions still answers the viewer's own open
//      questions (kept for a client still loading the block it fed), newest
//      first, on projects not suspended; signed out, a 401. 5 Nov 2026
//      (docs/plans/bot-one-model.md, step 4): an open question is one the
//      bot posted on the request while its stored work state waits for the
//      requester's answer, or one still open in their chat with the bot
//      from before; needs-bot-questions-postgres.test.js runs both.
//   2. The questions are an arm of the Needs you feed itself and of its
//      counts (workshop-overview.js), so a badge and the feed agree, and a
//      feed card opens its request's page.
//   3. The block of its own is gone from Communities' Needs you.
//
// Run with: node --test tests/needs-bot-questions.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

// The routes take their pool from db/pool at load, so the fake is put in
// before they are first required.
const calls = [];
require('../src/db/pool').getPool = () => ({
  async query(sql, params) {
    calls.push({ sql, params });
    return {
      rows: /AS message_id, q\.issue_number/.test(sql)
        ? [{ message_id: 9, issue_number: 7, created_at: '2026-10-29T10:00:00Z', slug: 'seed-swap', name: 'Seed swap', question: 'Newest first?' }]
        : [],
    };
  },
});

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const REEL = 'frontend/src/features/workshop/needs-reel.tsx';

test('the read is the viewer\'s own open questions, newest first, on projects not suspended', () => {
  const { BOT_QUESTIONS_SQL, BOT_QUESTIONS_MAX } = require('../src/routes/workshop-overview');
  assert.match(BOT_QUESTIONS_SQL, /WHERE dq\.user_id = \$1 AND dq\.question_status = 'open'/);
  assert.match(BOT_QUESTIONS_SQL, /WHERE ws\.requester_id = \$1 AND ws\.item_kind = 'request'\s+AND ws\.stage = 'waiting_for_you' AND ws\.why = 'question'/);
  assert.match(BOT_QUESTIONS_SQL, /a\.moderation_suspended_at IS NULL/);
  assert.match(BOT_QUESTIONS_SQL, /dqm\.deleted_at IS NULL/);
  assert.match(BOT_QUESTIONS_SQL, /qpm\.deleted_at IS NULL/);
  assert.match(BOT_QUESTIONS_SQL, /ORDER BY q\.created_at DESC\s+LIMIT \$2/);
  assert.equal(BOT_QUESTIONS_MAX, 20);
});

test('the route answers in the list\'s shape, and 401 signed out', async () => {
  let server;
  try {
    const { workshopOverviewRoutes } = require('../src/routes/workshop-overview');
    const app = express();
    app.use((req, _res, next) => { if (req.get('x-user')) req.user = { id: Number(req.get('x-user')) }; next(); });
    app.use(workshopOverviewRoutes({}));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/workshop/bot-questions`;
    assert.equal((await fetch(base)).status, 401);
    const res = await fetch(base, { headers: { 'x-user': '4' } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      questions: [{ messageId: 9, appSlug: 'seed-swap', appName: 'Seed swap', issueNumber: 7, question: 'Newest first?', at: '2026-10-29T10:00:00Z' }],
    });
    assert.deepEqual(calls.find((c) => /AS message_id, q\.issue_number/.test(c.sql)).params, [4, 20]);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
  }
});

test('the questions are an arm of the feed and of its counts', () => {
  const overview = require('../src/routes/workshop-overview');
  assert.match(overview.NEEDS_FEED_SQL, /SELECT 'question', q\.app_id, q\.id,/);
  assert.match(overview.NEEDS_FEED_SQL, /WHERE dq\.user_id = \$1 AND dq\.question_status = 'open'/);
  assert.match(overview.NEEDS_FEED_SQL, /AND ws\.stage = 'waiting_for_you' AND ws\.why = 'question'/);
  const src = read('src/routes/workshop-overview.js');
  assert.match(src, /owed_questions AS \(\s+SELECT q\.app_id, COUNT\(\*\)::int AS n,\s+array_agg\('question:' \|\| q\.id\) AS keys/,
    'counted where the votes are, under keys the seen record takes');
  assert.match(src, /\+ COALESCE\(oq\.n, 0\)\) AS needs/,
    'the question count is not gated: a question is the viewer\'s wherever it is');
  assert.equal((src.match(/CASE WHEN \$\{CAN_TAKE_PART_SQL\} THEN COALESCE\(o[pg]\.n, 0\) ELSE 0 END\)/g) || []).length, 4,
    'only the two vote counts are gated (#6664), in the counts and in the outer filter');
  assert.match(src, /SELECT 'needs', 'question', q\.app_id, q\.id,/, 'and listed with the rows behind the counts');
  const [item] = overview.shapeNeedsFeed([{
    kind: 'question', id: 9, title: 'Newest first?', author: 'homeroom_bot', number: 7,
    at: '2026-10-29T10:00:00Z', slug: 'seed-swap', name: 'Seed swap',
  }]);
  assert.equal(item.kind, 'question');
  assert.equal(item.number, 7);
  assert.equal(item.staging_url, undefined, 'no preview: it is not a change');
});

test('a question\'s card opens its request, where it is answered', () => {
  const { reelRows } = loadTsx(REEL);
  const [row] = reelRows([{
    kind: 'question', id: 9, title: 'Newest first?', summary: null, author: 'homeroom_bot', number: 7, epoch: null,
    at: '2026-10-29T10:00:00Z', yes: null, no: null, app: { slug: 'seed-swap', name: 'Seed swap', icon_url: null, icon_emoji: null },
  }]);
  assert.equal(row.card.attrs['data-issue-row'], '7', 'its request page is where the card opens');
  assert.equal(row.card.attrs['data-bot-question'], '9');
  assert.equal(row.yes, null);
  assert.equal(row.no, null, 'answered on the page, so the sheet opens it');
  assert.equal(row.askAbout, null, 'no vote, so no key the seen record could mistake for a change\'s');
  assert.equal(message('project:needsYou.eyebrow.botQuestion'), 'Homeroom bot asked you');
});

test('Communities\' Needs you no longer draws a block of its own', () => {
  const screen = read('frontend/src/features/workshop/index.tsx');
  assert.doesNotMatch(screen, /BotQuestions/);
  assert.ok(!fs.existsSync(path.join(ROOT, 'frontend/src/features/workshop/bot-questions.tsx')));
});
