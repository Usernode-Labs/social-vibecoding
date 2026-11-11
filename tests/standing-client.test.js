'use strict';

// 11 Nov 2026 (docs/plans/bot-one-model.md, one model, step 1): the screens
// draw a request's or a change's standing, the one the server decides and
// words (services/work-state.js), and decide nothing of their own: not a
// stage, not its words, not whether there is a vote to cast.
//
//   - lib/work-state.ts reads the server's words, and keeps a push's whole
//     standing (its change, what it asks, what the bot said);
//   - a request being built never says Review plan, anywhere;
//   - a change merged or going live never draws Vote, anywhere;
//   - a request's status card says the standing's own phrase ids;
//   - a work_state push is drawn at once where a screen holds its item.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx } = require('./lib/render-tsx');
const { message, englishPlatformI18n } = require('./lib/platform-i18n');
const { withWords, wordsOf } = require('./lib/work-words');

const ROOT = path.join(__dirname, '..');
const LIB = 'frontend/src/lib/work-state.ts';
const AI = 'frontend/src/features/ai/model.ts';
const THREAD = 'frontend/src/features/dev-board/topic/thread-model.ts';
const plain = (x) => JSON.parse(JSON.stringify(x));

const change = (extra = {}) => ({
  id: 51, number: 8, status: 'promoted', checks: { state: 'passing', phase: null, failing: null },
  votes: { yes: 1, no: 0 }, voteOpen: true, firstVersion: false, githubHold: false, shotsHeld: false,
  conflict: false, update: null, ...extra,
});
const asks = (extra = {}) => ({ question: null, plan: null, closeVote: null, draft: null, offers: [], reports: 0, ...extra });
const standing = (stage, extra = {}) => withWords({
  kind: 'request', stage, why: null, reason: null, line: null, whoseMove: null, since: null,
  change: null, asks: null, said: null, mine: true, voteOwed: false, ...extra,
});
const push = (state, item = {}) => ({
  type: 'work_state', appId: 1, appSlug: 'garden',
  item: { kind: 'request', ref: 7, issueNumber: 7, sessionId: 51, ...item },
  state,
});

function appView() {
  const listeners = {};
  const c = {
    console,
    App: { user: { id: 42, username: 'evan' }, currentApp: 'garden', currentTab: 'dev' },
    relTime: () => ({ text: 'just now', title: '' }),
    document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
    localStorage: { getItem: () => null },
    addEventListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); },
    dispatchEvent() {},
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '' }, URLSearchParams,
    PlatformI18n: englishPlatformI18n(),
  };
  c.window = c;
  vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/js/app-view.js'), 'utf8'), c);
  vm.runInContext('globalThis.av = AppView', c);
  c.av.appData = { id: 1, slug: 'garden', can_collaborate: true };
  c.av._govProposals = [];
  return { av: c.av, listeners };
}

const issue = (patch = {}) => ({
  number: 7, state: 'open', title: 'Dark mode', created_by_username: 'evan', body: 'Make it dark.',
  createdAt: '2026-11-10T09:00:00Z', bounty_count: 0, chatCount: 0, in_progress: null,
  category: { top: null }, priority: { top: null }, assignee: { top: null }, ...patch,
});

// ── The words are the server's ──────────────────────────────────────────

