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
  // #5385: the bot's in-hand work rides the same answer, after waitingOnYou.
  assert.match(route, /\.\.\.\(botDoor \? \{ homeroomBot: botDoor \} : \{\}\),\s*waitingOnYou,\s*homeroomBotWork,\s*\}\);/);
  const demo = waiting.demoWaiting(Date.parse('2026-10-12T12:00:00Z'));
  assert.deepEqual(demo.plans.map((p) => p.number), [900016]);
  assert.deepEqual(demo.questions.map((q) => q.number), [900015]);
  assert.equal(demo.talks, undefined);
  // #5229: the route no longer looks the bot up for this read.
  assert.doesNotMatch(route, /waitingOnViewer\(pool, \{[^}]*botId/);
  // The board keeps it with the list's other per-viewer facts.
  assert.match(read('public/js/app-view.js'), /waitingOnYou: \(ghData && ghData\.waitingOnYou && typeof ghData\.waitingOnYou === 'object'\) \? ghData\.waitingOnYou : null,/);
});

test('the ?demo=1 mocks give the viewer a change up for a vote, one that needs a fix, and one that needs their Yes', () => {
  const votes = read('src/routes/votes.js');
  assert.match(votes, /const OWN_DEMO_PROPOSALS = new Set\(\[9000493, 9000494, 9000495\]\);/);
  // #6006: the third came from a coding agent, so it waits on its author.
  assert.match(votes, /mk\(9000495, 900495,\n\s+'\[Mock\] Your change from Claude Code: waiting for your Yes',[^}]*\}\),\n\s+external_agent: 'claude-code',/);
  assert.match(votes, /OWN_DEMO_PROPOSALS\.has\(row\.id\)\s*\? \{ \.\.\.row, user_id: user\.id, username: user\.username \} : row/);
  assert.match(votes, /rows\.push\(\.\.\.ownDemoProposals\(stagingMockProposals\(req\.user\?\.username\), req\.user\)/);
});

// ── #5385: what the bot has in hand or needs from the viewer ──

const trackOf = (job, extra = {}) => require('../src/services/homeroom-bot-track').trackOf({ job, ...extra });
const job = (over = {}) => ({
  key: 'demo-app#13', appSlug: 'demo-app', appName: 'Demo app', issueNumber: 13, title: 'Keyboard voting',
  firstVersion: false, ...over,
});

test('#5385: botEntryOf reads a track as in hand, waiting, or nothing', () => {
  // In hand: each of the drawer's in-progress states and a hold for a slot.
  assert.deepEqual(waiting.botEntryOf(trackOf(job({ stage: 'building', since: '2026-10-17T10:00:00Z' })), 'demo-app'),
    { number: 13, waiting: false, track: trackOf(job({ stage: 'building', since: '2026-10-17T10:00:00Z' })) });
  assert.ok(waiting.botEntryOf(trackOf(job({ stage: 'queued' })), 'demo-app'), 'queued is in hand');
  assert.ok(waiting.botEntryOf(trackOf(job({ stage: 'reading', since: 'x' })), 'demo-app'), 'reading the request');
  assert.ok(waiting.botEntryOf(trackOf(job({ stage: 'checks', since: 'x' })), 'demo-app'), 'its checks running');
  const held = waiting.botEntryOf(trackOf(job({ outcome: 'held' }), { held: { position: 2, limit: 'slots' } }), 'demo-app');
  assert.equal(held.waiting, false, 'a hold for a slot is in hand, not waiting');
  // Waiting on the viewer.
  const blocked = waiting.botEntryOf(trackOf(job({ outcome: 'blocked' })), 'demo-app');
  assert.equal(blocked.waiting, true, 'it cannot build the request as written');
  assert.equal(waiting.botEntryOf(trackOf(job({ stage: 'checks_failed', since: 'x', outcome: 'person' }),
    { runs: [{ id: 1, verdict: 'ready', created_at: 'x', build_ok: false }] }), 'demo-app').waiting, true,
  'failing checks handed to a person');
  assert.ok(waiting.botEntryOf(trackOf(job({ stage: 'question', since: 'x' })), 'demo-app').waiting, 'a question waits');
  // Nothing to draw.
  assert.equal(waiting.botEntryOf(trackOf(job({ stage: 'held', since: 'x', outcome: 'held' }),
    { held: { position: null, limit: 'taken', by: 'maya' } }), 'demo-app'), null,
  'a request a person has taken: the bot leaves it alone');
  assert.equal(waiting.botEntryOf(trackOf(job({ stage: 'vote', since: 'x' })), 'demo-app'), null, 'up for a vote is the proposal rows');
  assert.equal(waiting.botEntryOf(trackOf(job({ outcome: 'live' })), 'demo-app'), null, 'live is History');
  assert.equal(waiting.botEntryOf(trackOf(job({ outcome: 'stopped' })), 'demo-app'), null, 'stopped is History');
  assert.equal(waiting.botEntryOf(trackOf(job({ outcome: 'closed' })), 'demo-app'), null, 'closed');
  // Not on this project, not a request with a number, not a first version.
  assert.equal(waiting.botEntryOf(trackOf(job({ stage: 'building', since: 'x' })), 'other-app'), null);
  assert.equal(waiting.botEntryOf(trackOf(job({ stage: 'building', since: 'x', issueNumber: null, firstVersion: true })), 'demo-app'), null,
    'a first version is not a request on the board');
  assert.equal(waiting.botEntryOf(null, 'demo-app'), null);
});

