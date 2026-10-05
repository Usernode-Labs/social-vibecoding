'use strict';

// The made screen while Homeroom bot's plan waits for Build it
// (frontend/src/features/first-session/made.tsx), who has joined through the
// first invite, and the step a plan being redone is on
// (services/homeroom-bot-dm.js firstVersionState).
//
// First-session run-through, 4 October 2026: the maker sat on the made screen
// for ten minutes while the build waited on their tap, and the screen said
// only "Homeroom bot messages you when it's ready to try". The plan was in the
// bot's chat and on the App tab, neither of which they were on. It is drawn
// here now, first, as the same card, deciding Build it through the same call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DIR = 'frontend/src/features/first-session';

const PLAN = {
  bullets: ['A list of your plants', 'A Today view'],
  questions: [{ question: 'How should it remind you?', answers: ['In the app', 'Phone alert'] }],
  actionId: 41,
  messageId: 900,
  conversationId: 12,
};

test('a plan waits for Build it when first_version carries one, read as the App tab reads it', () => {
  const { waitingPlan } = loadTsx(`${DIR}/made.tsx`);
  assert.deepEqual(waitingPlan({ step: 3, of: 7, stepName: 'Write a plan', plan: PLAN }), PLAN);
  assert.deepEqual(waitingPlan({ plan: { bullets: ['a'], actionId: 5 } }),
    { bullets: ['a'], questions: [], actionId: 5, messageId: null, conversationId: null });
  assert.equal(waitingPlan(null), null);
  assert.equal(waitingPlan({ step: 2, of: 7 }), null, 'no plan yet');
  assert.equal(waitingPlan({ plan: { ...PLAN, actionId: undefined } }), null, 'nothing to decide without its action');
  assert.equal(waitingPlan({ plan: { ...PLAN, bullets: [] } }), null);
  assert.equal(waitingPlan({ ready: true, plan: PLAN }), null, 'a ready version waits on nobody');
  // The same test the being-built screen makes.
  const view = read('public/js/app-view.js');
  assert.match(view, /const plan = mine && fv\.plan && Array\.isArray\(fv\.plan\.bullets\) && fv\.plan\.bullets\.length\s+&& Number\.isInteger\(fv\.plan\.actionId\) \? fv\.plan : null;/);
});