test('the standing\'s words are drawn as the server sent them, and kept through normalization', () => {
  const { stageWords, lineWords, normalizeWorkState, isSettled, voteOpen, waitsForPlan } = loadTsx(LIB);
  const sent = {
    stage: 'building', line: { code: 'queued', place: 3 }, whoseMove: 'bot',
    words: {
      stage: { id: 'core:work.stage.readyToBuild' },
      stageOthers: { id: 'core:work.stage.building' },
      line: { id: 'core:work.line.queuedAt', values: { place: 3 } },
    },
    change: change({ voteOpen: false }),
    asks: asks({ plan: { version: 2, sessionId: 9, at: '2026-11-10T10:00:00Z', waitingGo: false } }),
    said: { messageId: 12, kind: 'note', at: null, text: 'On it.' },
    junk: 'dropped',
  };
  const work = normalizeWorkState(sent);
  assert.deepEqual(plain(stageWords(work, { yours: true })), { id: 'core:work.stage.readyToBuild' });
  assert.deepEqual(plain(stageWords(work, { yours: false })), { id: 'core:work.stage.building' }, 'anyone else\'s words');
  assert.deepEqual(plain(lineWords(work)), { id: 'core:work.line.queuedAt', values: { place: 3 } });
  assert.equal(work.change.id, 51);
  assert.equal(work.change.voteOpen, false);
  assert.equal(work.asks.plan.version, 2);
  assert.equal(work.said.messageId, 12);
  assert.equal(work.junk, undefined);
  // Anybody but its requester gets its cards counted, none named (work-state.js publicOf).
  const counted = normalizeWorkState({ stage: 'reading', asks: asks({ question: { messageId: null, at: null }, openOffers: 2 }) });
  assert.deepEqual(plain(counted.asks), { ...asks({ question: { messageId: null, at: null } }), openOffers: 2 });
  // A payload with no words (an older server) says its plain stage word, and no line.
  const bare = normalizeWorkState({ stage: 'waiting_for_you', why: 'plan', line: { code: 'reason', text: 'x' } });
  assert.deepEqual(plain(stageWords(bare)), { id: 'core:work.stage.waitingForYou' });
  assert.equal(lineWords(bare), null);
  // A phrase id that is no message id is no words at all.
  assert.equal(normalizeWorkState({ stage: 'live', words: { stage: { id: 'not an id' } } }).words, undefined);
  assert.equal(isSettled({ stage: 'going_live' }), true);
  assert.equal(voteOpen({ stage: 'live', change: change() }), false, 'a settled change is never open for votes');
  assert.equal(voteOpen({ stage: 'up_for_vote', change: change() }), true);
  assert.equal(waitsForPlan({ stage: 'building', why: 'plan' }), false);
  // No word tables of its own: the mapping lives once, on the server.
  const src = fs.readFileSync(path.join(ROOT, LIB), 'utf8');
  for (const gone of ['STAGE_WORDS', 'WHY_YOURS', 'WHY_OTHERS', 'REASON_WORDS', 'LINE_WORDS', 'NOT_STARTED', 'READY']) {
    assert.doesNotMatch(src, new RegExp(`\\b${gone}\\b`), gone);
  }
});

// The words a fixture is given (tests/lib/work-words.js) are the server's
// own, once the server words its standings (services/work-state.js phrasesOf).
test('the fixtures\' words are the server\'s phrasesOf', (t) => {
  const ws = require('../src/services/work-state');
  if (typeof ws.phrasesOf !== 'function') {
    t.skip('this server does not word its standings yet');
    return;
  }
  const states = [
    { stage: 'reading', line: { code: 'waiting' } }, { stage: 'reading', line: { code: 'queued', place: 2 } },
    { stage: 'building' }, { stage: 'building', line: { code: 'held_builds' } },
    { stage: 'waiting_for_you', why: 'plan' }, { stage: 'waiting_for_you', why: 'decide', line: { code: 'reason', text: 'Why.' } },
    { stage: 'stopped', reason: 'build_failed' }, { stage: 'checking', line: { code: 'checks_failing', failing: 2 } },
    { stage: 'up_for_vote' }, { stage: 'going_live', line: { code: 'github_checks' } }, { stage: 'live' },
    { stage: 'checking', line: { code: 'approved_checking' } }, { stage: 'going_live', line: { code: 'github_wait' } },
    { stage: 'up_for_vote', line: { code: 'earlier_yes', count: 2 } },
  ];
  for (const state of states) {
    const full = { why: null, reason: null, line: null, ...state };
    assert.deepEqual(plain(ws.phrasesOf(full)), plain(wordsOf(full)), JSON.stringify(state));
  }
});

// ── Building never says Review plan ──────────────────────────────────────

