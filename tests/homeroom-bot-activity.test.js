'use strict';

// #3736: activity cards in the Homeroom bot's DM.
//
// tests/homeroom-bot-activity-postgres.test.js pins a card's whole life on
// the real schema and through the real route: started by the live loop,
// moving through the steps, ending, and whose cards are read. This file
// pins the rest without a database:
//
//   - the service's pure rules: what a piece of work came to, from the first
//     live run after its card began; a card still going takes its step from
//     progressFor; where a card's links go;
//   - starting a card: only for somebody the bot talks to in a DM, one per
//     claimed queue row, recorded as the bot's news about the request, and
//     never a reason the work fails;
//   - where it starts: beside the "looking into it" post, so never for a
//     follow-up, a restart or a backlog pass;
//   - the client: what it keeps of a read, the card drawn in every state,
//     the row drawing it in place of the message's words, and the store
//     reading again on `homeroom_bot_work_changed` and on the bot's news.
//
// Run with: node --test tests/homeroom-bot-activity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const CARD = 'frontend/src/features/messages/bot-activity.tsx';
const STORE = 'frontend/src/features/messages/bot-activity-store.ts';
const API = 'frontend/src/features/messages/api.ts';

const activity = require('../src/services/homeroom-bot-activity');
const dmSvc = require('../src/services/homeroom-bot-dm');

// ── What a piece of work came to ──

test('a card\'s outcome is the first live run after it began: its verdict, and for a build what the build came to', () => {
  const run = (extra) => ({ run_id: 1, ...extra });
  assert.equal(activity.outcomeOf({}), null, 'no run yet: still going');
  assert.equal(activity.outcomeOf(run({ verdict: 'ready' })), null, 'a build not finished: still going');
  assert.equal(activity.outcomeOf(run({ verdict: 'ready', proposal_session_id: 4, proposal_status: 'promoted' })), 'proposed');
  assert.equal(activity.outcomeOf(run({ verdict: 'ready', proposal_session_id: 4, proposal_status: 'merging' })), 'proposed');
  assert.equal(activity.outcomeOf(run({ verdict: 'ready', proposal_session_id: 4, proposal_status: 'merged' })), 'live');
  assert.equal(activity.outcomeOf(run({ verdict: 'ready', proposal_session_id: 4, proposal_status: 'closed' })), 'closed');
  assert.equal(activity.outcomeOf(run({ verdict: 'ready', build_ok: true })), 'proposed', 'built, its proposal a moment from recorded');
  assert.equal(activity.outcomeOf(run({ verdict: 'ready', build_ok: false, build_error: 'turn timed out' })), 'build_failed');
  assert.equal(activity.outcomeOf(run({ verdict: 'ready', build_ok: false, build_error: 'blocked: needs a paid API' })), 'blocked');
  assert.equal(activity.outcomeOf(run({ verdict: 'ready', cap_suppressed: 'proposals_per_app' })), 'held');
  assert.equal(activity.outcomeOf(run({ verdict: 'question', cap_suppressed: 'questions_per_day' })), 'held',
    'a question held back by a cap was never asked');
  for (const verdict of ['question', 'person', 'empty', 'failed', 'answer', 'revise']) {
    assert.equal(activity.outcomeOf(run({ verdict })), verdict);
  }
  assert.equal(activity.outcomeOf(run({ verdict: 'something new' })), 'failed');
  for (const outcome of ['question', 'proposed', 'live', 'closed', 'blocked', 'build_failed', 'person', 'empty', 'failed', 'held', 'stopped']) {
    assert.ok(activity.OUTCOMES.includes(outcome), outcome);
  }
});

