'use strict';

// The made screen while Homeroom bot's plan waits for Build it
// (frontend/src/features/first-session/made.tsx), who has joined through the
// first invite, and the step a plan being redone is on
// (services/homeroom-bot-dm.js firstVersionState).
//
// First-session run-through, 4 October 2026: the maker sat on the made screen
// for ten minutes while the build waited on their tap, and the screen said
// only "Homeroom bot messages you when it's ready to try". The plan was in the
// bot's chat and on the App tab, neither of which they were on. #3878 drew
// the whole plan here, with Build it, above the sketch. 5 October 2026 (Evan,
// on his own phone): not the plan, and never inserted above at whatever
// moment it lands. A small "Needs you" card under the project now says there
// is one, and Go to chat opens the chat where it is answered.

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
  assert.deepEqual(waitingPlan({ step: 3, of: 7, line: 'plan', plan: PLAN }), PLAN);
  assert.deepEqual(waitingPlan({ plan: { bullets: ['a'], actionId: 5 } }),
    { bullets: ['a'], questions: [], actionId: 5, messageId: null, conversationId: null });
  assert.equal(waitingPlan(null), null);
  assert.equal(waitingPlan({ step: 2, of: 7 }), null, 'no plan yet');
  assert.equal(waitingPlan({ plan: { ...PLAN, actionId: undefined } }), null, 'nothing to decide without its action');
  assert.equal(waitingPlan({ plan: { ...PLAN, bullets: [] } }), null);
  assert.equal(waitingPlan({ ready: true, plan: PLAN }), null, 'a ready version waits on nobody');
  // #4043: the App tab no longer draws the plan; it is answered in the chat.
  const view = read('public/js/app-view.js');
  assert.doesNotMatch(view, /fv\.plan\b/);
});

