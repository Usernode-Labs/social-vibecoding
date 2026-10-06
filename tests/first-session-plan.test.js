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
// moment it lands. Then, request 4041 (October 2026): not here at all. The
// screen no longer asks anything mid-onboarding: the plan is answered in the
// bot's chat and shown on the app's page, and this screen only reassures
// ("Spinning up your app") and invites.

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

test('the made screen draws no plan at all, though the route still answers it for the app\'s page', () => {
  // Request 4041, October 2026: "Your turn: answer the plan" and a "Needs
  // you" card asked for action in the middle of onboarding, before the
  // person had finished inviting people. Nothing on this screen mentions
  // the plan any more; the bot still asks in its chat, and the app's page
  // still shows the step there.
  const src = read(`${DIR}/made.tsx`);
  for (const gone of ['PlanWaitsCard', 'WaitingPlan', 'waitingPlan', 'PLAN_LABEL', 'planWaitsLine', 'onOpenChat', 'data-first-session-plan']) {
    assert.ok(!src.includes(gone), `${gone} is gone from the made screen`);
  }
  assert.doesNotMatch(src, /PlanCardView|decideBotAction|PlanSection|Build it'/, 'the made screen decides nothing');
  // The App tab's being-built screen keeps reading the plan the same way.
  const view = read('public/js/app-view.js');
  assert.match(view, /const plan = mine && fv\.plan && Array\.isArray\(fv\.plan\.bullets\) && fv\.plan\.bullets\.length\s+&& Number\.isInteger\(fv\.plan\.actionId\) \? fv\.plan : null;/);
});

test('the made screen reads the project under `app`, past the service worker\'s cache', () => {
  // Page Turners, 5 October 2026: GET /api/apps/:slug answers `{ app }`, and
  // the made screen read `first_version` off the answer itself, so its plan
  // and its step never showed (tests/first-session-made-plan-postgres.test.js
  // runs it against the real route).
  const { madeAppOf, madeAppUrl } = loadTsx(`${DIR}/made.tsx`);
  const fv = { step: 3, of: 7, stepName: 'Write a plan', ready: false, plan: PLAN };
  assert.deepEqual(madeAppOf({ app: { status: 'running', first_version: fv } }), { firstVersion: fv, status: 'running' });
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
  assert.match(src, /const app = madeAppOf\(body\);\s+if \(live && app\) \{\s+setFv\(app\.firstVersion\);\s+setAppStatus\(app\.status\);/);
  assert.ok(!/setFv\(app\.first_version/.test(src), 'never the top of the answer');
});

test('the build\'s line and note sit under the card, one plain line the whole time', () => {
  // Request 4041, October 2026: the step line was inside the app card, so
  // the thumbnail and the build progress read as one thing. The line ("and
  // the note under it") is drawn by the screen, under whichever card is
  // shown, and says the same thing whatever the bot's step is: the "waiting
  // for your go-ahead" note went with the plan card.
  const { buildNote } = loadTsx(`${DIR}/made.tsx`);
  assert.equal(buildNote(true), 'Homeroom is making your app. It will message you when the first version is ready to try, or if it has any questions.');
  assert.equal(buildNote(false), 'You or anyone you invite can build it from there.');
  const src = read(`${DIR}/made.tsx`);
  assert.match(src, /const note = buildNote\(botBuilds\);/);
  // One progress row and one note, after the card and before the invite.
  const row = src.indexOf('mt-2.5 flex items-center gap-2 px-1');
  assert.ok(row > src.indexOf('built=\{!making'), 'under the sketch card');
  assert.ok(row > src.indexOf('id="first-session-made-title"'), 'under the plain tile card too');
  assert.ok(row < src.indexOf('Invite people to ${made.name}`}</p>'), 'before the invite');
  assert.match(src, /\{busy \? <span className="status-dot creating shrink-0" aria-hidden="true" \/>\s+: null\}\s+<span data-first-session-build="">\{line\}<\/span>/);
  assert.match(src, /<p className="px-1 pt-2\.5 text-\[13px\] leading-snug text-zinc-500 dark:text-zinc-400">\{note\}<\/p>/);
  assert.doesNotMatch(src, /waiting for your go-ahead|Homeroom bot is waiting/, 'no ask on this screen');
  // The card itself holds nothing about the build.
  assert.doesNotMatch(read(`${DIR}/sketch-card.tsx`), /data-first-session-build|status-dot|h-\[42px\]/);
  // The dot always shows the bot at work while it builds, whatever its
  // step and whatever its plan waits on: the ask lives in the chat.
  assert.match(src, /const busy = appStatus === 'creating' \|\| \(botBuilds && !\(fv && fv\.ready\)\);/);
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
  for (const words of [buildNote(true), buildNote(false)]) {
    assert.doesNotMatch(words, /minute|hour|usually|plans it first|approve the plan|—|waiting for your go-ahead/, words);
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

test('the made screen no longer opens the bot\'s chat: the maker\'s tour still ends there', () => {
  // Request 4041, October 2026: with the plan card gone, nothing on this
  // screen goes to the chat. The tour's last step still does (the tour's
  // own path into the bot screen is pinned in first-session-make.test.js).
  const index = read(`${DIR}/index.tsx`);
  const madeBlock = index.slice(index.indexOf('<MadeScreen'), index.indexOf('if (mode.kind === \'welcome\')'));
  assert.ok(madeBlock.length > 100, 'the made screen\'s block is findable');
  assert.doesNotMatch(madeBlock, /onOpenChat|first-session-plan-chat/, 'no Go to chat any more');
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
    me: 'Maya', onContinue() {},
  }));
  assert.match(html, />Share invite<\/button>/);
  assert.match(html, /<button type="button" data-first-session-continue=""[^>]*>Invite people later<\/button>/);
  assert.doesNotMatch(html, /look around|While you wait/i);
  // Their invite line says it is still being built, not "while it's built".
  assert.match(html, />They can follow along and chat with you while it&#x27;s being built\.<\/p>/);
  assert.doesNotMatch(src, /while it's built/);
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
  // Read only while an invite is out, and in place of "Invite sent" once
  // somebody joined.
  assert.match(src, /const community = useCommunity\(made\.slug, sent\);/);
  assert.match(src, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/community`, \{ credentials: 'same-origin' \}\)/);
  assert.match(src, /if \(!on\) return undefined;/);
  const { sentLines } = loadTsx(`${DIR}/made.tsx`);
  assert.deepEqual(sentLines(null), ['✓ Invite sent.']);
  assert.deepEqual(sentLines('✓ priya joined.'), ['✓ priya joined.']);
  assert.match(src, /\{sent \? sentLines\(joined\)\.map\(/);
  // The route says who is in it: newest first after the maker, and how many.
  const route = read('src/routes/apps.js');
  assert.match(route, /router\.get\('\/api\/apps\/:slug\/community',/);
  assert.match(read('src/services/communities.js'), /ORDER BY \(m\.source = 'creator'\) DESC, m\.joined_at DESC, u\.id/);
  assert.match(read('src/services/communities.js'), /AS member_count,/);
});

test('the made screen renders with nothing read yet: no plan, the spinner line, the note', () => {
  // Request 4041, October 2026: the first read says "Spinning up your app"
  // under the card, with the dot, never a step counter and never "Setting
  // it up…" while the bot builds it.
  const { MadeScreen } = loadTsx(`${DIR}/made.tsx`);
  const html = renderToHtml(createElement(MadeScreen, {
    made: { slug: 'plant-pal', name: 'Plant Pal', emoji: '🪴', description: null, example: null, conversationId: 12 },
    me: 'Maya',
    onContinue() {},
  }));
  assert.ok(!/data-first-session-plan/.test(html), 'no plan on this screen, whatever the record carries');
  // Under the card, not inside it: the row follows the sketch card's wrapper.
  const row = html.indexOf('mt-2.5 flex items-center gap-2 px-1');
  assert.ok(row > html.indexOf('data-featured-card="sketching"'), 'the line is outside the card');
  assert.ok(html.indexOf('data-first-session-build') > row, 'the line sits in the row');
  assert.match(html, /status-dot creating[^>]*><\/span>\s*<span data-first-session-build="">Spinning up your app<\/span>/);
  assert.match(html, />Homeroom is making your app\. It will message you when the first version is ready to try, or if it has any questions\.<\/p>/);
  assert.match(html, /Invite people later/);
});

test('the invite sheet names its note on screen, the way it names what they\'ll get', () => {
  // Evan, 5 October 2026: the note sat in the card under the project with
  // no name of its own, so it read as part of what they'll get rather than
  // something to write.
  const { InviteSheet } = loadTsx(`${DIR}/made.tsx`);
  const html = renderToHtml(createElement(InviteSheet, {
    made: { slug: 'plant-pal', name: 'Plant Pal', emoji: '🪴', description: null, example: null, conversationId: 12 },
    me: 'Maya', onClose() {}, onSent() {},
  }));
  const label = html.match(/<label for="first-session-note" class="([^"]*)">([^<]*)<\/label>/);
  assert.ok(label, 'the note has a label');
  assert.equal(label[2], 'Note');
  assert.doesNotMatch(label[1], /sr-only/, 'and it is on screen');
  // The same 13px grey as "What they'll get" over the card, and the make
  // screen's field labels (make.tsx LABEL).
  assert.equal(label[1], 'block pb-1 text-[13px] text-zinc-500 dark:text-zinc-400');
  assert.match(html, /<p class="mt-4 pb-1\.5 text-\[13px\] text-zinc-500 dark:text-zinc-400">What they&#x27;ll get<\/p>/);
  assert.match(read(`${DIR}/make.tsx`), /const LABEL = 'block text-\[13px\] text-zinc-500 dark:text-zinc-400';/);
  // Right above the box it names, inside the card.
  assert.ok(html.indexOf('>Note</label>') < html.indexOf('<textarea id="first-session-note"'));
  assert.ok(html.indexOf('data-first-session-invite-maker') < html.indexOf('>Note</label>'));
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
  // The new plan, once it is sent, is the plan's own step again, and waits
  // on its creator: named for whoever reads it (planWaitsStepName).
  const sent = await stateWith('plan', 'plan_change');
  assert.deepEqual([sent.step, sent.stepName], [3, 'Waiting for @maya to answer the plan']);
  const mine = await stateWith('plan', 'plan_change', 7);
  assert.deepEqual([mine.step, mine.stepName], [3, 'Your turn: answer the plan']);
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
  const waits = await plan('plan', 7);
  assert.deepEqual([waits.step, waits.of, waits.stepName], [3, 7, 'Your turn: answer the plan']);
  assert.equal((await plan('plan', 99)).stepName, 'Waiting for @maya to answer the plan', 'another member reads whose turn it is');
  assert.equal((await plan('plan', null)).stepName, 'Waiting for @maya to answer the plan');
  // After Build it, what the bot does next is the build to them: writing
  // the build's own plan, and waiting for its turn and workspace, read as
  // "Step 4 of 7: Build it", never "Write a plan" again (Evan, 5 October 2026:
  // "writing the plan for the build" right after he approved the plan).
  for (const stage of ['planning', 'build_queued', 'starting']) {
    const after = await plan(stage, 7);
    assert.deepEqual([after.step, after.stepName], [4, 'Build it'], stage);
  }
  const progress = require('../src/services/homeroom-bot-progress');
  for (const stage of ['planning', 'build_queued', 'starting']) {
    assert.equal(progress.stepNumber(stage, true), 4, `a first version's ${stage}`);
    assert.equal(progress.stepNumber(stage, false), 2, `a request's ${stage} is still its plan`);
  }
  assert.equal(progress.stepNumber('plan', true), 3, 'the plan waiting on its creator stays step 3');
  const { buildLine } = loadTsx(`${DIR}/made.tsx`);
  // The made screen stopped counting steps (request 4041): whatever the
  // step is, even its creator's own turn, the line is the same spinner
  // line. The step names still feed the app's page and the bot's chat.
  assert.equal(buildLine(waits, 'running', true), 'Spinning up your app');
  assert.ok(!/—/.test(waits.stepName));
});
