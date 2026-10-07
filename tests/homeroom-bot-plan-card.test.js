'use strict';

// #4046: Homeroom bot shows one set of suggestions, and its plan card carries
// the build's step (onboarding PR 6, canvas boards C8 and C8b).
//
// While a plan or a question offers its own answers, the hello's questions
// to tap give way. A first version's plan is the one place its request's
// step shows: the activity card above the plan is not drawn, the plan reads
// its state for the line at its top, and the card Build it moves under the
// plan is drawn as one line from the bot, with Notify me under it. The card
// itself is pinned in tests/homeroom-bot-plan.test.js.
//
// Run with: node --test tests/homeroom-bot-plan-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const botMsg = (id, meta, extra = {}) => ({
  id, conversationId: 3, content: 'words', createdAt: '2026-10-06T10:00:00Z', reactions: [], attachments: [], objects: [],
  sender: { id: 2, username: 'homeroom_bot', bot: true }, metadata: { homeroomBot: meta }, ...extra,
});
const fvMeta = { appSlug: 'run-club', appName: 'Run Club', issueNumber: 1, firstVersion: true };
const RUN_PLAN = { bullets: ['Everyone\'s miles this week'], questions: [{ question: 'What counts?', answers: ['Own goal', 'Club goal'] }] };

test('#4046: while a plan or a question offers its own answers, the bot\'s questions to tap give way', () => {
  const { planLayout, offersAnswers } = loadTsx('frontend/src/features/messages/bot-plan.tsx');
  const hello = botMsg(10, {
    kind: 'first_version_started', appName: 'Run Club', status: 'open',
    actions: [{ id: 'ask-1', label: 'How long will this take?', style: 'secondary', type: 'prompt' }],
  });
  const plan = (status, extra = {}) => botMsg(30, { kind: 'plan', ...fvMeta, plan: RUN_PLAN, actionId: 4, status, ...extra });
  assert.equal(planLayout([hello]).answersOpen, false, 'nothing else asks: the hello keeps its questions');
  assert.equal(planLayout([hello, plan('open')]).answersOpen, true, 'the plan waits for Build it');
  assert.equal(planLayout([hello, plan('answered')]).answersOpen, false, 'built: they come back');
  assert.equal(planLayout([hello, plan('closed', { replaced: true })]).answersOpen, false);
  const question = botMsg(40, { kind: 'question', appName: 'Run Club', issueNumber: 2, question: 'Newest first?', answers: ['Yes', 'No'], status: 'open' });
  assert.equal(planLayout([hello, question]).answersOpen, true, 'an open question offers its own answers too');
  assert.equal(offersAnswers({ ...question, metadata: { homeroomBot: { ...question.metadata.homeroomBot, status: 'answered' } } }), false);
  assert.equal(offersAnswers(botMsg(41, { kind: 'confirm', status: 'open', question: 'File this?' })), false, 'an offer is a choice, not suggestions');
  assert.equal(offersAnswers({ ...question, sender: { id: 4, username: 'ada' } }), false, 'only the bot\'s own');

  const taps = [];
  const { BotQuestion } = loadTsx('frontend/src/features/messages/bot-question.tsx', {
    stubs: { './store': { answerBotQuestion() {}, scopeKey: () => 'k', setReply() {}, async tapBotAction(m, a) { taps.push(a.id); } } },
  });
  assert.match(renderToHtml(createElement(BotQuestion, { message: hello, conversationId: 3 })), /data-bot-prompt=""/);
  assert.equal(renderToHtml(createElement(BotQuestion, { message: hello, conversationId: 3, hidePrompts: true })), '', 'given way');
  const asked = botMsg(10, { ...hello.metadata.homeroomBot, status: 'answered', answer: 'How long will this take?', chosen: 'ask-1' });
  assert.match(renderToHtml(createElement(BotQuestion, { message: asked, conversationId: 3, hidePrompts: true })), /You asked: How long will this take\?/,
    'a question already asked still says so');
  assert.match(renderToHtml(createElement(BotQuestion, { message: question, conversationId: 3, hidePrompts: true })), /Newest first\?|data-bot-answer="default"/,
    'a question\'s own answers are never hidden');

  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /const plans = botDm \? planLayout\(snap\.messages\) : NO_PLAN_LAYOUT;/);
  assert.match(screen, /hidePrompts=\{plans\.answersOpen && !!message\.sender\.bot\}/);
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /<BotQuestion message=\{message\} conversationId=\{conversationId\} hidePrompts=\{hidePrompts\} \/>/);
});

