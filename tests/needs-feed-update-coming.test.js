'use strict';

// #6282 (4 Nov 2026): a change with an update on its way asks for no vote.
//
// The shared predicate (homeroom-bot-progress.js updateComingSql) and the
// windows it reads are pinned against the bot's own constants; standing()
// puts the change under In progress as Updating (a turn runs, or the bot
// holds an ask it took) or under Waiting as Update queued (an ask waits its
// turn); the AI tab's two words and the Votes card's held button are read
// here too. The feed itself, against a real database, is
// tests/needs-feed-update-coming-postgres.test.js.
//
// Run with: node --test tests/needs-feed-update-coming.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const progress = require('../src/services/homeroom-bot-progress');
const { standing, arrange } = require('../src/services/ai-work');

test('#6282: the update-in-flight windows are the bot\'s own', () => {
  assert.equal(progress.UPDATE_TAKEN_HOURS, 3);
  assert.equal(progress.UPDATE_QUEUED_DAYS, 7);
  // homeroom-bot-voice.js owns STALE_ASK_HOURS: an ask taken longer ago than
  // this is put back to queued, so it must stop holding the vote with it.
  const voice = read('src/services/homeroom-bot-voice.js');
  assert.match(voice, /const STALE_ASK_HOURS = (\d+);/);
  assert.equal(progress.UPDATE_TAKEN_HOURS, Number(voice.match(/const STALE_ASK_HOURS = (\d+);/)[1]));
  // homeroom-bot.js sweepStrandedAsks reads queued asks younger than a week.
  assert.match(read('src/services/homeroom-bot.js'), /created_at > NOW\(\) - INTERVAL '7 days'/);
  assert.equal(progress.UPDATE_QUEUED_DAYS, 7);
});

// ── standing(): where an update on its way puts the change ──────────────
const NOW = new Date('2026-11-04T12:00:00Z');
const row = (over = {}) => ({
  state: 'open', kind: 'request', number: 6250, request_state: 'open',
  request_at: '2026-11-04T09:00:00Z', created_at: '2026-11-04T09:00:00Z',
  change_status: 'promoted', change_id: 42, change_user: 9, check_state: 'passing',
  voted: false, my_vote: null, by_agent: false, own: false,
  promoted_at: '2026-11-04T10:00:00Z', last_activity_at: '2026-11-04T11:00:00Z',
  ...over,
});
const ASK = 'drop the second credit line';

test('#6282: a change being updated is In progress, never the vote it would owe', () => {
  // The viewer (7) still owes the vote the feed would have asked for.
  assert.deepEqual(standing(row({ update_coming: 'running', update_ask: ASK }), 7, NOW), {
    group: 'next', what: 'updating', at: '2026-11-04T11:00:00.000Z', ask: ASK,
  });
  // A turn with nobody's ask behind it says only that it is updating.
  assert.deepEqual(standing(row({ update_coming: 'running', update_ask: null }), 7, NOW), {
    group: 'next', what: 'updating', at: '2026-11-04T11:00:00.000Z',
  });
  // An ask waiting its turn is Waiting, Update queued.
  assert.deepEqual(standing(row({ update_coming: 'queued', update_ask: ASK }), 7, NOW), {
    group: 'waiting', what: 'update_queued', at: '2026-11-04T11:00:00.000Z', ask: ASK,
  });
  // With no update coming it is the Needs you feed's again (nothing here).
  assert.equal(standing(row({ update_coming: null }), 7, NOW), null);
});

test('#6282: the ask is one line of at most 80 characters', () => {
  const long = 'drop the second credit line and make the first one say what it is for, then reword the note above';
  const stand = standing(row({ update_coming: 'running', update_ask: long }), 7, NOW);
  assert.equal(stand.ask.length, 80);
  assert.ok(stand.ask.endsWith('…'));
  // Whitespace folds, so the tooltip stays one line.
  assert.equal(standing(row({ update_coming: 'running', update_ask: '  drop\nthe   second  ' }), 7, NOW).ask,
    'drop the second');
});

