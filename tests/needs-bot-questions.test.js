'use strict';

// #6019: Homeroom bot's questions in Needs you. The bot asks in a request's
// public discussion, so Needs you lists the questions nobody answered yet,
// each opening its request, where it is answered; the chat with the bot is
// private (homeroom-bot-mayor.js offerPost).
//
// What this pins:
//   1. GET /api/workshop/bot-questions answers the viewer's own open
//      questions, newest first, on projects not suspended, in the shape the
//      list draws; signed out, a 401.
//   2. The list draws nothing until it has a question, and each row opens
//      its request's page.
//   3. Communities' Needs you mounts it above the votes.
//
// Run with: node --test tests/needs-bot-questions.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

// The routes take their pool from db/pool at load, so the fake is put in
// before they are first required.
const calls = [];
require('../src/db/pool').getPool = () => ({
  async query(sql, params) {
    calls.push({ sql, params });
    return {
      rows: /homeroom_bot_dm_messages q/.test(sql)
        ? [{ message_id: 9, issue_number: 7, created_at: '2026-10-29T10:00:00Z', slug: 'seed-swap', name: 'Seed swap', question: 'Newest first?' }]
        : [],
    };
  },
});

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const LIST = 'frontend/src/features/workshop/bot-questions.tsx';

test('the read is the viewer\'s own open questions, newest first, on projects not suspended', () => {
  const { BOT_QUESTIONS_SQL, BOT_QUESTIONS_MAX } = require('../src/routes/workshop-overview');
  assert.match(BOT_QUESTIONS_SQL, /WHERE q\.user_id = \$1 AND q\.question_status = 'open'/);
  assert.match(BOT_QUESTIONS_SQL, /a\.moderation_suspended_at IS NULL/);
  assert.match(BOT_QUESTIONS_SQL, /m\.deleted_at IS NULL/);
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
    assert.deepEqual(calls.find((c) => /homeroom_bot_dm_messages q/.test(c.sql)).params, [4, 20]);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
  }
});

test('the list draws nothing until a question lands, and each row opens its request', () => {
  assert.equal(renderComponent(LIST, 'BotQuestions', {}), '', 'the first render is the prerender\'s');
  const { questionHref } = loadTsx(LIST);
  assert.equal(questionHref({ appSlug: 'seed-swap', issueNumber: 7 }), '#app/seed-swap/dev/issues/7');
  const src = read(LIST);
  assert.match(src, /fetch\('\/api\/workshop\/bot-questions'/);
  assert.match(src, /if \(!rows\.length\) return null;/, 'nothing asked says nothing');
  assert.match(src, /import \{ GroupedList, ListRow, SectionHeader \} from '@\/components\/ui\/grouped-list';/);
  assert.equal(message('communities:needs.botAsked.label'), 'Homeroom bot asked you');
  assert.equal(message('communities:needs.botAsked.where', { project: 'Seed swap', number: 7 }), 'Seed swap · Request #7');
});

test('Communities\' Needs you mounts it above the votes', () => {
  const screen = read('frontend/src/features/workshop/index.tsx');
  const list = screen.indexOf('<BotQuestions />');
  assert.ok(list > 0);
  assert.ok(list < screen.indexOf('<ReviewFlow') && list < screen.indexOf('<NeedsReel'), 'above the votes, in either look');
});