test('a request being built never draws Review plan', () => {
  const { needsYou, applyWorkState } = loadTsx(AI);
  const app = { slug: 'garden', name: 'Garden club' };
  const row = (work) => ({ threadId: 1, number: 7, kind: 'work', title: 'Dark mode', app, change: null,
    href: '#app/garden/dev/issues/7', group: 'needs', work, at: null });
  const pill = (work) => needsYou([], { private: [], needs: [row(work)], next: [], waiting: [], live: [] })[0].pill.id;
  assert.equal(pill(standing('waiting_for_you', { why: 'plan' })), 'messages:ai.pill.buildIt', 'a plan waiting for its OK');
  assert.equal(message('messages:ai.pill.buildIt'), 'Review plan');
  // A row the server still lists under Needs you while its standing says it
  // is being built (an older read): never Review plan.
  assert.notEqual(pill(standing('building', { why: 'plan' })), 'messages:ai.pill.buildIt');
  assert.notEqual(pill(standing('building', { line: { code: 'queued' } })), 'messages:ai.pill.buildIt');

  // Its OK'd plan starts building: the push takes the row out of Needs you at once.
  const work = { private: [], needs: [row(standing('waiting_for_you', { why: 'plan' }))], next: [], waiting: [], live: [] };
  const moved = applyWorkState(work, [], push(standing('building', { whoseMove: 'bot' })));
  assert.equal(moved.work.needs.length, 0);
  assert.equal(needsYou([], moved.work).length, 0, 'no Review plan row left');

  // The request's own page: its card, its button and its pill.
  const { av } = appView();
  const built = issue({ standing: standing('building', { whoseMove: 'bot', asks: asks({ plan: { version: 1, sessionId: 9, at: null, waitingGo: false } }) }) });
  const view = plain(av._requestStatusView(built));
  assert.equal(view.lead, 'Building.');
  assert.notEqual(av._issuePrimaryActionSpec(built, { noNav: true })?.label, 'See the plan');
  const { requestPill, threadLayout } = loadTsx(THREAD);
  const layout = threadLayout({ thread: { number: 7 }, items: [{ type: 'request', id: 7, number: 7, status: 'open' }] }, { type: 'request', id: 7 });
  assert.equal(requestPill(layout, built.standing).key, 'building');
});

// ── Settled never says Vote ──────────────────────────────────────────────