test('a card still going takes its step from progressFor; with nothing in progress it stopped', () => {
  const row = { message_id: 31, created_at: '2026-10-02T11:51:00Z', slug: 'ear trainer', issue_number: 12 };
  const entry = {
    project: 'ear trainer', number: 12, stage: 'building', step: 3, of: 6, stepName: 'Build it', doing: 'building it',
    since: '2026-10-02T11:56:00.000Z', stepTimeLimitMinutes: 30,
  };
  const going = activity.cardOf(row, entry);
  assert.deepEqual(going, {
    messageId: 31, startedAt: '2026-10-02T11:51:00.000Z',
    links: { request: '#app/ear%20trainer/dev/issues/12', proposal: null },
    state: 'working', stage: 'building', step: 3, of: 6, stepName: 'Build it', doing: 'building it',
    stepSince: '2026-10-02T11:56:00.000Z', stepLimitMinutes: 30,
  });
  assert.equal(activity.cardOf(row, { ...entry, waitingOn: 'them' }).waitingOn, 'them');

  const gone = activity.cardOf(row, null);
  assert.equal(gone.state, 'done');
  assert.equal(gone.outcome, 'stopped', 'no run and nothing in progress: it stopped, never "still going" forever');
  assert.equal(gone.endedAt, null);
  const superseded = activity.cardOf({ ...row, next_at: '2026-10-02T11:58:00Z' }, entry);
  assert.equal(superseded.outcome, 'stopped', 'a newer card on the same request is the one going');

  const asked = activity.cardOf({ ...row, run_id: 5, verdict: 'question', run_at: '2026-10-02T11:53:00Z' }, entry);
  assert.equal(asked.state, 'done');
  assert.equal(asked.outcome, 'question', 'an outcome wins over whatever the request is doing since');
  assert.equal(asked.endedAt, '2026-10-02T11:53:00.000Z');
  const proposed = activity.cardOf({
    ...row, run_id: 5, verdict: 'ready', proposal_session_id: 40, proposal_status: 'promoted',
    run_at: '2026-10-02T11:53:00Z', proposal_at: '2026-10-02T12:14:00Z',
  }, null);
  assert.equal(proposed.outcome, 'proposed');
  assert.equal(proposed.endedAt, '2026-10-02T12:14:00.000Z', 'a build ends when its proposal goes up');
  assert.deepEqual(proposed.links, { request: '#app/ear%20trainer/dev/issues/12', proposal: '#app/ear%20trainer/dev/proposals/40' });
  assert.equal(activity.cardOf({ ...row, run_id: 5, verdict: 'ready', build_ok: false }, null).endedAt, null,
    'no record says when a build stopped');
});

test('a card links its request, and its proposal only once people can open it', () => {
  const row = { slug: 'x', issue_number: 3, proposal_session_id: 9 };
  for (const status of ['promoted', 'merging', 'merged']) {
    assert.equal(activity.linksOf({ ...row, proposal_status: status }).proposal, '#app/x/dev/proposals/9', status);
  }
  for (const status of ['active', 'paused', 'closed', null]) {
    assert.equal(activity.linksOf({ ...row, proposal_status: status }).proposal, null, String(status));
  }
  assert.equal(activity.linksOf(row).request, '#app/x/dev/issues/3');
});

// ── Starting one ──

function startDeps({ dmUsers = ['ada'], sendResult, sendThrows = false } = {}) {
  const sent = [];
  const queries = [];
  const pool = { async query(sql, params) { queries.push([String(sql), params]); return { rows: [] }; } };
  const dm = {
    isDmUser: dmSvc.isDmUser,
    requestLine: dmSvc.requestLine,
    async requestStart() { return 77; },
    async sendDm(_pool, args) {
      if (sendThrows) throw new Error('database gone');
      sent.push(args);
      return sendResult === undefined ? { conversationId: 5, messageId: 900, duplicate: false } : sendResult;
    },
  };
  return { pool, dm, sent, queries, settings: { dmUsers } };
}

const app = { id: 11, slug: 'ear-trainer', name: 'Ear Trainer' };
const bot = { id: 1, username: 'homeroom_bot' };
const ada = { userId: 7, username: 'ada', issueTitle: 'Sort by date', firstVersion: false };

