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
function fakePool({ run, queued = false, action = null, requester = { userId: 1, username: 'evan' }, newest = null, change = null }) {
  const said = [];
  return {
    said,
    requester,
    async query(sql, params) {
      said.push({ sql, params });
      if (/FROM homeroom_bot_runs r\b/.test(sql)) return { rows: run ? [run] : [] };
      if (/FROM homeroom_bot_runs\b/.test(sql)) return { rows: newest ? [newest] : [] };
      if (/FROM chat_sessions\b/.test(sql)) return { rows: change ? [change] : [] };
      if (/FROM homeroom_bot_queue/.test(sql)) return { rows: queued ? [{}] : [] };
      if (/JOIN bot_cards a/.test(sql)) return { rows: action ? [action] : [] };
      return { rows: [], rowCount: 1 };
    },
  };
}
const waitingRun = { id: 4436, plan: { complicated: true, bullets: ['x'] }, awaiting_go_at: '2026-11-03T12:14:00Z', build_ok: null, build_session_id: null };
// The build of that plan, once Build it was pressed (which clears the wait).
const builtRun = { id: 4436, plan: { complicated: true, bullets: ['x'] }, awaiting_go_at: null, go_ahead_at: '2026-11-03T12:20:00Z', build_ok: null, build_session_id: 600, proposal_session_id: null };
const app = { id: 9, slug: 'usernode-2d5619' };

// #6860 (19 Nov 2026): the card says what became of the plan, not "Building
// it" for as long as the request stays open. Gym Tracker #78 showed
// "Building it" from 27 Oct: its plan had been built, put up for a vote and
// set aside, and a newer read of the request had stopped since.
test('#6860: a plan is building only while its own build is under way', async () => {
  const building = await plan.readPlan(fakePool({ run: builtRun }), { app, issueNumber: 78 });
  assert.equal(building.plan.state, 'building');
  assert.equal(building.plan.change, null);
  // Waiting for Build it is waiting, never building.
  assert.equal((await plan.readPlan(fakePool({ run: waitingRun }), { app, issueNumber: 78 })).plan.state, 'waiting');
  // A build that started and keeps running while a newer look of the
  // request exists is not building any more: the newer look supersedes it.
  assert.deepEqual(await plan.readPlan(fakePool({ run: builtRun, newest: { id: 6250 } }), { app, issueNumber: 78 }), { plan: null });
  // Nor is one whose build finished and made a change.
  const finished = await plan.readPlan(fakePool({ run: { ...builtRun, build_ok: true, proposal_session_id: 500 }, change: { id: 500, status: 'active', pr_number: null } }),
    { app, issueNumber: 78 });
  assert.equal(finished.plan.state, 'built');
});

test('#6860: a plan whose change is up for a vote says so, and names the change', async () => {
  const up = await plan.readPlan(
    fakePool({ run: { ...builtRun, build_ok: true, proposal_session_id: 11373 }, change: { id: 11373, status: 'promoted', pr_number: 9653 } }),
    { app, issueNumber: 78 });
  assert.equal(up.plan.state, 'built');
  assert.deepEqual(up.plan.change, { id: 11373, number: 9653 });
  assert.equal(up.plan.reason, null);
  assert.deepEqual(up.plan.choices, [], 'nothing to pick: it is not for build any more');
  const live = await plan.readPlan(
    fakePool({ run: { ...builtRun, build_ok: true, proposal_session_id: 11373 }, change: { id: 11373, status: 'merged', pr_number: 9653 } }),
    { app, issueNumber: 78 });
  assert.equal(live.plan.state, 'live');
  assert.deepEqual(live.plan.change, { id: 11373, number: 9653 });
});

test('#6860: a plan whose build stopped says so, not building', async () => {
  const failed = await plan.readPlan(
    fakePool({ run: { ...builtRun, build_ok: false, build_error: 'the build ran out of steps' } }), { app, issueNumber: 78 });
  assert.equal(failed.plan.state, 'stopped');
  assert.equal(failed.plan.reason, 'build_failed');
  assert.equal(failed.plan.change, null);
});

