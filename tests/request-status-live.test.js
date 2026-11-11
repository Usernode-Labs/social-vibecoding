'use strict';

// #6390 (6 Nov 2026): a request's status card and its Ask button follow the
// same live bot work the track card under it reads.
//
// Seen on request #6389 in the Homeroom bot tab's side column: the bot said
// "I'm on it", the track card switched to "Reading it", and the status card
// above it kept saying "Nobody is working on this yet." with "Ask Homeroom
// bot to build this". Nothing re-read the request's row there, because
// refreshDevData returns at once off the board; and between the reply and
// the run starting the stored track says `reading` before `issue.bot` is
// set, so the card fell through to "nobody".
//
// 11 Nov 2026 (one model): the card draws the request's standing
// (`issue.standing`, services/work-state.js), in the words the server sends
// with it, the words the track card and the Homeroom bot tab say; and a
// work_state push is drawn on it at once.
//
// app-view.js is a plain browser script, loaded into a vm sandbox as
// tests/work-with-bot.test.js loads it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public/js/app-view.js'), 'utf8');

function makeAppView() {
  const fetches = [];
  const renders = [];
  const resyncs = [];
  const listeners = {};
  const sandbox = {
    console,
    relTime: () => ({ text: 'just now', title: '' }),
    App: { user: { id: 42, username: 'me' }, currentApp: null, currentTab: 'homeroom-bot', currentSubTab: 'forum', switchTab: () => {} },
    Kudos: { renderButton: () => '', attach: () => {} },
    UsernodeReact: {
      liveReads: { resync: (reason, url) => { resyncs.push({ reason, url }); } },
    },
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {}, createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    location: { hash: '#homeroom-bot/main', search: '', pathname: '/' },
    URLSearchParams,
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
    },
    PlatformUI: { toast: () => {} },
    fetch: async (url, options) => {
      fetches.push({ url, options });
      return sandbox.answer(url, options);
    },
    answer: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); },
    dispatchEvent: (event) => {
      for (const fn of listeners[event.type] || []) fn(event);
      return true;
    },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  require('./lib/repo-link').installRepoLink(sandbox);
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  AppView._ghIssuesMeta = { myRemaining: 5 };
  AppView._govProposals = [];
  AppView.appData = { slug: 'demo', can_collaborate: true };
  AppView._renderTopicHead = (t) => renders.push(t);
  return { AppView, sandbox, fetches, renders, resyncs, listeners };
}

const baseIssue = (over) => ({
  number: 3, title: 'Dark mode', body: '', htmlUrl: 'https://github.com/o/r/issues/3', state: 'open',
  bounty_count: 0, my_bounty: false, created_by_username: 'me',
  headless: null, in_progress: null, myPrSessionId: null, bot: null, botAwaits: null, botHold: null,
  chatCount: 0, lastMessageAt: null, title_fallback: false, priority: null, assignee: null, category: null,
  track: null,
  ...over,
});
const plain = (x) => JSON.parse(JSON.stringify(x));
// A request's standing as the issue row carries it, in the contract's shape
// (tests/lib/work-words.js gives it the server's words).
const { withWords } = require('./lib/work-words');
const standing = (stage, extra = {}) => withWords({
  kind: 'request', stage, why: null, reason: null, line: null, whoseMove: 'bot', since: null,
  change: null, asks: null, said: null, mine: true, voteOwed: false, ...extra,
});

// The gap the report found: the stored track already said the bot was
// reading the reply while `issue.bot` was still empty. The standing is the
// one thing the card reads now.
const reading = standing('reading', { line: { code: 'reply' } });