test('a live or merged standing never draws Vote', () => {
  const { requestPill, threadLayout } = loadTsx(THREAD);
  const review = { type: 'change', id: 51, number: 8, title: 'A', status: 'promoted', state: 'review', replies: 0, closes: [7] };
  const layout = threadLayout({ thread: { number: 7 }, items: [{ type: 'request', id: 7, number: 7, status: 'open' }, review] }, { type: 'request', id: 7 });
  assert.equal(requestPill(layout, null).key, 'vote', 'the thread alone still lists it as up for a vote');
  assert.equal(requestPill(layout, standing('going_live', { change: change({ status: 'merging', voteOpen: false }) })).key, 'going_live');
  assert.equal(requestPill(layout, standing('live', { change: change({ status: 'merged', voteOpen: false }) })).key, 'live');
  // Approved and held by GitHub: #6594 says Approved while GitHub's checks
  // run, and Going live while GitHub itself holds it; never a vote.
  assert.equal(requestPill(layout, standing('going_live', { line: { code: 'github_checks' }, change: change({ voteOpen: false, githubHold: true }) })).key, 'approved');
  assert.equal(requestPill(layout, standing('going_live', { line: { code: 'github_wait' }, change: change({ voteOpen: false, githubHold: true }) })).key, 'going_live');
  // Its checks failing: not open for votes, so not drawn as up for one.
  assert.equal(requestPill(layout, standing('checking', { line: { code: 'checks_failing' }, change: change({ voteOpen: false }) })), null);

  // The Homeroom bot tab and the feeds: the Vote card leaves with the push.
  const { applyWorkState } = loadTsx(AI);
  const { withoutClosedVote } = loadTsx(LIB);
  const needs = [{ kind: 'proposal', id: 51, title: 'A' }, { kind: 'proposal', id: 52, title: 'B' }, { kind: 'governance', id: 51 }];
  const merged = push(standing('going_live', { change: change({ status: 'merged', voteOpen: false }) }));
  assert.deepEqual(applyWorkState(null, needs, merged).needs.map((n) => `${n.kind}:${n.id}`), ['proposal:52', 'governance:51']);
  assert.deepEqual(withoutClosedVote(needs, merged).map((n) => n.id), [52, 51]);
  const changeRow = push(standing('live', { kind: 'change' }), { kind: 'change', ref: 51, issueNumber: null, sessionId: 51 });
  assert.deepEqual(withoutClosedVote(needs, changeRow).map((n) => n.id), [52, 51], 'a change\'s own row says it too');
  const stillOpen = push(standing('up_for_vote', { change: change() }));
  assert.equal(withoutClosedVote(needs, stillOpen), needs, 'a vote still open keeps its card');
  assert.equal(withoutClosedVote(needs, { type: 'session_update' }), needs);

  // The request's card: Voted in, its words, and the change to look at.
  const { av } = appView();
  const view = plain(av._requestStatusView(issue({
    standing: standing('live', { change: change({ status: 'merged', voteOpen: false }) }),
    addressed_by: { sessionId: 51, state: 'review', prNumber: 8, title: 'A' },
  })));
  assert.equal(view.stage, 'voted');
  assert.equal(view.lead, 'Live.');
  assert.equal(view.action.label, 'See the change');

  // Every screen that draws the feed drops it on the push.
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  assert.match(read('frontend/src/features/workshop/index.tsx'), /const feed = withoutClosedVote\(state\.feed, \(event as CustomEvent\)\.detail\);/);
  assert.match(read('frontend/src/features/home/frame/home-frame.tsx'), /setFeed\(\(now\) => withoutClosedVote\(now, \(event as CustomEvent\)\.detail\)\)/);
  assert.match(read('public/js/app.js'), /new CustomEvent\('homeroom-bot-work-changed', \{ detail: data \}\)/);
});

// ── The card says the standing's words ───────────────────────────────────

test('the request card\'s words are the standing\'s phrase ids', () => {
  const { av } = appView();
  const words = {
    stage: { id: 'core:work.stage.readyToBuild' },
    stageOthers: { id: 'core:work.stage.building' },
    line: { id: 'core:work.line.queuedAt', values: { place: 3 } },
  };
  const s = { kind: 'request', stage: 'building', line: { code: 'queued', place: 3 }, whoseMove: 'bot', words, mine: true };
  const yours = plain(av._requestStatusView(issue({ standing: s })));
  assert.deepEqual(yours.words, { stage: words.stage, line: words.line });
  assert.equal(yours.lead, message('changes:request.status.lead.standsLine', {
    stage: message('core:work.stage.readyToBuild'), line: message('core:work.line.queuedAt', { place: 3 }),
  }));
  const theirs = plain(av._requestStatusView(issue({ standing: { ...s, mine: false } })));
  assert.deepEqual(theirs.words.stage, words.stageOthers, 'anyone else reads anyone else\'s words');
  assert.equal(theirs.lead, 'Building · Number 3 in line');
  // Whatever ids the server sends are the ones said: the card picks none.
  const sent = { ...s, words: { stage: { id: 'core:work.stage.syncing' }, stageOthers: { id: 'core:work.stage.syncing' }, line: null } };
  assert.equal(av._requestStatusView(issue({ standing: sent })).lead, 'Syncing with main.');
  // The dated overrides that worked a sentence out of the row's other fields are gone.
  const src = fs.readFileSync(path.join(ROOT, 'public/js/app-view.js'), 'utf8');
  for (const gone of ['_botWaitingBuildLead', '_requestHoldLead', '_requestWaitingLead', '_requestUpForVoteLead',
    'REQUEST_HOLD_LINE_IDS', 'REQUEST_WAITING_REASON_IDS', 'readingTrack', 'trackWaits']) {
    assert.doesNotMatch(src, new RegExp(`\\b${gone}\\b`), gone);
  }
  // And their sentences with them.
  const changes = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend/locales/en/changes.json'), 'utf8'));
  for (const gone of ['botQueued', 'botHeld', 'botHeldTurn', 'botReading', 'botBuilding', 'upForVote', 'botWaitsPlan', 'waitingDecide']) {
    assert.equal(changes[`request.status.lead.${gone}`], undefined, gone);
  }
});

