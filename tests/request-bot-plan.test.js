'use strict';

// #6207/#6210 (3 Nov 2026; Evan: the plan card is shown to everyone reading
// the request, and any member may start the build). Homeroom bot's plan is
// on its request's page for everyone (request-plan.tsx, GET …/bot-plan), and
// any member may press Build it (POST …/bot-plan/build): the presser's week
// pays, the requester is told in the request's thread, and while a change to
// the plan is on its way it waits. The requester's own press still goes
// through their chat card (decidePlanTap), so that card reads Built.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const plan = require('../src/services/homeroom-bot-public-plan');

test('the card is the plan\'s own text when it carries it, else its bullets; its choices, suggested first', () => {
  assert.deepEqual(plan.cardOf({ bullets: ['Open the row', 'Show the plan'] }), {
    summary: '', lines: [{ n: null, text: 'Open the row' }, { n: null, text: 'Show the plan' }],
  });
  assert.deepEqual(plan.cardOf({
    bullets: ['cut'], card: { summary: 'Rows open their page.', lines: [{ n: 1, text: 'A row opens its page.' }, { n: 0, text: 'Nothing else moves.' }] },
  }), { summary: 'Rows open their page.', lines: [{ n: 1, text: 'A row opens its page.' }, { n: null, text: 'Nothing else moves.' }] });
  assert.deepEqual(plan.choicesOf({ questions: [{ question: 'Keep old previews?', answers: ['Yes', 'No'] }, { question: '', answers: ['x'] }] }),
    [{ question: 'Keep old previews?', answers: ['Yes', 'No'] }]);
});

// A pool that answers each query by what it asks, and records it.
function fakePool({ run, queued = false, action = null, requester = { userId: 1, username: 'evan' } }) {
  const said = [];
  return {
    said,
    requester,
    async query(sql, params) {
      said.push({ sql, params });
      if (/FROM homeroom_bot_runs r/.test(sql)) return { rows: run ? [run] : [] };
      if (/FROM homeroom_bot_queue/.test(sql)) return { rows: queued ? [{}] : [] };
      if (/JOIN bot_cards a/.test(sql)) return { rows: action ? [action] : [] };
      return { rows: [], rowCount: 1 };
    },
  };
}
const waitingRun = { id: 4436, plan: { complicated: true, bullets: ['x'] }, awaiting_go_at: '2026-11-03T12:14:00Z', build_ok: null, build_session_id: null };

function deps(pool, { over = false, went = { ok: true, chosen: [] } } = {}) {
  const calls = [];
  return {
    calls,
    dm: {
      requesterOf: async () => pool.requester,
      overWeeklyAllowance: async (_p, _s, userId) => { calls.push(['allowance', userId]); return over; },
      decidePlanTap: async (_p, args) => { calls.push(['tap', args.user.id]); return { ok: true }; },
      markPlanBuilt: async (_p, runId) => { calls.push(['built', runId]); },
    },
    botSvc: {
      readSettings: async () => ({}),
      goAhead: async (_p, args) => { calls.push(['goAhead', args.runId, args.answers]); return went; },
    },
    wsSvc: { sendSystemMessage: async (_p, appId, text, _k, _m, thread) => { calls.push(['said', text, thread]); } },
  };
}
const app = { id: 9, slug: 'usernode-2d5619' };