test('starting work sends the requester ONE card, keyed by the queue row it was claimed from, and records it', async () => {
  const { pool, dm, sent, queries, settings } = startDeps();
  const out = await activity.startCard(pool, { app, issueNumber: 12, requester: ada, bot, jobKey: 345, settings, deps: { dm } });
  assert.deepEqual(out, { conversationId: 5, messageId: 900, duplicate: false });
  assert.equal(sent.length, 1);
  const [card] = sent;
  assert.equal(card.userId, 7);
  assert.equal(card.idempotencyKey, 'hrbot-activity-345', 'a look handed back and started again keeps its card');
  assert.equal(card.replyToId, 77, 'it quotes the message the request started from, as the bot\'s other news does');
  assert.deepEqual(card.metadata, {
    kind: 'activity', appSlug: 'ear-trainer', appName: 'Ear Trainer', issueNumber: 12, issueTitle: 'Sort by date', mirrors: true,
  });
  assert.match(card.content, /^\*\*Ear Trainer\*\* · request #12: Sort by date\n\nI'm working on this now\. This card updates as I go\.$/);
  const insert = queries.find(([sql]) => /INSERT INTO homeroom_bot_dm_messages/.test(sql));
  assert.ok(insert, 'recorded as the bot\'s news about the request');
  assert.deepEqual(insert[1], [900, 7, 5, 11, 12, 'activity']);
});

test('a first version\'s card says so', async () => {
  const { pool, dm, sent, settings } = startDeps();
  await activity.startCard(pool, {
    app, issueNumber: 1, requester: { ...ada, issueTitle: null, firstVersion: true }, bot, jobKey: 9, settings, deps: { dm },
  });
  assert.equal(sent[0].metadata.firstVersion, true);
  assert.match(sent[0].content, /^\*\*Ear Trainer\*\*, its first version\n\nI'm working on the first version now\./);
});

test('no card for somebody the bot does not talk to in a DM, nor without a requester or a job', async () => {
  const off = startDeps({ dmUsers: ['sam'] });
  assert.equal(await activity.startCard(off.pool, { app, issueNumber: 12, requester: ada, bot, jobKey: 1, settings: off.settings, deps: { dm: off.dm } }), null);
  assert.equal(off.sent.length, 0);
  const on = startDeps();
  assert.equal(await activity.startCard(on.pool, { app, issueNumber: 12, requester: null, bot, jobKey: 1, settings: on.settings, deps: { dm: on.dm } }), null);
  assert.equal(await activity.startCard(on.pool, { app, issueNumber: 12, requester: ada, bot, jobKey: null, settings: on.settings, deps: { dm: on.dm } }), null);
  assert.equal(await activity.startCard(on.pool, { app, issueNumber: 0, requester: ada, bot, jobKey: 1, settings: on.settings, deps: { dm: on.dm } }), null);
  assert.equal(on.sent.length, 0);
});

test('the same piece of work sent again is not recorded twice, and a card that cannot be sent never costs the work', async () => {
  const dup = startDeps({ sendResult: { conversationId: 5, messageId: 900, duplicate: true } });
  await activity.startCard(dup.pool, { app, issueNumber: 12, requester: ada, bot, jobKey: 3, settings: dup.settings, deps: { dm: dup.dm } });
  assert.ok(!dup.queries.some(([sql]) => /INSERT INTO homeroom_bot_dm_messages/.test(sql)));
  const refused = startDeps({ sendResult: null });
  assert.equal(await activity.startCard(refused.pool, { app, issueNumber: 12, requester: ada, bot, jobKey: 3, settings: refused.settings, deps: { dm: refused.dm } }), null);
  const broken = startDeps({ sendThrows: true });
  assert.equal(await activity.startCard(broken.pool, { app, issueNumber: 12, requester: ada, bot, jobKey: 3, settings: broken.settings, deps: { dm: broken.dm } }), null);
});

test('the live loop starts a card where it tells the request it is looking: never for a follow-up, a restart or a backlog pass', () => {
  const source = read('src/services/homeroom-bot.js');
  const body = source.slice(source.indexOf('async function runTriage('), source.indexOf('function shadowBuildSkipReason('));
  const followUp = body.indexOf('return runFollowUp(pool, config, {');
  const looking = body.indexOf("kind: 'looking', text: live.lookingText(), sender: bot,");
  const start = body.indexOf('await activity().startCard(pool, {');
  const reading = body.indexOf('const seedReadAt = new Date().toISOString();');
  assert.ok(followUp > -1 && looking > -1 && start > -1 && reading > -1);
  assert.ok(followUp < looking && looking < start && start < reading,
    'after a follow-up has returned and the looking post is made, before the request is read');
  assert.match(body.slice(looking, reading),
    /if \(item\.reason !== RESTART_REASON && item\.reason !== APP_AGAIN_REASON\) \{\s*await activity\(\)\.startCard\(pool, \{ app, issueNumber, requester, bot, jobKey: item\.id, settings, deps: \{ dm: deps\.dm \} \}\);/);
  // Inside the live branch: shadow triage has no card.
  const live = body.lastIndexOf('if (liveMode) {', looking);
  assert.ok(live > -1 && body.indexOf('const open = await live.openBotProposal', live) < looking);
});

// ── The route and the demo ──

test('the route reads the signed-in person\'s cards and nothing the request names', () => {
  const routes = read('src/routes/conversations.js');
  const start = routes.indexOf("router.get('/api/conversations/homeroom-bot/activity'");
  assert.ok(start > -1, 'the route exists');
  assert.ok(start < routes.indexOf("router.get('/api/conversations/:id',"), 'and is declared before the id routes');
  const body = routes.slice(start, routes.indexOf('\n  });', start));
  assert.match(body, /activity\.cardsFor\(pool, \{ user: req\.user, config \}\)/);
  assert.match(body, /if \(isDemo\(req\)\) return res\.json\(await activity\.demoCards\(pool, req\.user\)\);/);
  assert.doesNotMatch(body, /req\.(?:params|body)|req\.query\.(?!demo)/, 'no user, conversation or message is read from the request');
  const service = read('src/services/homeroom-bot-activity.js');
  assert.match(service, /WHERE d\.user_id = \$1 AND d\.kind = 'activity'/);
});

test('the staging demo has one card being built and one that ended in a proposal, opening nothing', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const demo = activity.demoState({ working: 41, done: 40 }, now);
  const [working, done] = demo.cards;
  assert.equal(working.messageId, 41);
  assert.equal(working.state, 'working');
  assert.deepEqual([working.step, working.of, working.stepName], [3, 6, 'Build it']);
  assert.equal(done.messageId, 40);
  assert.equal(done.outcome, 'proposed');
  for (const card of demo.cards) assert.deepEqual(card.links, { request: null, proposal: null });
  assert.deepEqual(activity.demoState({}, now), { cards: [] }, 'a fixture without its cards has no state to show');
  // The fixture sends its two cards with the keys demoCards finds them by.
  const fixture = read('src/services/staging-messages.js');
  assert.match(fixture, /require\('\.\/homeroom-bot-activity'\)\.DEMO_CARD_KEYS/);
  assert.match(fixture, /key: cardKeys\.done, issueNumber: 9/);
  assert.match(fixture, /key: cardKeys\.working, issueNumber: 14/);
  assert.match(fixture, /kind: 'activity', appName: 'Staging demo app'/);
});

// ── The client ──

test('the client keeps only in-app links, whole steps and known endings, and never reads an unknown state as going', () => {
  const { normalizeBotActivity } = loadTsx(API);
  const cards = normalizeBotActivity({
    cards: [
      {
        messageId: 31, state: 'working', startedAt: 'a', step: 3, of: 6, stepName: 'Build it', doing: 'building it',
        links: { request: '#app/x/dev/issues/3', proposal: 'javascript:alert(1)' }, outcome: 'proposed',
      },
      { messageId: 32, state: 'working', step: 7, of: 6, links: { request: 'https://example.test/x' } },
      { messageId: 33, state: 'done', outcome: 'live', endedAt: 'b', step: 2, of: 6, doing: 'x', links: { proposal: '#app/x/dev/proposals/9' } },
      { messageId: 34, state: 'done', outcome: 'nonsense' },
      { messageId: 35, state: 'paused' },
      { state: 'working' },
    ],
  });
  assert.deepEqual(cards.map((c) => c.messageId), [31, 32, 33, 34, 35], 'a card without a message is dropped');
  assert.deepEqual(cards[0], {
    messageId: 31, state: 'working', startedAt: 'a', links: { request: '#app/x/dev/issues/3', proposal: null },
    step: 3, of: 6, stepName: 'Build it', doing: 'building it', outcome: null, endedAt: null,
  });
  assert.equal(cards[1].step, null, 'step 7 of 6 is not a step');
  assert.equal(cards[1].links.request, null);
  assert.deepEqual([cards[2].state, cards[2].outcome, cards[2].endedAt, cards[2].step, cards[2].doing], ['done', 'live', 'b', null, null]);
  assert.equal(cards[2].links.proposal, '#app/x/dev/proposals/9');
  assert.equal(cards[3].outcome, 'stopped');
  assert.deepEqual([cards[4].state, cards[4].outcome], ['done', 'stopped']);
  assert.deepEqual(normalizeBotActivity(null), []);
});

const NOW = new Date('2026-10-02T12:00:00Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60000).toISOString();
const META = { kind: 'activity', appSlug: 'ear-trainer', appName: 'Ear Trainer', issueNumber: 12, issueTitle: 'Sort by date', mirrors: true };
const working = (extra = {}) => ({
  messageId: 31, state: 'working', startedAt: minutesAgo(9), links: { request: '#app/ear-trainer/dev/issues/12', proposal: null },
  step: 3, of: 6, stepName: 'Build it', doing: 'building it', outcome: null, endedAt: null, ...extra,
});
const done = (outcome, extra = {}) => ({
  messageId: 31, state: 'done', startedAt: minutesAgo(90), links: { request: '#app/ear-trainer/dev/issues/12', proposal: null },
  step: null, of: null, stepName: null, doing: null, outcome, endedAt: minutesAgo(67), ...extra,
});

function draw(props) {
  const { BotActivityCardView } = loadTsx(CARD);
  return renderToHtml(createElement(BotActivityCardView, { meta: META, loaded: true, now: NOW, ...props }));
}

test('a card going: its step as a ring and in words, what it is doing, how long so far, and its request', () => {
  const html = draw({ card: working() });
  assert.match(html, /^<div class="[^"]*rounded-2xl[^"]*" role="group" aria-label="Homeroom bot activity: Ear Trainer #12: Sort by date" data-bot-activity="working">/);
  assert.match(html, /<svg [^>]*role="img" aria-label="Step 3 of 6: Build it">/);
  assert.match(html, />3\/6<\/text>/);
  assert.match(html, /stroke-dasharray="47\.125 94\.25"/, 'half the ring: step 3 of 6');
  assert.match(html, /data-bot-activity-eyebrow="">Step 3 of 6 · Build it</);
  assert.match(html, /motion-safe:animate-ping/, 'a live dot while it goes');
  assert.match(html, />Ear Trainer #12: Sort by date</);
  assert.match(html, /<span role="status">Building it<\/span><span> · 9m so far<\/span>/,
    'only what it is doing is announced; the clock beside it is not, every half minute');
  assert.match(html, /<a href="#app\/ear-trainer\/dev\/issues\/12" class="[^"]*rounded-full[^"]*" data-bot-activity-link="">Request #12<\/a>/);
  assert.doesNotMatch(html, /Open proposal/);

  const queued = draw({ card: working({ step: 1, stepName: 'Read the request', doing: 'waiting in the queue (number 3) to be read', startedAt: minutesAgo(75) }) });
  assert.match(queued, /Waiting in the queue \(number 3\) to be read<\/span><span> · 1h 15m so far/);
  const unstepped = draw({ card: working({ step: null, of: null, stepName: null, doing: null }) });
  assert.match(unstepped, /data-bot-activity-eyebrow="">Working on it</);
  assert.doesNotMatch(unstepped, /role="img"/);
  assert.match(unstepped, /<span role="status">Working on it<\/span>/);
});

test('a card done: what it came to, at a glance and in words, how long it took, and where to open it', () => {
  const proposed = draw({ card: done('proposed', { links: { request: '#app/ear-trainer/dev/issues/12', proposal: '#app/ear-trainer/dev/proposals/40' } }) });
  assert.match(proposed, /data-bot-activity="done" data-bot-activity-outcome="proposed"/);
  assert.match(proposed, /data-bot-activity-eyebrow="">Done</);
  assert.match(proposed, /<span role="status">Built it\. The proposal is up for a vote<\/span><span> · took 23m<\/span>/);
  assert.match(proposed, /d="M5 13l4 4L19 7"/, 'a check where the ring was');
  assert.match(proposed, />Open proposal<\/a><a [^>]*>Request #12<\/a>/, 'the proposal first');
  assert.doesNotMatch(proposed, /animate-ping|role="img"/);

  const asked = draw({ card: done('question') });
  assert.match(asked, /data-bot-activity-eyebrow="">Needs you</);
  assert.match(asked, /Asked you a question/);
  const failed = draw({ card: done('build_failed', { endedAt: null }) });
  assert.match(failed, /data-bot-activity-eyebrow="">Didn’t finish</);
  assert.match(failed, /<span role="status">Couldn’t finish building it<\/span><\/p>/, 'no "took" without an end');
  assert.match(failed, /bg-red-500\/10 text-red-700 [^"]*dark:text-red-400/);
  assert.match(draw({ card: done('person') }), /data-bot-activity-eyebrow="">Ended</);
  assert.match(draw({ card: done('stopped', { endedAt: null }) }), /Stopped before it finished/);
});

test('a card before its state is read, when the read failed, and when there is none to show', () => {
  const pending = draw({ card: null, loaded: false });
  assert.match(pending, /data-bot-activity="pending"/);
  assert.match(pending, />Ear Trainer #12: Sort by date</, 'the title, from the message itself, at once');
  assert.match(pending, /aria-hidden="true"><\/div><\/div><\/div><\/div>$/, 'and a placeholder line for its state');
  const failed = draw({ card: null, failed: true });
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Couldn’t load how far along this is\./);
  assert.match(failed, /<button type="button" class="[^"]*">Try again<\/button>/);
  const none = draw({ card: null, loaded: true });
  assert.match(none, /No progress to show for this one\./);
  assert.doesNotMatch(none, /data-bot-activity-link/);
});

test('every ending has words and a look, and the title is the tray\'s name for the same work', () => {
  const { ACTIVITY_OUTCOME_LABELS, ACTIVITY_OUTCOME_TONES, activityTitle, spanText } = loadTsx(CARD);
  assert.deepEqual(Object.keys(ACTIVITY_OUTCOME_LABELS).sort(), [...activity.OUTCOMES].sort());
  assert.deepEqual(Object.keys(ACTIVITY_OUTCOME_TONES).sort(), [...activity.OUTCOMES].sort());
  assert.equal(activityTitle(META), 'Ear Trainer #12: Sort by date');
  assert.equal(activityTitle({ kind: 'activity', appName: 'Ear Trainer', issueNumber: 1, firstVersion: true }), 'Ear Trainer first version');
  assert.equal(activityTitle({ kind: 'activity', appSlug: 'notes', issueNumber: 3 }), 'notes #3');
  assert.equal(spanText(minutesAgo(0.5), NOW), 'under a minute');
  assert.equal(spanText(minutesAgo(59), NOW), '59m');
  assert.equal(spanText(minutesAgo(60), NOW), '1h');
  assert.equal(spanText(minutesAgo(60 * 26 + 5), NOW), '1d 2h');
  assert.equal(spanText(minutesAgo(-5), NOW), 'under a minute', 'a clock ahead of the server never reads negative');
  assert.equal(spanText(null, NOW), null);
});

test('the row draws a bot\'s activity message as the card, in place of its words', () => {
  const { isActivityMessage } = loadTsx(CARD);
  const message = (extra) => ({
    id: 31, sender: { id: 1, username: 'homeroom_bot', bot: true }, content: 'words', metadata: { homeroomBot: META }, ...extra,
  });
  assert.equal(isActivityMessage(message()), true);
  assert.equal(isActivityMessage(message({ sender: { id: 2, username: 'ada' } })), false, 'only the bot\'s');
  assert.equal(isActivityMessage(message({ metadata: { homeroomBot: { ...META, kind: 'spec' } } })), false);
  assert.equal(isActivityMessage(message({ deleted: true })), false);
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /\) : isActivityMessage\(message\) \? \([\s\S]{0,200}<BotActivityCard message=\{message\} \/>\s*\) : message\.content \? <MessageMarkdown/);
});

test('only the bot\'s DM keeps the cards current, beside its tray', () => {
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /\{botDm \? <BotWorkSync [^\n]*\n[^\n]*\n\s*\{botDm \? <BotActivitySync conversationId=\{conversationId\} newsKey=\{newestBotMessageId\(snap\.messages\)\} \/> : null\}/);
});

test('the staging preview\'s declared check finds the card being built in the demo DM, beside the tray', () => {
  const check = JSON.parse(read('dapp.json')).tests.find((t) => t.id === 'homeroom-bot-dm-activity-tray');
  assert.equal(check.path, '/?demo=1#messages/910005');
  assert.match(check.expectSelector, /\.messages-thread-pane:has\(\[data-bot-activity=working\] \[aria-label="Step 3 of 6: Build it"\]\)/);
  assert.ok(check.impact.includes('src/services/homeroom-bot-activity.js'));
});

// ── Kept current: the loop's announcement and the bot's news ──

/** A React small enough to step through: the three hooks the store uses, effects included. */
function createFakeReact() {
  const slots = [];
  let cursor = 0;
  let renderFn = null;
  let effects = [];
  const changed = (prev, next) => !prev || !next || prev.length !== next.length || prev.some((v, i) => !Object.is(v, next[i]));
  const slot = (init) => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = init();
    return slots[i];
  };
  function render() {
    cursor = 0;
    effects = [];
    renderFn();
    for (const run of effects) run();
  }
  const React = {
    useRef: (current) => slot(() => ({ current })),
    useEffect(effect, deps) {
      const s = slot(() => ({ fresh: true, deps: undefined, cleanup: undefined }));
      if (!s.fresh && !changed(s.deps, deps)) return;
      s.fresh = false;
      s.deps = deps;
      effects.push(() => {
        if (typeof s.cleanup === 'function') s.cleanup();
        s.cleanup = effect();
      });
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      slot(() => ({ unsubscribe: subscribe(() => render()) }));
      return getSnapshot();
    },
  };
  return {
    React,
    mount(fn) { renderFn = fn; render(); },
    render,
    unmount() { for (const s of slots) if (s && typeof s.cleanup === 'function') s.cleanup(); },
  };
}

function loadStore(t, { responses }) {
  const saved = ['window', 'document'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  t.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const win = new EventTarget();
  const timers = new Map();
  let timerId = 0;
  win.setInterval = (fn, ms) => { timerId += 1; timers.set(timerId, { fn, ms }); return timerId; };
  win.clearInterval = (id) => { timers.delete(id); };
  globalThis.window = win;
  globalThis.document = { visibilityState: 'visible' };
  const reads = [];
  const api = {
    getHomeroomBotActivity(options) {
      reads.push(options);
      const next = responses.shift();
      return typeof next === 'function' ? next() : Promise.resolve(next || []);
    },
  };
  const fake = createFakeReact();
  const store = loadTsx(STORE, {
    stubs: { react: fake.React, './api': api, './bot-work': { WORK_CHANGED_EVENT: 'homeroom-bot-work-changed' } },
  });
  return { store, fake, reads, timers, win };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the store reads again when the loop announces work for the viewer, and when the bot\'s news lands', async (t) => {
  const { WORK_CHANGED_EVENT } = loadTsx('frontend/src/features/messages/bot-work.tsx');
  assert.equal(WORK_CHANGED_EVENT, 'homeroom-bot-work-changed', 'the window event app.js turns homeroom_bot_work_changed into');

  const reading = { messageId: 31, state: 'working', step: 1, of: 6, doing: 'reading the request', links: {} };
  const building = { ...reading, step: 3, doing: 'building it' };
  const ended = { messageId: 31, state: 'done', outcome: 'proposed', links: {} };
  const { store, fake, reads, timers, win } = loadStore(t, { responses: [[reading], [building], [ended]] });
  let newsKey = 50;
  fake.mount(() => store.useBotActivitySync(5, newsKey));
  await settle();
  assert.deepEqual(reads, [{ fresh: false }], 'opening the DM reads once; its first news is what was there');
  assert.equal(store.getBotActivity().cards.get(31).step, 1);
  assert.equal(timers.size, 1, 'a card going is asked about now and then');

  // The live loop started or ended a piece of work for this person.
  win.dispatchEvent(new Event('homeroom-bot-work-changed'));
  await settle();
  assert.deepEqual(reads, [{ fresh: false }, { fresh: true }], 'a re-read, past the worker\'s offline copy');
  assert.equal(store.getBotActivity().cards.get(31).doing, 'building it');

  // The bot's news landed in the DM.
  newsKey = 51;
  fake.render();
  await settle();
  assert.equal(reads.length, 3);
  assert.equal(store.getBotActivity().cards.get(31).outcome, 'proposed');
  assert.equal(timers.size, 0, 'nothing going: no more asking');

  fake.unmount();
  win.dispatchEvent(new Event('homeroom-bot-work-changed'));
  await settle();
  assert.equal(reads.length, 3, 'leaving the DM stops listening');
});

test('only the newest read lands, a failed one keeps what was read, and a card drawn first reads once', async (t) => {
  let release;
  const slow = () => new Promise((resolve) => { release = () => resolve([{ messageId: 31, state: 'working', links: {} }]); });
  const { store, reads } = loadStore(t, {
    responses: [slow, [{ messageId: 31, state: 'done', outcome: 'question', links: {} }], () => Promise.reject(new Error('offline'))],
  });
  store.ensureBotActivity();
  store.ensureBotActivity();
  assert.equal(reads.length, 1, 'cards drawn before any read ask once between them');
  const newer = store.loadBotActivity();
  await newer;
  assert.equal(store.getBotActivity().cards.get(31).outcome, 'question');
  release();
  await settle();
  assert.equal(store.getBotActivity().cards.get(31).outcome, 'question', 'the older read, landing late, is dropped');
  await store.loadBotActivity();
  assert.equal(store.getBotActivity().failed, true);
  assert.equal(store.getBotActivity().cards.get(31).outcome, 'question', 'what was read before stays');
  store.ensureBotActivity();
  assert.equal(reads.length, 3, 'already read: nothing more to ensure');
});