test('#6390: a reading standing says the bot is on it, in its own words, with no Ask button', () => {
  const { AppView } = makeAppView();
  // The bot door is open, so a request nothing has happened to offers Ask.
  AppView._ghIssuesMeta = { myRemaining: 5, homeroomBot: { enabled: true } };
  const before = plain(AppView._requestStatusView(baseIssue({ standing: standing('reading', { line: { code: 'waiting' } }) })));
  assert.equal(before.lead, 'Not started yet · Waiting to be read');
  assert.equal(before.action.label, 'Ask Homeroom bot to build this');
  assert.equal(before.botSays, false);
  assert.equal(plain(AppView._requestStatusView(baseIssue())).lead, 'Nobody is working on this yet.', 'a row with no standing at all');

  const status = plain(AppView._requestStatusView(baseIssue({ standing: reading })));
  assert.equal(status.lead, 'Reading it · Reading your reply');
  assert.deepEqual(status.words, { stage: { id: 'core:work.stage.reading' }, line: { id: 'core:work.line.reply' } });
  assert.equal(status.action, null, 'no Ask button once the bot is reading, and no See progress beside its progress card');
  assert.equal(status.botSays, true, 'no "Plan v1 is ready" line under it');
  assert.equal(status.ownAgent, false, 'no "Build it with your own Claude Code" either');
});

test('#6390: someone else\'s bot gets the greyed reading button, never Ask', () => {
  const { AppView } = makeAppView();
  AppView._ghIssuesMeta = { myRemaining: 5, homeroomBot: { enabled: true } };
  const status = plain(AppView._requestStatusView(baseIssue({ standing: standing('reading', { mine: false }) })));
  assert.equal(status.lead, 'Reading it.');
  assert.equal(status.action.label, 'Homeroom bot is reading…');
  assert.equal(status.action.disabled, true);
  // A row from an older server, with only the bot's work, reads the same.
  const legacy = plain(AppView._requestStatusView(baseIssue({ bot: { what: 'reading', since: '2026-11-06T12:13:17Z', askedBy: 'ada' } })));
  assert.equal(legacy.action.label, 'Homeroom bot is reading…');
  assert.equal(legacy.lead, 'Reading it.');
});

test('#6532: a ready build waiting its turn says the server\'s Ready to build, never Building', () => {
  const { AppView } = makeAppView();
  const leadFor = (line, extra) => plain(AppView._requestStatusView(baseIssue({ standing: standing('building', { line, ...extra }) }))).lead;
  assert.equal(leadFor({ code: 'queued', place: 1 }), 'Ready to build · Number 1 in line', 'next in line says so, as the progress card does');
  assert.equal(leadFor({ code: 'held_builds' }), 'Ready to build · Waiting for one of the project\'s builds to finish');
  assert.equal(leadFor({ code: 'held_waiting' }), 'Ready to build · Waiting for changes up for a vote to be decided');
  assert.equal(leadFor(null), 'Building.', 'a build that has really started says so');
  assert.equal(leadFor({ code: 'fixing' }), 'Building · Fixing what its tests found', 'a fix in progress is never a queued build');
  assert.equal(leadFor({ code: 'claimed', by: 'maya' }, { whoseMove: 'builder' }), 'Building · maya is building it');
});

test('#6390: a work event re-reads the request open beside the bot tab', async () => {
  const { AppView, sandbox, fetches, renders, listeners } = makeAppView();
  const stale = baseIssue();
  const fresh = baseIssue({ standing: reading });
  sandbox.answer = async () => ({ ok: true, json: async () => ({ issue: fresh }) });
  AppView._devTopic = { kind: 'issue', id: 3 };
  AppView._devTopicInPanel = true;
  AppView._ghIssues = [stale, baseIssue({ number: 5 })];
  AppView._devDataSlug = 'demo';

  assert.ok(listeners['homeroom-bot-work-changed']?.length, 'the event is wired');
  listeners['homeroom-bot-work-changed'][0](new sandbox.CustomEvent('homeroom-bot-work-changed'));
  const done = AppView._requestRowRefresh?.done;
  assert.ok(done, 'the refresh is in flight');
  await done;

  assert.deepEqual(fetches.map((f) => f.url), ['/api/apps/demo/github-issues/3']);
  assert.equal(AppView._ghIssues[0].standing.stage, 'reading', 'the open row in the board list is replaced');
  assert.equal(AppView._ghIssues[1].number, 5, 'other rows are left alone');
  assert.equal(renders.length, 1, 'the head repaints from the fresh row');
  assert.equal(AppView._requestStatusView(AppView._ghIssues[0]).lead, 'Reading it · Reading your reply');
  assert.equal(AppView._requestStatusView(AppView._ghIssues[0]).action, null, 'no Ask button once the row is re-read');
  // Another work event with nothing new for this request: one GET, no repaint.
  listeners['homeroom-bot-work-changed'][0](new sandbox.CustomEvent('homeroom-bot-work-changed'));
  await AppView._requestRowRefresh.done;
  assert.equal(fetches.length, 2);
  assert.equal(renders.length, 1, 'an unchanged row does not repaint the head');
});