test('#5385: botWorkOnApp reads the drawer\'s tracks for one project, one entry per request', async () => {
  const pool = fakePool([]);
  const tracks = [
    { ...trackOf(job({ stage: 'building', since: 'x' })) },
    { ...trackOf(job({ stage: 'planning', since: 'x', issueNumber: 14 })) },
    { ...trackOf(job({ issueNumber: 13, outcome: 'held' }), { held: { position: 1, limit: 'slots' } }) },
    { ...trackOf(job({ stage: 'vote', since: 'x', issueNumber: 15 })) },
    { ...trackOf(job({ stage: 'building', since: 'x', appSlug: 'elsewhere' })) },
  ];
  const tray = { workFor: async () => ({ tracks }) };
  const out = await waiting.botWorkOnApp(pool, { app: { slug: 'demo-app' }, user: { id: 5 }, deps: { tray } });
  assert.deepEqual(out.map((e) => e.number), [13, 14], 'this project, in hand only, one entry per request');
  assert.equal(out.every((e) => e.waiting === false), true);
  assert.equal(pool.calls.length, 0, 'botWorkOnApp reads through the tray, not its own queries');
  // The viewer's answer is capped.
  const many = [];
  for (let i = 1; i <= waiting.MAX_BOT + 5; i += 1) many.push({ ...trackOf(job({ stage: 'queued', issueNumber: i })) });
  const capped = await waiting.botWorkOnApp(pool, { app: { slug: 'demo-app' }, user: { id: 5 }, deps: { tray: { workFor: async () => ({ tracks: many }) } } });
  assert.equal(capped.length, waiting.MAX_BOT);
});

test('#5385: a failed read is nothing in hand, never a failed board', async () => {
  const pool = fakePool([]);
  const tray = { workFor: async () => { throw new Error('boom'); } };
  assert.deepEqual(await waiting.botWorkOnApp(pool, { app: { slug: 'demo-app' }, user: { id: 5 }, deps: { tray } }), []);
  assert.deepEqual(await waiting.botWorkOnApp(pool, { app: { slug: 'demo-app' }, user: null }), []);
});

test('#5385: the request list carries it, and the staging demo shows one in hand and one waiting', () => {
  const route = read('src/routes/issues.js');
  assert.match(route, /const homeroomBotWork = IS_STAGING && req\.query\.demo === '1'\s*\? workshopWaiting\.demoBotWork\(app\)\s*: await workshopWaiting\.botWorkOnApp\(pool, \{ app, user: req\.user \}\);/);
  assert.match(route, /waitingOnYou,\s*homeroomBotWork,\s*\}\);/);
  const app = { slug: 'demo-app', name: 'Demo app' };
  const demo = waiting.demoBotWork(app);
  assert.deepEqual(demo.map((e) => e.number), [900018, 900013]);
  assert.equal(demo[0].waiting, false);
  assert.equal(demo[0].track.state, 'building', '900018: the bot is building it');
  assert.equal(demo[1].waiting, true);
  assert.equal(demo[1].track.state, 'waiting');
  assert.equal(demo[1].track.why, 'detail', '900013: it cannot build this as written');
  // And the client keeps it with the list's other per-viewer facts.
  assert.match(read('public/js/app-view.js'), /homeroomBotWork: Array\.isArray\(ghData && ghData\.homeroomBotWork\) \? ghData\.homeroomBotWork : \[\],/);
});
