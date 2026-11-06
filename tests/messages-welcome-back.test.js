'use strict';

// #6426 — Main Chat's "Welcome back" card.
//
// After eight hours away, the first time somebody opens Main Chat a small
// card sits above the message box: what changed since their last visit, and
// four questions they can tap. This pins the decisions that make it right:
// when it is due, what it counts, the day it names, the project chip, the
// four chips in their one order (no request numbers), and that its words are
// real catalog entries.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const t = (id, values) => message(id, values);

const HOUR = 60 * 60 * 1000;
const NOW = new Date(2026, 10, 6, 15, 0, 0);
const iso = (date) => date.toISOString();
const daysAgo = (days, hour = 10) => {
  const date = new Date(NOW);
  date.setDate(date.getDate() - days);
  date.setHours(hour, 0, 0, 0);
  return iso(date);
};

const {
  AWAY_MS, welcomeDue, welcomeCounts, welcomeParts, welcomeLine, welcomeChips,
  busiestProject, visitDay, visitDayText, WelcomeBackView,
} = loadTsx('frontend/src/features/messages/welcome-back.tsx');

test('#6426: the card is due eight hours after the last visit, never without one', () => {
  assert.equal(AWAY_MS, 8 * HOUR);
  const visit = NEW_VISIT();
  assert.equal(welcomeDue(null, Date.parse(visit)), false, 'no visit recorded: no card');
  assert.equal(welcomeDue(visit, Date.parse(visit) + 8 * HOUR - 1), false, 'one millisecond short');
  assert.equal(welcomeDue(visit, Date.parse(visit) + 8 * HOUR), true, 'exactly eight hours');
  assert.equal(welcomeDue(visit, Date.parse(visit) + 9 * HOUR), true);
});

function NEW_VISIT() {
  return '2026-11-06T05:00:00.000Z';
}

test('#6426: counts are only what happened after the visit, in the AI page\'s three buckets', () => {
  const since = daysAgo(1, 9);
  const before = daysAgo(3);
  const after = daysAgo(0, 12);
  const work = {
    private: [],
    live: [
      { app: { slug: 'a', name: 'A' }, at: before, mergedAt: after },
      { app: { slug: 'b', name: 'B' }, at: after },
      { app: { slug: 'c', name: 'C' }, at: before, mergedAt: before },
    ],
    needs: [
      { app: { slug: 'a', name: 'A' }, at: after },
      { app: { slug: 'b', name: 'B' }, at: after },
      { app: { slug: 'c', name: 'C' }, at: before },
    ],
    next: [],
    waiting: [],
  };
  const needs = [
    { kind: 'proposal', app: { slug: 'a', name: 'A' }, at: after },
    { kind: 'proposal', app: { slug: 'a', name: 'A' }, at: before },
    { kind: 'ballot', app: { slug: 'a', name: 'A' }, at: after },
    { kind: 'governance', app: { slug: 'a', name: 'A' }, at: after },
    { kind: 'proposal', app: { slug: 'a', name: 'A' }, at: after, waitingOn: ['checks'] },
    { kind: 'comment', app: { slug: 'a', name: 'A' }, at: after },
  ];
  assert.deepEqual(welcomeCounts(work, needs, since), { live: 2, votes: 3, build: 2 });
  assert.deepEqual(welcomeCounts(null, null, since), { live: 0, votes: 0, build: 0 },
    'a read that failed is a quiet day, not an error');
});

test('#6426: the line names the day and leaves out every zero part', () => {
  assert.deepEqual(welcomeParts({ live: 3, votes: 2, build: 1 }, t), [
    message('messages:welcome.live', { count: 3 }),
    message('messages:welcome.votes', { count: 2 }),
    message('messages:welcome.build', { count: 1 }),
  ], 'one / other follow the count');
  assert.equal(welcomeLine('Tuesday', { live: 3, votes: 2, build: 1 }, t),
    'Since Tuesday: 3 changes went live · 2 wait for your vote · 1 plan waits for your Build it');
  assert.equal(welcomeLine('Tuesday', { live: 1, votes: 0, build: 0 }, t),
    'Since Tuesday: 1 change went live', 'a zero part is left out, not shown as 0');
  assert.equal(welcomeLine('yesterday', { live: 0, votes: 0, build: 0 }, t),
    'Nothing new since yesterday. Things you can ask me:');
});

test('#6426: the day is this morning, earlier today, yesterday, a weekday, then a date', () => {
  assert.deepEqual(visitDay(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 9), NOW), { kind: 'thisMorning' });
  assert.deepEqual(visitDay(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 13), NOW), { kind: 'earlierToday' });
  assert.deepEqual(visitDay(daysAgo(1), NOW), { kind: 'yesterday' });
  const threeDays = new Date(NOW);
  threeDays.setDate(threeDays.getDate() - 3);
  const weekday = visitDay(threeDays, NOW);
  assert.equal(weekday.kind, 'weekday');
  assert.equal(weekday.weekday, new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(threeDays));
  const longAgo = visitDay(daysAgo(20), NOW);
  assert.equal(longAgo.kind, 'date');
  assert.equal(visitDay('not a date', NOW), null);
  assert.equal(visitDayText({ kind: 'yesterday' }, t), 'yesterday');
  assert.equal(visitDayText({ kind: 'weekday', weekday: 'Tuesday' }, t), 'Tuesday');
});