// 11 Nov 2026 (one model): a work_state push carries the request's whole
// standing. The card draws it at once, before any read lands, keeping the
// viewer's own facts; a push for a request the page does not hold, or for
// another project, changes nothing.
test('a work_state push is drawn on the request\'s card at once', async () => {
  const { AppView, sandbox, renders, listeners } = makeAppView();
  sandbox.answer = async () => new Promise(() => {}); // the read never lands
  AppView.appData = { id: 9, slug: 'demo', can_collaborate: true };
  AppView._devTopic = { kind: 'issue', id: 3 };
  AppView._devTopicInPanel = true;
  AppView._ghIssues = [baseIssue({ standing: standing('building', { mine: false, voteOwed: true }) })];
  AppView._devDataSlug = 'demo';
  assert.equal(AppView._requestStatusView(AppView._ghIssues[0]).lead, 'Building.');

  const change = { id: 77, number: 12, status: 'promoted', checks: { state: 'passing', phase: null, failing: null },
    votes: { yes: 1, no: 0 }, voteOpen: true, firstVersion: false, githubHold: false, shotsHeld: false, conflict: false, update: null };
  const push = (state, over = {}) => ({
    type: 'work_state', appId: 9, appSlug: 'demo',
    item: { kind: 'request', ref: 3, issueNumber: 3, sessionId: 77 },
    state: withWords({ stage: 'up_for_vote', why: null, reason: null, line: null, whoseMove: 'group', since: null, change, ...state }),
    ...over,
  });
  listeners['homeroom-bot-work-changed'][0](new sandbox.CustomEvent('homeroom-bot-work-changed', { detail: push({}) }));
  const row = AppView._ghIssues[0];
  assert.equal(row.standing.stage, 'up_for_vote');
  assert.equal(row.standing.mine, false, 'the viewer\'s own facts are kept');
  assert.equal(row.standing.voteOwed, true, 'a vote owed stays owed while it is open');
  assert.equal(renders.length, 1, 'the open request repaints from it');
  const view = plain(AppView._requestStatusView(row));
  assert.equal(view.lead, 'Up for a vote.');
  assert.equal(view.stage, 'built');

  // It merged: going live, and nothing owed any more.
  listeners['homeroom-bot-work-changed'][0](new sandbox.CustomEvent('homeroom-bot-work-changed', {
    detail: push({ stage: 'going_live', whoseMove: null, change: { ...change, status: 'merged', voteOpen: false } }),
  }));
  assert.equal(row.standing.voteOwed, false);
  const live = plain(AppView._requestStatusView(row));
  assert.equal(live.stage, 'voted');
  assert.equal(live.lead, 'Going live.');

  // Another project's push, or another request's, is left alone.
  const before = JSON.stringify(row.standing);
  listeners['homeroom-bot-work-changed'][0](new sandbox.CustomEvent('homeroom-bot-work-changed', {
    detail: push({ stage: 'building' }, { appId: 10, appSlug: 'other' }),
  }));
  listeners['homeroom-bot-work-changed'][0](new sandbox.CustomEvent('homeroom-bot-work-changed', {
    detail: push({ stage: 'building' }, { item: { kind: 'request', ref: 4, issueNumber: 4, sessionId: null } }),
  }));
  assert.equal(JSON.stringify(row.standing), before);
  assert.equal(renders.length, 2);
});