test('#6860: a plan whose change was closed without merging is set aside, and named', async () => {
  const aside = await plan.readPlan(
    fakePool({ run: { ...builtRun, build_ok: true, proposal_session_id: 11373 }, change: { id: 11373, status: 'archived', pr_number: 9653 } }),
    { app, issueNumber: 78 });
  assert.equal(aside.plan.state, 'stopped');
  assert.equal(aside.plan.reason, 'change_closed');
  assert.deepEqual(aside.plan.change, { id: 11373, number: 9653 });
  // Dropped for a newer plan (a skip): no card.
  assert.deepEqual(await plan.readPlan(
    fakePool({ run: { ...builtRun, build_ok: false, build_error: 'skipped: its requester asked to change the plan' } }),
    { app, issueNumber: 78 }), { plan: null });
});

test('#6860: a newer run of the request, with no plan of its own, drops the older plan\'s card', async () => {
  for (const run of [builtRun, { ...builtRun, build_ok: true, proposal_session_id: 11373 }]) {
    assert.deepEqual(await plan.readPlan(fakePool({ run, newest: { id: 6250 }, change: { id: 11373, status: 'archived', pr_number: 9653 } }),
      { app, issueNumber: 78 }), { plan: null });
  }
  // The same run is not a newer one.
  const same = await plan.readPlan(fakePool({ run: builtRun, newest: { id: 4436 } }), { app, issueNumber: 78 });
  assert.equal(same.plan.state, 'building');
});

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