test('another member\'s Build it is paid from their week, and the requester is told in the request\'s thread', async () => {
  const pool = fakePool({ run: waitingRun });
  const d = deps(pool);
  const went = await plan.buildPlan(pool, { app, issueNumber: 6210, user: { id: 2, username: 'maria' }, answers: ['Yes'], deps: d });
  assert.deepEqual(went, { ok: true });
  assert.deepEqual(d.calls.find((c) => c[0] === 'allowance'), ['allowance', 2], 'the presser\'s week, not the requester\'s');
  const payer = pool.said.find((q) => /SET payer_user_id = \$2/.test(q.sql));
  assert.deepEqual(payer.params, [4436, 2]);
  assert.deepEqual(d.calls.find((c) => c[0] === 'goAhead'), ['goAhead', 4436, ['Yes']]);
  assert.ok(d.calls.some((c) => c[0] === 'built'), 'the requester\'s card reads Built');
  const said = d.calls.find((c) => c[0] === 'said');
  assert.match(said[1], /^@maria pressed Build it on @evan's plan\./);
  assert.deepEqual(said[2], { type: 'issue', ref: 6210 }, 'the request\'s own thread, never the project\'s channel');
});

test('Build it waits while a change is on its way, and when the presser\'s week is used up', async () => {
  const changing = fakePool({ run: waitingRun, queued: true });
  assert.deepEqual(await plan.buildPlan(changing, { app, issueNumber: 6210, user: { id: 2, username: 'maria' }, deps: deps(changing) }),
    { ok: false, status: 409, error: 'plan_changing' });
  const spent = fakePool({ run: waitingRun });
  const d = deps(spent, { over: true });
  assert.deepEqual(await plan.buildPlan(spent, { app, issueNumber: 6210, user: { id: 2, username: 'maria' }, deps: d }),
    { ok: false, status: 409, error: 'allowance' });
  assert.ok(!d.calls.some((c) => c[0] === 'goAhead'), 'nothing is built');
  const gone = fakePool({ run: null });
  assert.deepEqual(await plan.buildPlan(gone, { app, issueNumber: 6210, user: { id: 2 }, deps: deps(gone) }),
    { ok: false, status: 409, error: 'plan_gone' });
  const stale = fakePool({ run: waitingRun });
  assert.equal((await plan.buildPlan(stale, { app, issueNumber: 6210, user: { id: 2 }, runId: 4400, deps: deps(stale) })).error, 'plan_gone',
    'a card drawn for an older plan builds nothing');
});

test('the requester\'s own press goes through their chat card, from their own week', async () => {
  const pool = fakePool({ run: waitingRun, action: { id: 77, message_id: 900 } });
  const d = deps(pool);
  assert.deepEqual(await plan.buildPlan(pool, { app, issueNumber: 6210, user: { id: 1, username: 'evan' }, deps: d }), { ok: true });
  assert.deepEqual(d.calls.map((c) => c[0]), ['tap']);
  assert.ok(!pool.said.some((q) => /payer_user_id/.test(q.sql)));
});

test('the routes: anyone who can read the request reads the plan; Build it is for members', () => {
  const routes = read('src/routes/request-specs.js');
  assert.match(routes, /router\.get\('\/api\/apps\/:slug\/issues\/:number\/bot-plan', async \(req, res\) => \{/);
  assert.match(routes, /router\.post\('\/api\/apps\/:slug\/issues\/:number\/bot-plan\/build', conversationActionLimiter, sameOriginBrowserOnly,\s+communities\.requireAppMembership\(pool\), async/);
  assert.match(routes, /if \(!req\.user \|\| req\.user\.isSynthetic\) return res\.status\(403\)/);
});

test('the request\'s page draws the plan once it is read, with Build it, and Change something replies on the request', () => {
  const card = loadTsx('frontend/src/features/dev-board/topic/request-plan.tsx');
  const read1 = { plan: { runId: 4436, state: 'waiting', title: 'Open a plan row on its page', summary: '', lines: [{ n: 1, text: 'A row opens its page.' }], choices: [], spec: null, postId: 31, requester: 'evan', mine: false, changing: false } };
  assert.equal(card.planFromRead(read1).runId, 4436);
  assert.equal(card.planFromRead({ plan: null }), null);
  assert.equal(card.planFromRead({ plan: { runId: 1, state: 'other' } }), null);
  assert.equal(card.planCardState(card.planFromRead(read1)), 'open');
  assert.equal(card.planCardState({ ...read1.plan, changing: true }), 'changing');
  assert.equal(card.planCardState({ ...read1.plan, state: 'building' }), 'built');
  // #6280: the sub-line follows the plan's state. While it waits, who it
  // waits for; once Build it is pressed, that it is being built, never
  // "waiting for you".
  assert.deepEqual(card.planSubOf({ ...read1.plan, mine: true }, 6210),
    { id: 'project:topic.request.botPlan.subYours', values: { number: '6210' } });
  assert.equal(message('project:topic.request.botPlan.subYours', { number: '6210' }), 'Plan for #6210 · waiting for you');
  assert.deepEqual(card.planSubOf({ ...read1.plan, mine: false, requester: 'evan' }, 6210),
    { id: 'project:topic.request.botPlan.subTheirs', values: { number: '6210', requester: 'evan' } });
  assert.deepEqual(card.planSubOf({ ...read1.plan, mine: true, state: 'building' }, 6210),
    { id: 'project:topic.request.botPlan.subBuilding', values: { number: '6210' } });
  assert.equal(message('project:topic.request.botPlan.subBuilding', { number: '6210' }), 'Plan for #6210 · building');
  assert.equal(card.planSubOf({ ...read1.plan, state: 'done' }, 6210), null, 'nothing to say once it is done');
  const src = read('frontend/src/features/dev-board/topic/request-plan.tsx');
  assert.match(src, /chat\.setQuote\(\{ source: 'message', refMsgId: plan\.postId, author: 'homeroom_bot'/, 'a public reply quoting the bot\'s post of the plan');
  assert.match(src, /document\.getElementById\('gc-thread-input'\)/);
  assert.match(src, /\/bot-plan\/build`, \{\s+method: 'POST'/);
  // Read in an effect: the first render is empty, the prerender's.
  const { renderComponent } = require('./lib/render-tsx');
  assert.equal(renderComponent('frontend/src/features/dev-board/topic/request-plan.tsx', 'RequestPlan', { slug: 'garden', number: 12 }), '');
  assert.match(read('frontend/src/features/dev-board/topic/request-head.tsx'),
    /\{working \|\| r\.status\.closed \|\| !slug \? null : <RequestPlan slug=\{slug\} number=\{r\.number\} specs=\{specs\} \/>\}/);
  // The words.
  assert.equal(message('project:topic.request.botPlan.subYours', { number: '6210' }), 'Plan for #6210 · waiting for you');
  assert.equal(message('project:topic.request.botPlan.subTheirs', { number: '6210', requester: 'evan' }), '@evan\'s plan for #6210 · any member can build it');
  // 11 Nov 2026 (one model): the status card above it says the standing's
  // own words, the ones the Homeroom bot tab says for it.
  assert.equal(message('changes:request.status.lead.stands', { stage: message('core:work.why.plan') }), 'Waiting for you to OK the plan.');
});