test('#6390: nothing is fetched when no request page or panel is open', async () => {
  const { AppView, sandbox, fetches } = makeAppView();
  sandbox.answer = async () => ({ ok: true, json: async () => ({ issue: baseIssue() }) });
  AppView._devTopic = null;
  AppView._devTopicInPanel = false;
  assert.equal(await AppView._refreshOpenRequestRow(), false);
  // A proposal's page is not a request row.
  AppView._devTopic = { kind: 'proposal', id: 9 };
  assert.equal(await AppView._refreshOpenRequestRow(), false);
  // A request the panel has closed no longer refreshes.
  AppView._devTopic = { kind: 'issue', id: 3 };
  AppView._devTopicInPanel = false;
  sandbox.App.currentTab = 'homeroom-bot';
  assert.equal(await AppView._refreshOpenRequestRow(), false);
  assert.deepEqual(fetches, []);
});

test('#6390: a burst of work events is one fetch, with one more queued behind it', async () => {
  const { AppView, sandbox, fetches } = makeAppView();
  const pending = [];
  sandbox.answer = async () => new Promise((resolve) => {
    pending.push(() => resolve({ ok: true, json: async () => ({ issue: baseIssue({ standing: reading }) }) }));
  });
  AppView._devTopic = { kind: 'issue', id: 3 };
  AppView._devTopicInPanel = true;
  AppView._ghIssues = [baseIssue()];
  AppView._devDataSlug = 'demo';
  const first = AppView._refreshOpenRequestRow();
  AppView._refreshOpenRequestRow();
  AppView._refreshOpenRequestRow();
  assert.equal(fetches.length, 1, 'one fetch in flight');
  pending.shift()();
  await new Promise((r) => setImmediate(r));
  assert.equal(fetches.length, 2, 'the burst asked for one more read, not one per event');
  pending.shift()();
  await first;
  assert.equal(fetches.length, 2);
});

// #6595: the request open in the side panel (or the Homeroom bot tab's
// column) re-reads itself when a live burst about its project arrives. On
// that screen App.currentApp is null, so the dev refresh returns at once;
// the burst's own project slug is what routes it.
test('#6595: an issue update for a project that is not App.currentApp refreshes the open side-panel request', async () => {
  const { AppView, sandbox, fetches, renders, resyncs } = makeAppView();
  AppView.appData = { slug: 'other', can_collaborate: true };
  sandbox.App.currentApp = null;
  sandbox.App.currentTab = 'homeroom-bot';
  const stale = baseIssue({ number: 6580 });
  const fresh = baseIssue({
    number: 6580,
    in_progress: { count: 1, users: [], mine: false, claims: [] },
  });
  sandbox.answer = async () => ({ ok: true, json: async () => ({ issue: fresh }) });
  AppView._devTopic = { kind: 'issue', id: 6580 };
  AppView._devTopicInPanel = true;
  AppView._ghIssues = [stale];
  AppView._devDataSlug = 'other';

  const shown = AppView.refreshShownTopic({
    slugs: new Set(['other']), kinds: new Set(['issue']),
    ids: new Set(), numbers: new Set(), unnamed: true, devRead: false,
  });
  assert.equal(shown, true, 'the burst reached what is shown');
  await AppView._requestRowRefresh.done;
  assert.deepEqual(fetches.map((f) => f.url), ['/api/apps/other/github-issues/6580'], 'the panel read its own row');
  assert.deepEqual(resyncs, [{ reason: 'thread', url: '/api/apps/other/threads/6580' }],
    'and the thread that draws the vote card');
  assert.equal(renders.length, 1, 'the head repaints from the fresh row');
});

test('#6595: an update that did not move the request repaints nothing', async () => {
  const { AppView, sandbox, fetches, renders, resyncs } = makeAppView();
  AppView.appData = { slug: 'other', can_collaborate: true };
  sandbox.App.currentApp = null;
  const row = baseIssue({ number: 6580 });
  sandbox.answer = async () => ({ ok: true, json: async () => ({ issue: plain(row) }) });
  AppView._devTopic = { kind: 'issue', id: 6580 };
  AppView._devTopicInPanel = true;
  AppView._ghIssues = [row];
  AppView._devDataSlug = 'other';

  AppView.refreshShownTopic({
    slugs: new Set(['other']), kinds: new Set(['issue']),
    ids: new Set(), numbers: new Set(), unnamed: true, devRead: false,
  });
  await AppView._requestRowRefresh.done;
  assert.equal(fetches.length, 1, 'one GET');
  assert.equal(renders.length, 0, 'the equal row is not painted again');
  assert.deepEqual(resyncs, [{ reason: 'thread', url: '/api/apps/other/threads/6580' }],
    'the thread still re-reads: a vote card is not in the row');
});