test('a request up for a vote says how many more yes its change needs, from the vote panel\'s reading', () => {
  const { av } = appView();
  const up = (extra = {}) => issue({
    standing: standing('up_for_vote', { change: change({ votes: { yes: 1, no: 0 } }), ...extra }),
    addressed_by: { sessionId: 51, state: 'review', prNumber: 8, title: 'A' },
  });
  // The vote panel's row is not here yet: the standing's own words.
  assert.equal(av._requestStatusView(up()).lead, `${message('core:work.stage.upForVote')}.`);
  av.voteState = { bySession: { 51: { id: 51 } }, byPrNumber: {} };
  let pill = { yes: 1, majority: 3 };
  av.statusPillState = () => pill;
  assert.equal(av._requestStatusView(up()).lead, message('changes:request.status.lead.upForVoteNeeds', { count: 2 }));
  assert.equal(av._requestStatusView(up()).lead, 'Up for a vote: needs 2 more yes.');
  pill = { yes: 2, majority: 3 };
  assert.equal(av._requestStatusView(up()).lead, 'Up for a vote: needs 1 more yes.');
  pill = { yes: 3, majority: 3 };
  assert.equal(av._requestStatusView(up()).lead, `${message('core:work.stage.upForVote')}.`, 'it has them: nothing more is needed');
  // A second line (a conflict only a yes resolves) keeps the standing's words.
  pill = { yes: 0, majority: 2 };
  const onYes = up({ line: { code: 'conflict_on_yes' } });
  assert.match(av._requestStatusView(onYes).lead, /Conflicts with main/);
  // Checking is not up for a vote: no count.
  assert.equal(av._requestStatusView(issue({ standing: standing('checking', { change: change() }) })).lead, `${message('core:work.stage.checking')}.`);
});

// ── A push is drawn where a screen holds its item ────────────────────────

test('the Homeroom bot tab draws a work_state push on the row it holds, and leaves the rest', () => {
  const { applyWorkState, nextWords } = loadTsx(AI);
  const app = { slug: 'garden', name: 'Garden club' };
  const row = (threadId, number, work, extra = {}) => ({ threadId, number, kind: 'work', title: `T${threadId}`, app, change: null,
    href: `#app/garden/dev/issues/${number}`, group: 'next', work, at: null, ...extra });
  const work = {
    private: [], needs: [],
    next: [row(1, 7, standing('building', { whoseMove: 'bot' }))],
    waiting: [row(2, 8, standing('reading', { line: { code: 'queued' } }), { group: 'waiting' })],
    live: [],
  };
  const moved = applyWorkState(work, null, push(standing('checking', { line: { code: 'checks_running', minutes: 4 }, whoseMove: 'bot' })));
  const words = (p) => message(p.id, { ...p.values, ...Object.fromEntries(Object.entries(p.nested || {}).map(([k, q]) => [k, words(q)])) });
  assert.equal(words(nextWords(moved.work.next[0])), 'Garden club · #7 · Checking · About 4 min left');
  assert.equal(moved.work.waiting[0], work.waiting[0], 'another request\'s row is the same object');
  // Another project's push, or a change's for a request row, changes nothing.
  assert.equal(applyWorkState(work, null, { ...push(standing('live')), appSlug: 'other' }).work, work);
  assert.equal(applyWorkState(work, null, push(standing('live'), { kind: 'change', issueNumber: null })).work, work);
  // The page hands it every push before it reads the lists again.
  const live = fs.readFileSync(path.join(ROOT, 'frontend/src/features/ai/live.ts'), 'utf8');
  assert.match(live, /if \(isWorkStatePush\(event\)\) latest\.current\.apply\?\.\(event\);\s+if \(movesLists\(event, latest\.current\.showing\)\) reads\.ask\(\);/);
});