test('#6426: the project chip is the busiest since the visit, else the one used last', () => {
  const since = daysAgo(1, 9);
  const after = daysAgo(0, 12);
  const work = {
    private: [],
    live: [{ app: { slug: 'recipe-box', name: 'Recipe Box' }, at: after }],
    needs: [{ app: { slug: 'plant-pal', name: 'Plant Pal' }, at: after }],
    next: [{ app: { slug: 'ledger', name: 'Ledger' }, at: after }],
    waiting: [],
  };
  const needs = [{ kind: 'proposal', app: { slug: 'recipe-box', name: 'Recipe Box' }, at: after }];
  assert.equal(busiestProject(work, needs, since, ['ledger', 'recipe-box', 'plant-pal']), 'Recipe Box',
    'two rows beat one, whichever project is more recent');
  assert.equal(busiestProject(work, needs, since, ['recipe-box', 'ledger']), 'Recipe Box',
    'a tie goes to the earlier project in Recent');
  assert.equal(busiestProject(null, null, since, ['ledger', 'plant-pal'], { ledger: 'Ledger' }), 'Ledger',
    'with no activity, the project used last');
  assert.equal(busiestProject(null, null, since, [], {}), null, 'with neither, the chip is left out');
});

test('#6426: four chips in one order, no request numbers', () => {
  assert.deepEqual(welcomeChips('Tuesday', 'Recipe Box', t), [
    { id: 'waiting', text: "What's waiting on me?" },
    { id: 'live', text: 'What went live since Tuesday?' },
    { id: 'project', text: 'Catch me up on Recipe Box' },
    { id: 'newProject', text: "Let's start a new project" },
  ]);
  for (const chip of welcomeChips('yesterday', 'Recipe Box', t)) {
    assert.ok(!/#/.test(chip.text), `no request or change number in "${chip.text}"`);
  }
  assert.deepEqual(welcomeChips('Tuesday', null, t).map((chip) => chip.id),
    ['waiting', 'live', 'newProject'], 'no project to name, no project chip');
});

test('#6426: every word the card says is a catalog entry', () => {
  for (const id of [
    'messages:welcome.title', 'messages:welcome.dismiss', 'messages:welcome.quiet',
    'messages:welcome.day.thisMorning', 'messages:welcome.day.earlierToday', 'messages:welcome.day.yesterday',
    'messages:welcome.chip.waiting', 'messages:welcome.chip.live', 'messages:welcome.chip.project',
    'messages:welcome.chip.newProject', 'messages:welcome.separator',
  ]) {
    assert.ok(message(id, { day: 'Tuesday', project: 'Recipe Box' }), id);
  }
  for (const key of ['welcome.live', 'welcome.votes', 'welcome.build']) {
    assert.match(message(`messages:${key}`, { count: 1 }), /^1 /, `${key} has a singular`);
    assert.match(message(`messages:${key}`, { count: 2 }), /^2 /, `${key} has a plural`);
  }
});

test('#6426: the card, drawn with its counts and with a quiet day', () => {
  const draw = (props) => renderToHtml(createElement(WelcomeBackView, {
    day: 'Tuesday', counts: { live: 0, votes: 0, build: 0 }, project: null,
    onChip() {}, onDismiss() {}, ...props,
  }));
  const busy = draw({ counts: { live: 3, votes: 2, build: 1 }, project: 'Recipe Box' });
  assert.match(busy, /class="messages-welcome" data-welcome-back=""/);
  assert.match(busy, />Welcome back</);
  assert.match(busy, />Since Tuesday: 3 changes went live · 2 wait for your vote · 1 plan waits for your Build it</);
  assert.match(busy, /<div class="messages-welcome-chips" role="group" aria-label="Welcome back">/);
  assert.match(busy, /data-welcome-chip="waiting"[^>]*>What&#x27;s waiting on me\?</);
  assert.match(busy, /data-welcome-chip="live"[^>]*>What went live since Tuesday\?</);
  assert.match(busy, /data-welcome-chip="project"[^>]*>Catch me up on Recipe Box</);
  assert.match(busy, /data-welcome-chip="newProject"[^>]*>Let&#x27;s start a new project</);
  assert.match(busy, /class="messages-welcome-dismiss" aria-label="Dismiss" title="Dismiss">×</);
  const quiet = draw({});
  assert.match(quiet, />Nothing new since Tuesday\. Things you can ask me:</);
  assert.ok(!/data-welcome-chip="project"/.test(quiet), 'no project to name: the chip is left out');
});

test('#6426: a chip sends its words and closes the card; × closes it too', () => {
  const source = read('frontend/src/features/messages/welcome-back.tsx');
  assert.match(source, /onChip=\{\(text\) => \{ setDismissed\(true\); void send\(\{ content: text \}\); \}\}/,
    'a chip is an ordinary message in the person\'s own name');
  assert.match(source, /className="messages-welcome-dismiss"[\s\S]{0,200}onClick=\{onDismiss\}/,
    '× dismisses the card');
  assert.match(source, /welcomeDue\(start\)[\s\S]{0,80}snap\.active\?\.id === conversationId[\s\S]{0,80}asksInChat\(newestBot\)/,
    'it stays away while the bot\'s newest message asks something open');
  assert.match(read('frontend/src/features/messages/index.tsx'),
    /\{mainChat && botDm && conversationId \? <WelcomeBack/,
    'Main Chat alone renders it, not the lists or the Messages screen');
  assert.match(read('frontend/src/features/messages/index.tsx'),
    /hidePrompts=\{\(plans\.answersOpen \|\| asksWithQuestionsCard\(message\) \|\| \(welcomeShown && message\.id === newestMainBotId\)\)/,
    'the bot\'s leftover suggestions give way while the card shows');
});