test('the made screen reads the project under `app`, past the service worker\'s cache', () => {
  // Page Turners, 5 October 2026: GET /api/apps/:slug answers `{ app }`, and
  // the made screen read `first_version` off the answer itself, so its plan
  // and its step never showed (tests/first-session-made-plan-postgres.test.js
  // runs it against the real route).
  const { madeAppOf, madeAppUrl, waitingPlan } = loadTsx(`${DIR}/made.tsx`);
  const fv = { step: 3, of: 7, line: 'plan', ready: false, plan: PLAN };
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
  assert.match(src, /const app = madeAppOf\(body\);\s+if \(live && app\) \{\s+setFv\(app\.firstVersion\);/);
  assert.ok(!/setFv\(app\.first_version/.test(src), 'never the top of the answer');
});

test('a waiting plan is one small "Needs you" card under the project, with the way to the chat', () => {
  const { PlanWaitsCard, PLAN_LABEL, planWaitsLine } = loadTsx(`${DIR}/made.tsx`);
  assert.equal(PLAN_LABEL, 'Needs you');
  assert.equal(planWaitsLine('Plant Pal'), 'Homeroom bot has a plan for Plant Pal');
  let opened = 0;
  const html = renderToHtml(createElement(PlanWaitsCard, { name: 'Plant Pal', onOpenChat() { opened += 1; } }));
  assert.match(html, /data-first-session-plan="waiting"/);
  assert.match(html, />Needs you<\/p>/);
  assert.match(html, /<p class="text-\[12px\] font-bold uppercase tracking-\[0\.06em\]|class="px-1 pb-1\.5 text-\[12px\] font-bold uppercase tracking-\[0\.06em\]/, 'small caps over a card');
  assert.match(html, />Homeroom bot has a plan for Plant Pal<\/p>/);
  assert.match(html, /<button type="button" data-first-session-plan-chat=""[^>]*>Go to chat<\/button>/);
  assert.match(html, /rounded-\[20px\] bg-white/);
  // The plan itself, and its Build it, are the chat's.
  assert.doesNotMatch(html, /Build it|data-bot-plan|<li>/);
  assert.equal(opened, 0);
  for (const words of [PLAN_LABEL, planWaitsLine('Plant Pal')]) assert.ok(!/—/.test(words), words);
  const src = read(`${DIR}/made.tsx`);
  assert.doesNotMatch(src, /PlanCardView|decideBotAction|PlanSection|Build it'/, 'the made screen decides nothing');
  // Under the project card, never above it, so the sketch does not move when it lands.
  // (Not over a setup that stopped: its own card is the one thing to do then.)
  // The first session draws none (the plan waits until the tour ends, #4041);
  // from Create, which has no tour, it is the way to the chat.
  const card = src.indexOf('{plan && !stalled && fromCreate ? <PlanWaitsCard');
  assert.ok(card > src.indexOf('<SketchCard made='), 'after the project card');
  assert.ok(card < src.indexOf('data-first-session-hint='), 'before the invite line');
  assert.match(src, /onOpenChat=\{\(\) => onOpenChat\(plan\.conversationId \?\? made\.conversationId\)\}/);
});

test('while the plan waits, the build\'s note says so instead of promising a message', () => {
  const { buildNote } = loadTsx(`${DIR}/made.tsx`);
  assert.equal(buildNote(true, true), 'Homeroom bot is waiting for your go-ahead.');
  assert.equal(buildNote(false, true), 'You or anyone you invite can build it from there.');
  const src = read(`${DIR}/made.tsx`);
  assert.match(src, /: buildNote\(botBuilds, !!plan, stalled, imported\);/);
  // Under the card of the idea (./sketch-card.tsx) only when it has something
  // to say, and always in the plain card without one. The sketch's caption
  // calling it the real app is gone.
  assert.match(src, /<SketchCard made=\{made\} sketch=\{sketch\} line=\{line\} note=\{note\} \/>/);
  assert.match(src, /<p className="mt-1 text-\[13px\] text-zinc-500 dark:text-zinc-400">\{note\}<\/p>/);
  assert.doesNotMatch(src, /sketchCaption/);
  // The plain card's busy dot: not while it waits on them, nor on a setup that stopped (stalledOf).
  assert.match(src, /const busy = appStatus === 'creating' \|\| \(botBuilds && !\(fv && fv\.ready\) && !plan && !stalled\);/);
});

test('a first version promises no time at all, and says in one plain line that it asks when it has questions', () => {
  // First-session run-through, 5 October 2026: the made screen said "usually
  // in about 10 minutes", an ordinary request's typical build. Page Turners
  // sent its plan 11 minutes after Make it, waited on its maker's Build it,
  // and was ready to try 50 minutes after Make it. Evan: no average there.
  // Then, the same day: not "Homeroom bot plans it first, and asks you to
  // approve the plan" either, but one line, before the plan and after it.
  const { buildNote } = loadTsx(`${DIR}/made.tsx`);
  const line = 'Homeroom is making your app. It will message you when the first version is ready to try, or if it has any questions.';
  assert.equal(buildNote(true), line);
  assert.equal(buildNote(true, false), line);
  for (const words of [buildNote(true), buildNote(true, true), buildNote(false)]) {
    assert.doesNotMatch(words, /minute|hour|usually|plans it first|approve the plan|—/, words);
  }
  const src = read(`${DIR}/made.tsx`);
  assert.doesNotMatch(src, /planAhead/, 'one line whatever the step');
  // Nothing reads an ordinary request's typical minutes for it any more,
  // and GET /api/apps/:slug no longer sends them with a first version.
  assert.doesNotMatch(src.replace(/\/\*\*[\s\S]*?\*\//g, ''), /typicalMinutes|usually in about|minutes\./);
  const route = read('src/routes/apps.js');
  const block = route.slice(route.indexOf('firstVersion = {'), route.indexOf('log.warn(\'apps\', \'Could not read the first version state\''));
  assert.ok(block.length > 100, 'the first version block is findable');
  assert.doesNotMatch(block, /typicalMinutes:/);
});

test('Go to chat leaves the first session for the chat with Homeroom bot', () => {
  const index = read(`${DIR}/index.tsx`);
  // (From Create, its back press is handed back on the way: tests/create-front-door.test.js.)
  assert.match(index, /onOpenChat=\{\(conversationId\) => \{\s+markSeen\(made\.slug\);\s+rememberCommunity\(made\.slug\);\s+setMode\(\{ kind: 'none' \}\);\s+if \(fromCreate\) leaveDoor\(true\);\s+enterScreen\('bot', made\.slug, conversationId\);/);
  assert.match(index, /else if \(screen === 'bot' && conversationId\) window\.location\.hash = `#messages\/\$\{conversationId\}`;/);
  assert.doesNotMatch(index, /changePlanInChat/);
});

test('the made screen has two ways on and nothing under them: no "look around Home and other apps"', () => {
  // Evan, 5 October 2026: "Invite people later" is already the way on
  // without inviting anyone, so the quiet third way off the screen went.
  const made = loadTsx(`${DIR}/made.tsx`);
  assert.equal(made.LOOK_AROUND, undefined);
  const src = read(`${DIR}/made.tsx`);
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /look-around|onLookAround|While you wait|look around/i);
  const index = read(`${DIR}/index.tsx`);
  const madeBlock = index.slice(index.indexOf('<MadeScreen'), index.indexOf('if (mode.kind === \'welcome\')'));
  assert.ok(madeBlock.length > 100, 'the made screen\'s block is findable');
  assert.doesNotMatch(madeBlock, /onLookAround/, 'nothing hands it a third way off');
  // The make screen's own "Look around first" is a different answer, and stays.
  assert.match(read(`${DIR}/make.tsx`), />Look around first<\/button>/);
  const html = renderToHtml(createElement(made.MadeScreen, {
    made: { slug: 'plant-pal', name: 'Plant Pal', emoji: '🪴', description: null, example: null, conversationId: 12 },
    me: 'Maya', onContinue() {}, onOpenChat() {},
  }));
  assert.match(html, />Share invite<\/button>/);
  assert.match(html, /<button type="button" data-first-session-continue=""[^>]*>Invite people later<\/button>/);
  assert.doesNotMatch(html, /look around|While you wait/i);
  // The one line over them (#4041), and nothing about being built.
  assert.match(html, />Invite people to use it and help improve it together\.<\/p>/);
  assert.doesNotMatch(src, /while it's built|They can follow along/);
});

test('who joined is the people row, not a line: the community is read once, then while an invite is out', () => {
  const { peopleOf } = loadTsx(`${DIR}/made.tsx`);
  const maker = { username: 'maya', display_name: 'Maya', source: 'creator' };
  assert.deepEqual(peopleOf(null, 'maya'), [{ username: 'maya' }], 'just you, before the community is read');
  assert.deepEqual(peopleOf({ members: [maker, { username: 'sam' }] }, 'maya'), [maker, { username: 'sam' }]);
  const src = read(`${DIR}/made.tsx`);
  assert.match(src, /const community = useCommunity\(made\.slug, sent\);/);
  assert.match(src, /<PeopleRow people=\{peopleOf\(community, me\)\} \/>/);
  assert.match(src, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/community`, \{ credentials: 'same-origin' \}\)/);
  assert.match(src, /const t = polling \? window\.setInterval\(read, COMMUNITY_POLL_MS\) : 0;/);
  // #4196: what went out is said the way it went, never "Invite sent", which
  // a share sheet cannot promise; and no line says who joined as well.
  assert.doesNotMatch(src, /'✓ Invite sent|joinedLine|sentLines/);
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
    onOpenChat() {},
  }));
  assert.ok(!/data-first-session-plan/.test(html), 'no plan until one is read');
  assert.match(html, /data-build-line="planning"[^>]*>.*Homeroom bot is planning it/);
  assert.doesNotMatch(html, /Homeroom is making your app/, 'nothing under the thumbnail but the build line');
  assert.match(html, /Invite people later/);
});

test('the invite sheet: a small caps label over the invite as they will see it, and a note that names itself to a screen reader', () => {
  // Evan, 5 October 2026: the note had no name of its own. The canvas
  // (#4042) names the card instead, "What they'll see", and the note is the
  // card's own last line, so it carries an aria-label and no visible one.
  const { InviteSheet } = loadTsx(`${DIR}/made.tsx`);
  const html = renderToHtml(createElement(InviteSheet, {
    made: { slug: 'plant-pal', name: 'Plant Pal', emoji: '🪴', description: null, example: null, conversationId: 12 },
    me: 'Maya', onClose() {}, onSent() {},
  }));
  assert.match(html, /<p data-first-session-invite-label="" class="mt-4 pb-1\.5 text-xs font-bold uppercase tracking-\[0\.06em\] text-zinc-500 dark:text-zinc-400">What they&#x27;ll see<\/p>/);
  assert.doesNotMatch(html, /<label for="first-session-note"/);
  assert.match(html, /<textarea id="first-session-note" aria-label="Your note"/);
  assert.ok(html.indexOf('What they&#x27;ll see') < html.indexOf('data-first-session-invite-line'));
  assert.ok(html.indexOf('data-first-session-invite-line') < html.indexOf('<textarea id="first-session-note"'));
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

async function stateWith(stage, queueReason, viewerId = null) {
  const dm = require('../src/services/homeroom-bot-dm');
  const progress = require('../src/services/homeroom-bot-progress');
  const pool = fakePool([[FV_ROW], []]);
  return dm.firstVersionState(pool, 5, {
    viewerId,
    progress: {
      ...progress,
      requestStates: async () => [{ row: { app_id: 5, issue_number: 1, queue_reason: queueReason }, state: { stage } }],
    },
  });
}

test('a plan its creator asked to change stays on the plan\'s step while it is redone', async () => {
  for (const stage of ['queued', 'reading']) {
    const fv = await stateWith(stage, 'plan_change');
    assert.deepEqual([fv.step, fv.of, fv.line], [3, 7, 'planning'], stage);
    assert.equal(fv.question, false);
    assert.equal(fv.ready, false);
    assert.equal(fv.plan, undefined);
    assert.equal('stepName' in fv, false, '#4053: the line, never a step name');
  }
  // The first read of the description is still step 2.
  const first = await stateWith('reading', 'new');
  assert.deepEqual([first.step, first.line], [2, 'planning']);
  // A question the new read asks waits on them, as any question does.
  const asked = await stateWith('question', 'plan_change', 7);
  assert.deepEqual([asked.step, asked.line], [2, 'planning'], 'a question in the record, not one waiting on them');
  // The new plan, once it is sent, is the plan's own step again, and waits
  // on its creator: said for whoever reads it (buildLineOf).
  const sent = await stateWith('plan', 'plan_change');
  assert.deepEqual([sent.step, sent.line], [3, 'plan-member']);
  const mine = await stateWith('plan', 'plan_change', 7);
  assert.deepEqual([mine.step, mine.line], [3, 'plan']);
  // Changed in changePlan, read here: the reason they agree on.
  const src = read('src/services/homeroom-bot-dm.js');
  assert.match(src, /enqueueFront\(pool, \{ appId: app\.id, issueNumber, userId: user\.id, reason: 'plan_change' \}\)/);
  assert.match(src, /const replanning = found\.row\?\.queue_reason === 'plan_change'\s+&& \(found\.state\.stage === 'queued' \|\| found\.state\.stage === 'reading'\);/);
  assert.match(read('src/services/homeroom-bot-progress.js'), /q\.reason AS queue_reason,/);
});

test('"Write a plan" names one wait: the plan waiting on its creator is their turn', async () => {
  // First-session run-through, 5 October 2026: "Step 3 of 7: Write a plan"
  // was said while the plan waited for its maker's Build it, and again while
  // the bot wrote its build plan after it, so the maker read their own turn
  // as the bot's.
  const plan = (stage, viewerId) => stateWith(stage, 'new', viewerId);
  // #4053: and the build line says it the same way: "Your plan is ready to
  // review" to its creator alone, "Planning it" to everyone else.
  const waits = await plan('plan', 7);
  assert.deepEqual([waits.step, waits.of, waits.line], [3, 7, 'plan']);
  assert.equal((await plan('plan', 99)).line, 'plan-member', 'another member reads that it is being planned');
  assert.equal((await plan('plan', null)).line, 'plan-member');
  // After Build it, what the bot does next is the build to them: writing
  // the build's own plan, and waiting for its turn and workspace, read as
  // step 4, "Building it", never the plan again (Evan, 5 October 2026:
  // "writing the plan for the build" right after he approved the plan).
  for (const stage of ['planning', 'build_queued', 'starting']) {
    const after = await plan(stage, 7);
    assert.deepEqual([after.step, after.line], [4, 'building'], stage);
  }
  const progress = require('../src/services/homeroom-bot-progress');
  for (const stage of ['planning', 'build_queued', 'starting']) {
    assert.equal(progress.stepNumber(stage, true), 4, `a first version's ${stage}`);
    assert.equal(progress.stepNumber(stage, false), 2, `a request's ${stage} is still its plan`);
  }
  assert.equal(progress.stepNumber('plan', true), 3, 'the plan waiting on its creator stays step 3');
  const { madeLine } = loadTsx(`${DIR}/made.tsx`);
  assert.equal(madeLine(waits, true), 'plan');
  assert.equal(madeLine({ ...waits, line: 'plan-member' }, true), 'plan-member');
});