test('#4046: the plan is the one place its request\'s step shows: the card above it goes, the card under it is one line', () => {
  const { planLayout, planProgress, planTime, PLAN_FOLLOW_UP_WORDS } = loadTsx('frontend/src/features/messages/bot-plan.tsx');
  const card = (id, extra = {}) => botMsg(id, { kind: 'activity', ...fvMeta, ...extra });
  const plan = (id, status, extra = {}) => botMsg(id, { kind: 'plan', ...fvMeta, plan: RUN_PLAN, actionId: 4, status, ...extra });
  const other = botMsg(25, { kind: 'activity', appSlug: 'run-club', appName: 'Run Club', issueNumber: 2 });

  // The plan waits: its request's card (sent when it was queued) is above it.
  const waiting = planLayout([card(20), other, plan(30, 'open')]);
  assert.deepEqual([...waiting.hidden], [20], 'the card above its plan is not drawn; another request\'s is');
  assert.equal(waiting.cardOf.get(30), 20, 'the plan reads its state');
  assert.equal(waiting.underPlan.size, 0);

  // Build it: the card is moved under the plan (cardUnderPlan) and the one above says where it went.
  const built = planLayout([card(20, { movedTo: 50 }), plan(30, 'answered', { choices: ['Own goal'] }), card(50, { lookAt: 'x' })]);
  assert.deepEqual([...built.hidden], []);
  assert.deepEqual([...built.underPlan], [50], 'the card that follows the build is drawn as one line under it');
  assert.equal(built.cardOf.get(30), 50, 'and the plan reads its state');

  // A newer plan replaced the first: only the newest reads the card.
  const again = planLayout([card(20), plan(30, 'closed', { replaced: true }), plan(40, 'open')]);
  assert.deepEqual([...again.hidden], [20]);
  assert.equal(again.cardOf.has(30), false);
  assert.equal(again.cardOf.get(40), 20);
  // A plan that stopped waiting reads nothing; its card stays out of the way.
  const stopped = planLayout([card(20), plan(30, 'closed', { stopped: true })]);
  assert.equal(stopped.cardOf.size, 0);
  assert.deepEqual([...stopped.hidden], [20]);
  // No plan, no change: every card is drawn as it was.
  const none = planLayout([card(20), other]);
  assert.deepEqual([none.hidden.size, none.cardOf.size, none.underPlan.size, none.answersOpen], [0, 0, 0, false]);

  // What the line at the plan's top says.
  const working = (extra) => ({ messageId: 20, state: 'working', startedAt: null, workedFrom: null, links: {}, step: null, of: null, stepName: null, doing: null, outcome: null, endedAt: null, ...extra });
  assert.deepEqual(planProgress(working({ step: 3, of: 7, stepName: 'Write a plan' }), 'open'), { line: 'Step 3 of 7', step: 3, of: 7 },
    'while it waits: the step, and nothing else');
  assert.deepEqual(planProgress(working({ step: 4, of: 7, stepName: 'Build it', typicalMinutes: { from: 10, to: 25 } }), 'built'),
    { line: 'Step 4 of 7 · Build it · 10 to 25 min', step: 4, of: 7 }, 'the step, its name, the time: short enough for one line');
  assert.equal(planTime({ from: 10, to: 25 }), '10 to 25 min');
  assert.equal(planTime({ from: 3, to: 3 }), 'about 3 min');
  assert.equal(planTime(null), null);
  assert.deepEqual(planProgress(working({ doing: 'ready to build; waiting its turn to be built' }), 'built'),
    { line: 'Ready to build; waiting its turn to be built', step: null, of: null }, 'a step it cannot count is said in words, with no bar');
  assert.deepEqual(planProgress({ ...working(), state: 'done', outcome: 'build_failed' }, 'built'),
    { line: 'Couldn’t finish building it', step: null, of: null });
  assert.equal(planProgress({ ...working(), state: 'done', outcome: 'proposed' }, 'open'), null);
  assert.equal(planProgress(working({ step: 3, of: 7 }), 'changing'), null, 'a plan that is not waiting or built says its own line');
  assert.equal(planProgress(null, 'open'), null);

  // Drawn: the follow-up line, and Notify me while it is built.
  assert.equal(PLAN_FOLLOW_UP_WORDS, 'I’ll message you here when it’s ready to try.');
  const { BotPlanFollowUp } = loadTsx('frontend/src/features/messages/bot-plan.tsx');
  const html = renderToHtml(createElement(BotPlanFollowUp, { message: card(50) }));
  assert.match(html, /^<div data-bot-plan-follow-up="pending"><div class="messages-markdown gc-msg-content"><p>I’ll message you here when it’s ready to try\.<\/p><\/div><div class="mt-2"><div class="messages-bot-answers" role="group" aria-label="Notifications" aria-live="polite"><button type="button" class="messages-bot-tint" data-bot-notify-me="">/);
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /isActivityMessage\(message\) && underPlan \? \([\s\S]{0,120}<BotPlanFollowUp message=\{message\} \/>/);
  assert.match(row, /<BotPlanCard message=\{message\} conversationId=\{conversationId\} cardId=\{planCardId\} \/>/);
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /if \(plans\.hidden\.has\(message\.id\)\) continue;\s*const day = dayKey\(message\);/,
    'skipped before its day and its name are counted, as a moved card is');
  assert.match(screen, /planCardId=\{plans\.cardOf\.get\(message\.id\) \?\? null\}\s*underPlan=\{plans\.underPlan\.has\(message\.id\)\}/);
  const host = read('frontend/src/features/messages/bot-plan.tsx');
  assert.match(host, /progress=\{planProgress\(cardId \? activity\.cards\.get\(cardId\) : null, planState\(meta, pressed\)\)\}/);
  for (const s of [PLAN_FOLLOW_UP_WORDS, 'Step 3 of 7', 'My plan for', 'Change something']) assert.doesNotMatch(s, /—|!/);
});