test('#6595: a burst about another project, or naming another request, reads nothing', async () => {
  const { AppView, sandbox, fetches, resyncs } = makeAppView();
  AppView.appData = { slug: 'other', can_collaborate: true };
  sandbox.App.currentApp = null;
  AppView._devTopic = { kind: 'issue', id: 6580 };
  AppView._devTopicInPanel = true;

  assert.equal(AppView.refreshShownTopic({
    slugs: new Set(['elsewhere']), kinds: new Set(['issue']),
    ids: new Set(), numbers: new Set(), unnamed: true, devRead: false,
  }), false, 'another project is not what is shown');
  assert.equal(AppView.refreshShownTopic({
    slugs: new Set(['other']), kinds: new Set(['issue']),
    ids: new Set(), numbers: new Set([12]), unnamed: false, devRead: false,
  }), false, 'a named, different request is skipped');
  // Nothing is open, so the same burst still reads nothing.
  AppView._devTopic = null;
  assert.equal(AppView.refreshShownTopic({
    slugs: new Set(['other']), kinds: new Set(['issue']),
    ids: new Set(), numbers: new Set(), unnamed: true, devRead: false,
  }), false);
  assert.deepEqual(fetches, []);
  assert.deepEqual(resyncs, []);
});

test('#6595: a change open in the panel tells its page and re-reads its thread', () => {
  const { AppView, sandbox, resyncs } = makeAppView();
  AppView.appData = { slug: 'other', can_collaborate: true };
  sandbox.App.currentApp = null;
  AppView._devTopic = { kind: 'proposal', id: 9 };
  AppView._devTopicInPanel = true;
  const told = [];
  AppView._tellChangePage = (detail) => told.push(detail);

  const shown = AppView.refreshShownTopic({
    slugs: new Set(['other']), kinds: new Set(['vote']),
    ids: new Set(), numbers: new Set(), unnamed: true, devRead: false,
  });
  assert.equal(shown, true);
  assert.deepEqual(told, [9], 'the flush named no change, so its page is told here');
  assert.deepEqual(resyncs, [{ reason: 'thread', url: '/api/apps/other/threads/change/9' }]);

  // When the burst named it, the flush has already told its page.
  told.length = 0;
  AppView.refreshShownTopic({
    slugs: new Set(['other']), kinds: new Set(['vote']),
    ids: new Set([9]), numbers: new Set(), unnamed: false, devRead: false,
  });
  assert.deepEqual(told, [], 'told once, not twice');
  assert.deepEqual(resyncs, [
    { reason: 'thread', url: '/api/apps/other/threads/change/9' },
    { reason: 'thread', url: '/api/apps/other/threads/change/9' },
  ]);
});

test('#6595: the topic sub-view leaves the row to the dev refresh it already made', async () => {
  const { AppView, sandbox, fetches, resyncs } = makeAppView();
  AppView.appData = { slug: 'other', can_collaborate: true };
  sandbox.App.currentApp = 'other';
  sandbox.App.currentTab = 'dev';
  sandbox.App.currentSubTab = 'topic';
  AppView._devTopic = { kind: 'issue', id: 6580 };
  AppView._devTopicInPanel = false;

  AppView.refreshShownTopic({
    slugs: new Set(['other']), kinds: new Set(['issue']),
    ids: new Set(), numbers: new Set(), unnamed: true, devRead: true,
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(fetches, [], 'refreshDevData already re-read the row');
  assert.deepEqual(resyncs, [{ reason: 'thread', url: '/api/apps/other/threads/6580' }],
    'but the thread read is still this entry\'s');
});