test('the made screen reads the project under `app`, past the service worker\'s cache', () => {
  // Page Turners, 5 October 2026: GET /api/apps/:slug answers `{ app }`, and
  // the made screen read `first_version` off the answer itself, so its plan
  // and its step never showed (tests/first-session-made-plan-postgres.test.js
  // runs it against the real route).
  const { madeAppOf, madeAppUrl, waitingPlan } = loadTsx(`${DIR}/made.tsx`);
  const fv = { step: 3, of: 7, stepName: 'Write a plan', ready: false, plan: PLAN };
  assert.deepEqual(madeAppOf({ app: { status: 'running', first_version: fv } }), { firstVersion: fv, status: 'running' });
  assert.deepEqual(waitingPlan(madeAppOf({ app: { first_version: fv } }).firstVersion), PLAN);
  assert.deepEqual(madeAppOf({ app: { status: 'creating' } }), { firstVersion: null, status: 'creating' });
  assert.equal(madeAppOf({ first_version: fv, status: 'running' }), null, 'a bare record is not the route\'s answer');
  assert.equal(madeAppOf(null), null);
  assert.equal(madeAppOf({ error: 'App not found' }), null);
  // A poll asks what is true now: the tagged URL the App tab's recheck uses,
  // which the service worker never answers from its boot cache.
  assert.equal(madeAppUrl('page turners'), '/api/apps/page%20turners?status_recheck=1&manifest=summary');
  const { classifyRequest } = require('../public/sw.js');
  const origin = 'https://onhomeroom.test';
  assert.equal(classifyRequest('GET', `${origin}${madeAppUrl('page-turners')}`, 'application/json', 'cors', origin), 'bypass');
  assert.equal(classifyRequest('GET', `${origin}/api/apps/page-turners`, 'application/json', 'cors', origin), 'api',
    'the plain read is the boot lane\'s, served from cache first');
  const src = read(`${DIR}/made.tsx`);
  assert.match(src, /fetch\(madeAppUrl\(made\.slug\), \{ credentials: 'same-origin', cache: 'no-store' \}\)/);
  assert.match(src, /const app = madeAppOf\(body\);\s+if \(live && app\) \{ setFv\(app\.firstVersion\); setAppStatus\(app\.status\); \}/);
  assert.ok(!/setFv\(app\.first_version/.test(src), 'never the top of the answer');
});

test('the plan is drawn under "Needs you", as the chat\'s own card, with what Build it does', () => {
  const { PlanSection, PLAN_LABEL, planNote } = loadTsx(`${DIR}/made.tsx`);
  assert.equal(PLAN_LABEL, 'Needs you');
  assert.equal(planNote('Plant Pal'), 'Homeroom bot starts building Plant Pal when you tap Build it.');
  const html = renderToHtml(createElement(PlanSection, {
    name: 'Plant Pal', plan: PLAN, onBuilt() {}, onGone() {}, onChange() {},
  }));
  assert.match(html, /data-first-session-plan="open"/);
  assert.match(html, />Needs you<\/p>/);
  assert.match(html, /data-bot-plan="open"/);
  assert.match(html, /Here’s my plan for Plant Pal:/);
  assert.match(html, /<li>A list of your plants<\/li><li>A Today view<\/li>/);
  assert.match(html, /How should it remind you\?/);
  assert.match(html, /<span>In the app<\/span><span class="messages-bot-default">suggested<\/span>/);
  assert.match(html, /data-bot-plan-build="">Build it<\/button>/);
  assert.match(html, /data-bot-plan-change="">Change something<\/button>/);
  assert.match(html, /Homeroom bot starts building Plant Pal when you tap Build it\./);
  assert.match(html, /rounded-\[20px\] bg-\[color:var\(--dc-sheet-solid\)\]/, 'the App tab\'s surface of the card');
  for (const words of [PLAN_LABEL, planNote('Plant Pal')]) assert.ok(!/—/.test(words), words);
});

test('while the plan waits, the build\'s note says so instead of promising a message', () => {
  const { buildNote } = loadTsx(`${DIR}/made.tsx`);
  assert.equal(buildNote(true, 8, true), 'Homeroom bot is waiting for your go-ahead.');
  assert.equal(buildNote(true, 8), 'Homeroom bot messages you when it\'s ready to try, usually in about 8 minutes.');
  assert.equal(buildNote(false, null, true), 'You or anyone you invite can build it from there.');
  const src = read(`${DIR}/made.tsx`);
  assert.match(src, /buildNote\(botBuilds, minutes, planWaits\)/);
  assert.match(src, /buildNote\(botBuilds, minutes, !!plan\)/);
  // Nothing is under way while it waits on them: no busy dot.
  assert.match(src, /const busy = appStatus === 'creating' \|\| \(botBuilds && !\(fv && fv\.ready\) && !plan\);/);
});

test('Build it is the chat\'s own call, decided once; Change something is the App tab\'s', () => {
  const src = read(`${DIR}/made.tsx`);
  assert.match(src, /import \{ decideBotAction, MessagesApiError \} from '\.\.\/messages\/api';/);
  assert.match(src, /import \{ PlanCardView \} from '\.\.\/messages\/bot-plan-view';/);
  assert.match(src, /await decideBotAction\(plan\.actionId, 'build', answers\.map\(\(a\) => a \|\| ''\)\);/);
  // Decided elsewhere already, or replaced: read the project again.
  assert.match(src, /if \(err instanceof MessagesApiError && err\.status === 409\) \{ onGone\(\); return; \}/);
  assert.match(src, /setError\('Couldn\\'t start building just now\. Try again\.'\);/);
  // A plan built from here stays, chosen, with the answer each choice went with.
  assert.match(src, /onBuilt\(plan, plan\.questions\.map\(\(q, i\) => answers\[i\] \|\| q\.answers\[0\] \|\| ''\)\);/);
  assert.match(src, /<PlanCardView surface="app" appName=\{made\.name\} plan=\{chosen\.plan\} state="built" choices=\{chosen\.choices\} \/>/);
  // Drawn first: it is what waits on them, above the project card and the sketch.
  const plan = src.indexOf('<PlanSection\n');
  assert.ok(plan > 0 && plan < src.indexOf('<SketchCard made='), 'the plan comes before the project card');
  assert.match(src, /onChange=\{\(\) => onChangePlan\(plan\.conversationId \?\? made\.conversationId, plan\.messageId\)\}/);
  // The endpoint the chat's api call reaches is the one the App tab posts to.
  assert.match(read('frontend/src/features/messages/api.ts'), /request<unknown>\(`\/api\/conversations\/homeroom-bot\/actions\/\$\{actionId\}`/);
  assert.match(read('public/js/app-view.js'), /changeFirstVersionPlan\(_slug, conversationId, messageId\) \{/);
});

test('Change something leaves the first session for the chat, with the plan quoted', () => {
  const index = read(`${DIR}/index.tsx`);
  assert.match(index, /onChangePlan=\{\(conversationId, messageId\) => \{\s+markSeen\(made\.slug\);\s+rememberCommunity\(made\.slug\);\s+setMode\(\{ kind: 'none' \}\);\s+changePlanInChat\(made\.slug, conversationId, messageId\);/);
  const saved = global.window;
  const calls = [];
  global.window = { AppView: { changeFirstVersionPlan: (...args) => calls.push(args) }, location: { hash: '' } };
  try {
    const { changePlanInChat } = loadTsx(`${DIR}/index.tsx`);
    changePlanInChat('plant-pal', 12, 900);
    assert.deepEqual(calls, [['plant-pal', 12, 900]]);
    global.window = { location: { hash: '' } };
    changePlanInChat('plant-pal', 12, 900);
    assert.equal(global.window.location.hash, '#messages/12', 'without the App tab\'s opener, the chat itself');
  } finally {
    global.window = saved;
  }
});

test('the invite line says who joined, once somebody has', () => {
  const { joinedLine } = loadTsx(`${DIR}/made.tsx`);
  const maker = { username: 'maya', display_name: 'Maya', source: 'creator' };
  assert.equal(joinedLine(null), null);
  assert.equal(joinedLine({ member_count: 1, members: [maker] }), null, 'only the maker: nobody joined yet');
  assert.equal(joinedLine({ member_count: 2, members: [maker, { username: 'sam', display_name: null, source: 'collaborator' }] }), '✓ sam joined.');
  assert.equal(joinedLine({ member_count: 2, members: [maker, { username: 'sam', display_name: 'Sam', source: 'joined' }] }), '✓ Sam joined.');
  assert.equal(joinedLine({ member_count: 3, members: [maker, { username: 'sam', source: 'joined' }, { username: 'alex', source: 'joined' }] }), '✓ sam and alex joined.');
  assert.equal(joinedLine({ member_count: 4, members: [maker, { username: 'a' }, { username: 'b' }, { username: 'c' }] }), '✓ 3 people joined.');
  // `members` is the newest eight; the count is everyone.
  assert.equal(joinedLine({ member_count: 12, members: [maker, { username: 'a' }] }), '✓ 11 people joined.');
  const src = read(`${DIR}/made.tsx`);
  // Read only while an invite is out, and in place of "Invite sent" once somebody joined.
  assert.match(src, /const community = useCommunity\(made\.slug, sent\);/);
  assert.match(src, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/community`, \{ credentials: 'same-origin' \}\)/);
  assert.match(src, /if \(!on\) return undefined;/);
  assert.match(src, /\{joined \|\| `✓ Invite sent\$\{sentTo \? ` to \$\{sentTo\}` : ''\}\.`\}/);
  // The route says who is in it: newest first after the maker, and how many.
  const route = read('src/routes/apps.js');
  assert.match(route, /router\.get\('\/api\/apps\/:slug\/community',/);
  assert.match(read('src/services/communities.js'), /ORDER BY \(m\.source = 'creator'\) DESC, m\.joined_at DESC, u\.id/);
  assert.match(read('src/services/communities.js'), /AS member_count,/);
});

test('the made screen renders with nothing read yet: no plan, the build\'s first line', () => {
  const { MadeScreen } = loadTsx(`${DIR}/made.tsx`);
  const html = renderToHtml(createElement(MadeScreen, {
    made: { slug: 'plant-pal', name: 'Plant Pal', emoji: '🪴', description: null, example: null, conversationId: 12 },
    me: 'Maya',
    onContinue() {},
    onChangePlan() {},
  }));
  assert.ok(!/data-first-session-plan/.test(html), 'no plan until one is read');
  assert.match(html, /data-first-session-build="">Setting it up…<\/span>/);
  assert.match(html, /Invite people later/);
});

// ── The step while a plan is redone ──

function fakePool(rowsByCall) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: rowsByCall.shift() || [] };
    },
  };
}

const FV_ROW = {
  app_id: 5, user_id: 7, status: 'filed', issue_number: 1, merged: false,
  slug: 'plant-pal', name: 'Plant Pal', app_status: 'running', username: 'maya', conversation_id: 12,
};

async function stateWith(stage, queueReason) {
  const dm = require('../src/services/homeroom-bot-dm');
  const progress = require('../src/services/homeroom-bot-progress');
  const pool = fakePool([[FV_ROW], []]);
  return dm.firstVersionState(pool, 5, {
    progress: {
      ...progress,
      requestStates: async () => [{ row: { app_id: 5, issue_number: 1, queue_reason: queueReason }, state: { stage } }],
    },
  });
}

test('a plan its creator asked to change stays on the plan\'s step while it is redone', async () => {
  for (const stage of ['queued', 'reading']) {
    const fv = await stateWith(stage, 'plan_change');
    assert.deepEqual([fv.step, fv.of, fv.stepName], [3, 7, 'Updating the plan'], stage);
    assert.equal(fv.question, false);
    assert.equal(fv.ready, false);
    assert.equal(fv.plan, undefined);
  }
  // The first read of the description is still step 2.
  const first = await stateWith('reading', 'new');
  assert.deepEqual([first.step, first.stepName], [2, 'Read the description']);
  // A question the new read asks waits on them, as any question does.
  const asked = await stateWith('question', 'plan_change');
  assert.deepEqual([asked.step, asked.stepName], [2, 'Read the description']);
  // The new plan, once it is sent, is the plan's own step again.
  const sent = await stateWith('plan', 'plan_change');
  assert.deepEqual([sent.step, sent.stepName], [3, 'Write a plan']);
  // Changed in changePlan, read here: the reason they agree on.
  const src = read('src/services/homeroom-bot-dm.js');
  assert.match(src, /enqueueFront\(pool, \{ appId: app\.id, issueNumber, userId: user\.id, reason: 'plan_change' \}\)/);
  assert.match(src, /const replanning = found\.row\?\.queue_reason === 'plan_change'\s+&& \(found\.state\.stage === 'queued' \|\| found\.state\.stage === 'reading'\);/);
  assert.match(read('src/services/homeroom-bot-progress.js'), /q\.reason AS queue_reason,/);
});
