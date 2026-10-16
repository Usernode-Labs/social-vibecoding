'use strict';

// #4772: what Homeroom bot waits on one viewer for, on one project, for the
// Workshop tab's Waiting on you (services/workshop-waiting.js), and the
// request list that carries it to the board (routes/issues.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const waiting = require('../src/services/workshop-waiting');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function fakePool(answers) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return { rows: next || [] };
    },
  };
}

test('nothing is read without a project and a viewer', async () => {
  const pool = fakePool([]);
  assert.deepEqual(await waiting.waitingOnViewer(pool, { appId: 7, userId: null }), { plans: [], questions: [] });
  assert.deepEqual(await waiting.waitingOnViewer(pool, { appId: null, userId: 5 }), { plans: [], questions: [] });
  assert.equal(pool.calls.length, 0);
});

test('plans and questions, each the viewer\'s own, newest first', async () => {
  const at = new Date('2026-10-12T10:00:00Z');
  const pool = fakePool([
    [{ issue_number: 13, at }],
    [{ issue_number: '12', at }],
  ]);
  const out = await waiting.waitingOnViewer(pool, { appId: 7, userId: 5 });
  assert.deepEqual(out, {
    plans: [{ number: 13, at: at.toISOString() }],
    questions: [{ number: 12, at: at.toISOString() }],
  });
  assert.deepEqual(pool.calls.map((c) => c.params), [
    [7, 5, waiting.MAX_EACH],
    [7, 5, waiting.MAX_EACH],
  ]);
});

test('#5229: a back and forth with the bot is not waiting on the viewer, whoever spoke last', async () => {
  // Two reads and no third: there is no query of the discussions the viewer
  // and the bot both wrote in, and no `talks` in the answer.
  const pool = fakePool([[], [], [{ thread_type: 'session', thread_ref: 34, bot_last: true }]]);
  const out = await waiting.waitingOnViewer(pool, { appId: 7, userId: 5, botId: 3 });
  assert.equal(pool.calls.length, 2);
  assert.deepEqual(Object.keys(out).sort(), ['plans', 'questions']);
  assert.equal('talks' in out, false);
  assert.equal(waiting.TALKS_SQL, undefined);
  assert.equal(waiting.TALK_DAYS, undefined);
  assert.equal(waiting.BOT_HOLD_DAYS, undefined);
});

test('the plan is the request\'s NEWEST run waiting for Build it, on a request recorded as the viewer\'s', () => {
  const sql = waiting.PLANS_SQL;
  assert.match(sql, /FROM homeroom_bot_requesters q/);
  assert.match(sql, /WHERE q\.app_id = \$1 AND q\.user_id = \$2/);
  assert.match(sql, /ORDER BY id DESC LIMIT 1\s*\) run ON TRUE/, 'the newest run decides');
  assert.match(sql, /run\.awaiting_go_at IS NOT NULL AND run\.build_ok IS NULL/);
  assert.match(sql, /run\.build_session_id IS NULL AND run\.proposal_session_id IS NULL/);
});

test('a question is one asked of the viewer that is still open', () => {
  assert.match(waiting.QUESTIONS_SQL, /FROM homeroom_bot_dm_messages/);
  assert.match(waiting.QUESTIONS_SQL, /app_id = \$1 AND user_id = \$2 AND question_status = 'open'/);
});

test('a failed read is nothing waiting', async () => {
  const broken = fakePool([new Error('boom')]);
  assert.deepEqual(await waiting.waitingOnViewer(broken, { appId: 7, userId: 5 }), { plans: [], questions: [] });
});

test('the request list carries it, and the staging demo shows a plan and a question', () => {
  const route = read('src/routes/issues.js');
  assert.match(route, /const waitingOnYou = IS_STAGING && req\.query\.demo === '1'\s*\? workshopWaiting\.demoWaiting\(\)\s*: await workshopWaiting\.waitingOnViewer\(pool, \{/);
  assert.match(route, /\.\.\.\(botDoor \? \{ homeroomBot: botDoor \} : \{\}\),\s*waitingOnYou,\s*\}\);/);
  const demo = waiting.demoWaiting(Date.parse('2026-10-12T12:00:00Z'));
  assert.deepEqual(demo.plans.map((p) => p.number), [900016]);
  assert.deepEqual(demo.questions.map((q) => q.number), [900015]);
  assert.equal(demo.talks, undefined);
  // #5229: the route no longer looks the bot up for this read.
  assert.doesNotMatch(route, /waitingOnViewer\(pool, \{[^}]*botId/);
  // The board keeps it with the list's other per-viewer facts.
  assert.match(read('public/js/app-view.js'), /waitingOnYou: \(ghData && ghData\.waitingOnYou && typeof ghData\.waitingOnYou === 'object'\) \? ghData\.waitingOnYou : null,/);
});

test('the ?demo=1 mocks give the viewer a change up for a vote and one that needs a fix', () => {
  const votes = read('src/routes/votes.js');
  assert.match(votes, /const OWN_DEMO_PROPOSALS = new Set\(\[9000493, 9000494\]\);/);
  assert.match(votes, /OWN_DEMO_PROPOSALS\.has\(row\.id\)\s*\? \{ \.\.\.row, user_id: user\.id, username: user\.username \} : row/);
  assert.match(votes, /rows\.push\(\.\.\.ownDemoProposals\(stagingMockProposals\(req\.user\?\.username\), req\.user\)/);
});