test('#6282: it is listed for who would vote and for its own people, not a voter from the thread', () => {
  const update = { update_coming: 'running', update_ask: ASK };
  // Its author (7) asked for it: In progress, even having voted.
  assert.equal(standing(row({ ...update, change_user: 7 }), 7, NOW).what, 'updating');
  assert.equal(standing(row({ ...update, change_user: 7, voted: true, my_vote: 'yes' }), 7, NOW).what, 'updating');
  // Someone who only follows it (own) sees it too.
  assert.equal(standing(row({ ...update, own: true, voted: true }), 7, NOW).what, 'updating');
  // Somebody who already voted and only wrote in the thread gets no row.
  assert.equal(standing(row({ ...update, voted: true, my_vote: 'yes' }), 7, NOW), null);
});

test('#6282: a more particular stage of the bot\'s still wins, and Revising reads Updating', () => {
  // The bot's own stage for the requester: Revising was this exact update, and
  // now says what it is doing.
  assert.deepEqual(
    standing(row({ update_coming: 'running', update_ask: ASK, change_user: 7 }), 7, NOW, 99,
      { stage: 'revising', since: '2026-11-04T11:30:00Z' }),
    { group: 'next', what: 'updating', at: '2026-11-04T11:30:00.000Z', ask: ASK });
  assert.equal(
    standing(row({ update_coming: 'queued', update_ask: ASK, change_user: 7 }), 7, NOW, 99,
      { stage: 'followup_queued', since: '2026-11-04T11:30:00Z' }).what,
    'update_queued');
  // Fixing and a queued fix say something more particular than Updating.
  assert.equal(
    standing(row({ update_coming: 'running', update_ask: ASK, change_user: 7 }), 7, NOW, 99,
      { stage: 'fixing', since: '2026-11-04T11:30:00Z' }).what,
    'fixing');
});

test('#6282: Updating sorts with Revising and Update queued with a follow-up', () => {
  const base = {
    state: 'open', kind: 'request', request_state: 'open', slug: 'garden', name: 'Garden',
    icon_url: null, icon_emoji: null, repo_url: null,
    request_at: '2026-11-04T09:00:00Z', created_at: '2026-11-04T09:00:00Z',
  };
  const owed = (number, extra) => ({
    ...base, number, change_status: 'promoted', change_id: number, change_user: 9,
    check_state: 'passing', voted: false, by_agent: false, own: false,
    promoted_at: '2026-11-04T10:00:00Z', ...extra,
  });
  const bots = new Map([
    ['garden#1', { stage: 'fixing', since: '2026-11-04T08:00:00Z' }],
    ['garden#3', { stage: 'followup_queued', since: '2026-11-04T08:00:00Z' }],
  ]);
  const lists = arrange([
    owed(2, { update_coming: 'running', update_ask: ASK, last_activity_at: '2026-11-04T11:00:00Z' }),
    { ...base, number: 1, own: true },
    owed(4, { update_coming: 'queued', update_ask: ASK, last_activity_at: '2026-11-04T11:00:00Z' }),
    { ...base, number: 3, own: true },
  ], 7, NOW, 99, bots);
  assert.deepEqual(lists.next.map((r) => [r.number, r.what]), [[1, 'fixing'], [2, 'updating']]);
  assert.deepEqual(lists.waiting.map((r) => [r.number, r.what]), [[3, 'followup_queued'], [4, 'update_queued']]);
});

test('#6282: the AI tab says Updating and Update queued, with what was asked', () => {
  const { nextWords, shortWords } = loadTsx('frontend/src/features/ai/model.ts');
  const words = (p) => message(p.id, p.values);
  const app = { slug: 'garden', name: 'Garden', icon_url: null, icon_emoji: null };
  const thread = (what, extra = {}) => ({
    threadId: 1, number: 12, kind: 'change', title: 'Bigger buttons', app, change: { id: 42, number: 12 },
    href: '#app/garden/dev/changes/12', group: 'next', what, at: null, ...extra,
  });
  assert.equal(words(nextWords(thread('updating', { ask: ASK }))), `Garden · #12 · Updating: ${ASK}`);
  assert.equal(words(nextWords(thread('updating', { ask: null }))), 'Garden · #12 · Updating the change');
  assert.equal(words(nextWords(thread('update_queued', { ask: ASK }))), `Garden · #12 · Update queued: ${ASK}`);
  assert.equal(words(nextWords(thread('update_queued', { ask: null }))), 'Garden · #12 · Update queued');
  // On GitHub the change's number is written PR, not #.
  const onGithub = { ...app, changesOnGithub: true };
  assert.equal(words(nextWords(thread('updating', { ask: ASK, app: onGithub }))), `Garden · PR 12 · Updating: ${ASK}`);
  assert.equal(words(nextWords(thread('update_queued', { ask: ASK, app: onGithub }))), `Garden · PR 12 · Update queued: ${ASK}`);
  assert.equal(words(shortWords(thread('updating'))), 'Updating');
  assert.equal(words(shortWords(thread('update_queued'))), 'Update queued');
});