// #6860 (19 Nov 2026): a plan whose build is over is drawn with what became
// of it, in the same words the rest of the request's page and the Homeroom
// bot page say, and names the change it made. Only a build under way reads
// "Building it".
test('#6860: the request\'s card settles in the page\'s own words, never "Building it" for a finished plan', () => {
  const card = loadTsx('frontend/src/features/dev-board/topic/request-plan.tsx');
  const base = {
    runId: 4436, title: 'Track bodyweight', summary: '', lines: [{ n: 1, text: 'A row opens its page.' }], choices: [],
    spec: null, postId: 31, requester: 'evan', mine: false, changing: false, reason: null, change: null,
  };
  const built = card.planFromRead({ plan: { ...base, state: 'built', change: { id: 500, number: 11373 } } });
  assert.equal(built.state, 'built');
  assert.deepEqual(built.change, { id: 500, number: 11373 });
  // No Build it, and the plan's own lines stay: only a build under way is "built".
  assert.equal(card.planCardState(built), 'closed');
  assert.equal(card.planCardState(card.planFromRead({ plan: { ...base, state: 'building' } })), 'built');
  // A settled plan has no line under its title: what became of it is said
  // inside the card, in the words the rest of the page says for it.
  assert.equal(card.planSubOf(built, 78), null);
  assert.deepEqual(card.planSettledLineOf(built), { id: 'project:topic.request.botPlan.settled.vote' });
  assert.equal(message('project:topic.request.botPlan.settled.vote'), message('core:work.stage.upForVote'),
    'up for a vote, in the page\'s own words');

  const live = card.planFromRead({ plan: { ...base, state: 'live', change: { id: 500, number: 11373 } } });
  assert.equal(card.planCardState(live), 'closed');
  assert.equal(message('project:topic.request.botPlan.settled.live'), message('core:work.stage.live'));

  const failed = card.planFromRead({ plan: { ...base, state: 'stopped', reason: 'build_failed' } });
  assert.equal(card.planCardState(failed), 'closed');
  assert.deepEqual(card.planSettledLineOf(failed), { id: 'project:topic.request.botPlan.settled.buildFailed' });
  assert.equal(message('core:work.reason.buildFailed'), 'Stopped: the build didn\'t finish');
  assert.equal(message('project:topic.request.botPlan.settled.buildFailed'), message('core:work.reason.buildFailed'),
    'the footer\'s own words');

  const aside = card.planFromRead({ plan: { ...base, state: 'stopped', reason: 'change_closed', change: { id: 500, number: 11373 } } });
  assert.equal(card.planCardState(aside), 'closed');
  assert.deepEqual(card.planSettledLineOf(aside), { id: 'project:topic.request.botPlan.settled.changeClosed' });
  assert.equal(message('core:work.reason.changeClosed'), 'Stopped: its change was closed');
  assert.equal(message('project:topic.request.botPlan.settled.changeClosed'), message('core:work.reason.changeClosed'),
    'the footer\'s own words');
  // The card that still waits has its line under the title, and no settled one.
  assert.deepEqual(card.planSubOf({ ...base, state: 'waiting', mine: true }, 78),
    { id: 'project:topic.request.botPlan.subYours', values: { number: '78' } });
  assert.equal(card.planSettledLineOf({ ...base, state: 'waiting', mine: true }), null);

  // A state the page does not know is no card at all.
  assert.equal(card.planFromRead({ plan: { ...base, state: 'other' } }), null);

  const src = read('frontend/src/features/dev-board/topic/request-plan.tsx');
  assert.match(src, /href=\{changeHref\(slug, plan\.change\.id, plan\.change\.number\)\}/, 'a built plan names its change and opens it');
  assert.match(src, /settledLine=\{worked \? \([\s\S]*?\) : settled \? \(/, 'a settled card says what became of it inside it');
});

// T2.4 (19 Nov 2026): once Build it is pressed, the card says what the
// request's stored work state says, as every other surface does: a build
// waiting its turn, held behind the project's build limit or waiting for
// building credit is not "Building it", and a change still checking is not
// "Up for a vote".
test('T2.4: a pressed plan reads the request\'s stored work state', async () => {
  assert.deepEqual(plan.stateFromWork({ stage: 'building', line: { code: 'held_builds' } }), { state: 'building', reason: null });
  assert.deepEqual(plan.stateFromWork({ stage: 'checking', line: { code: 'shots' } }), { state: 'built', reason: null });
  assert.deepEqual(plan.stateFromWork({ stage: 'up_for_vote' }), { state: 'built', reason: null });
  assert.deepEqual(plan.stateFromWork({ stage: 'going_live' }), { state: 'live', reason: null });
  assert.deepEqual(plan.stateFromWork({ stage: 'stopped', reason: 'change_closed' }), { state: 'stopped', reason: 'change_closed' });
  assert.deepEqual(plan.stateFromWork({ stage: 'stopped', reason: 'look_failed' }), { state: 'stopped', reason: 'build_failed' });
  assert.equal(plan.stateFromWork({ stage: 'waiting_for_you', why: 'question' }), null, 'a question since says nothing of the plan');
  assert.equal(plan.stateFromWork(null), null);

  // The read: a stored row held behind the build limit is the card's state and words.
  const held = {
    app_id: 9, item_kind: 'request', item_ref: 78, issue_number: 78, stage: 'building', line: { code: 'held_builds' },
    standing: {}, slug: 'usernode-2d5619',
  };
  const pool = fakePool({ run: builtRun });
  const inner = pool.query.bind(pool);
  pool.query = async (sql, params) => (/FROM work_states ws/.test(sql) ? { rows: [held] } : inner(sql, params));
  const read1 = await plan.readPlan(pool, { app, issueNumber: 78 });
  assert.equal(read1.plan.state, 'building');
  assert.deepEqual(read1.plan.work.words.stage, { id: 'core:work.stage.readyToBuild' });
  assert.deepEqual(read1.plan.work.words.line, { id: 'core:work.line.heldBuilds' });

  // The card says the row's words, with no spinner and no "· building".
  const card = loadTsx('frontend/src/features/dev-board/topic/request-plan.tsx');
  const view = card.planFromRead(read1);
  assert.equal(card.planCardState(view), 'closed');
  assert.deepEqual(card.planWorkLineOf(view), [{ id: 'core:work.stage.readyToBuild' }, { id: 'core:work.line.heldBuilds' }]);
  assert.deepEqual(card.planSubOf(view, 78), { id: 'project:topic.request.botPlan.subPressed', values: { number: '78' } });
  assert.equal(message('project:topic.request.botPlan.subPressed', { number: '78' }), 'Plan for #78');

  // A build under way keeps "Building it".
  const going = card.planFromRead({ plan: { ...read1.plan, work: { ...read1.plan.work, line: { code: 'starting' } } } });
  assert.equal(card.planWorkLineOf(going), null);
  assert.equal(card.planCardState(going), 'built');

  // A change still taking its screenshots is not "Up for a vote".
  const shots = { ...held, stage: 'checking', line: { code: 'shots' } };
  const pool2 = fakePool({ run: { ...builtRun, build_ok: true, proposal_session_id: 500 }, change: { id: 500, status: 'promoted', pr_number: 11373 } });
  const inner2 = pool2.query.bind(pool2);
  pool2.query = async (sql, params) => (/FROM work_states ws/.test(sql) ? { rows: [shots] } : inner2(sql, params));
  const read2 = await plan.readPlan(pool2, { app, issueNumber: 78 });
  assert.equal(read2.plan.state, 'built');
  assert.deepEqual(read2.plan.change, { id: 500, number: 11373 });
  assert.deepEqual(card.planWorkLineOf(card.planFromRead(read2)),
    [{ id: 'core:work.stage.shots' }, { id: 'core:work.line.shots' }]);
});