// ── the Votes card ──────────────────────────────────────────────────────
function avContext() {
  const noop = () => {};
  const c = {
    console, App: { user: { id: 7, username: 'ada' }, currentApp: 'garden', currentTab: 'dev',
      _appUrl: (slug, tab, ref) => `#app/${slug}/${tab}/issues/${ref?.id}` },
    relTime: () => 'just now',
    document: { getElementById: () => null, querySelector: () => null, addEventListener: noop },
    localStorage: { getItem: () => null }, addEventListener: noop,
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '' }, URLSearchParams,
  };
  c.window = c;
  c.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(c);
  for (const p of ['public/js/merge-status.js', 'public/js/app-view.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, p), 'utf8'), c);
  }
  vm.runInContext('globalThis.av = AppView', c);
  c.av.appData = { slug: 'garden', can_collaborate: true };
  c.av._proposalsCtx = { majority: 2, activeUsers: 5, locked: false };
  return c.av;
}

test('#6282: the Votes card says an update is coming and takes no vote', () => {
  const av = avContext();
  const item = {
    id: 42, status: 'promoted', user_id: 9, my_vote: null, check_state: 'passing',
    update_coming: 'running',
  };
  const card = { pill: { state: { key: 'needs_vote', yes: 1, no: 0, majority: 2 } } };
  const held = av._changeVotesView(item, card);
  assert.equal(held.hold, true);
  assert.notEqual(held.tone, 'ask');
  assert.equal(held.note[0], message('changes:page.votes.note.updateComing'));
  // The tally and who can vote stay as they were.
  assert.equal(held.label, 'Votes: 1 of 2 yes');
  assert.ok(held.note.some((line) => /Any of the 5 members/.test(line)));
  // With no update coming, it asks as it always did.
  const open = av._changeVotesView({ ...item, update_coming: null }, card);
  assert.equal(open.hold, undefined);
  assert.equal(open.tone, 'ask');
});

test('#6282: the Votes card offers no button while it is held', () => {
  const { ChangeGates } = loadTsx('frontend/src/features/dev-board/topic/change-head.tsx');
  const card = {
    actions: [
      { key: 'vote-yes', cls: 'gc-vote-btn-yes', label: 'Yes' },
      { key: 'vote-no', cls: 'gc-vote-btn-no', label: 'No' },
    ],
    rail: {},
  };
  const view = (hold) => ({
    number: 12, status: null, category: null, author: 'ada', at: null, time: '', timeTitle: '',
    via: null, thanks: false,
    votes: {
      name: 'Votes', figure: 'Needs 1 more yes', tone: hold ? 'muted' : 'ask', done: false,
      segments: [{ weight: 1, pct: 0, state: 'moving' }], label: '1 of 2',
      note: [hold ? 'An update is coming: votes cast now are cleared when it lands.' : 'Any of the 5 members can give it.'],
      ...(hold ? { hold: true } : {}),
    },
    testing: {
      name: 'Testing', figure: 'Checks passed', tone: 'done', done: true,
      segments: [{ weight: 1, pct: 100, state: 'done' }], label: 'Checks passed', note: [],
    },
    shots: { state: 'none', html: '', line: null },
  });
  const html = (hold) => renderToHtml(createElement(ChangeGates, { id: 42, card, v: view(hold) }));
  assert.doesNotMatch(html(true), /dev-vote-btn/);
  assert.match(html(true), /An update is coming/);
  assert.match(html(false), /dev-vote-btn/);
});
