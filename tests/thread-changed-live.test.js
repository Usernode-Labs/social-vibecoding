'use strict';

// #6231: a request's page shows its new change the moment it is proposed.
//
// A request's page reads its thread once (frontend/src/features/dev-board/
// topic/thread-items.tsx `useThreadPayload`) and those reads were repeated
// only after a gap (frontend/src/lib/live-reads.ts). A build that becomes a
// proposal is new to the thread and was announced by no event the page
// listens to, so the change's section, the pill, the status line and the
// track card stayed stale until a reload.
//
// This pins the seam:
//   1. src/workflow/pushes.ts `threadChanged`: one scoped event, the linked
//      requests plus the change's pull request, deduplicated.
//   2. The proposal machine's moves (promote, unpromote, archive), the
//      merged settle and the preview machine's checks start and verdict
//      carry it; a progress tick does not.
//   3. public/js/app.js turns the frame into `liveReads.resync('thread')`
//      for the thread read and the change's own address.
//   4. `threadReads` + the real live-reads module: the event re-reads
//      `useThreadPayload`, for its own path and for a change it lists, and
//      not for another request's.
//   5. The status line: the page's review state wins over a stale bot state.
//
// Run with: node --test tests/thread-changed-live.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HEAD = 'a'.repeat(40);
const TOPIC = 'frontend/src/features/dev-board/topic';

const { threadChanged } = require('../src/workflow/pushes.ts');
const { proposal } = require('../src/workflow/proposal/machine.ts');
const { preview } = require('../src/workflow/preview/machine.ts');
const { mergeFollowups } = require('../src/workflow/merge-followups/machine.ts');

const threadEvents = (out) => (out.push || []).filter((p) => p && p.data && p.data.type === 'thread_changed');

test('threadChanged: one scoped event naming the requests and the change, deduplicated', () => {
  const push = threadChanged({ appId: 1, appSlug: 'demo', sessionId: 42, numbers: [11, 11, null, 0, 26] });
  assert.deepEqual(JSON.parse(JSON.stringify(push)), {
    kind: 'scoped',
    routing: { appId: 1, appSlug: 'demo' },
    data: { type: 'thread_changed', appId: 1, appSlug: 'demo', sessionId: 42, numbers: [11, 26] },
  });
});

// ── The machines ───────────────────────────────────────────────────────

const row = (over = {}) => ({
  id: 5, appId: 1, appSlug: 'demo', selfHosted: false, repo: null, userId: 7, ownerName: 'tester',
  ownerSynthetic: false, status: 'promoted', imported: false, headless: false, prNumber: 26, prTitle: 'Bigger buttons',
  branch: 'dev/tester', head: HEAD, reviewedHead: null, importedHead: null, epoch: 0, promotedAt: null,
  createdAt: '2026-10-01T00:00:00Z', staleNotifiedAt: null, lastActivityAt: null, linkedIssues: [11],
  agentSessionId: null, explicitApproval: false, explicitReason: null, mergeAttemptAt: null, shots: false,
  fixture: false, activeTurn: false, workedOn: false, moving: false, shotsRunning: false, buildHold: false,
  pendingSecret: false, ...over,
});

const live = (name, over = {}) => ({
  name,
  data: {
    sessionId: 5, appId: 1, imported: false, slot: 'none', promoting: null, answer: null,
    reason: name === 'closed' ? 'manual' : null, claim: null, pr: { running: null, next: [] }, doomed: [], n: 3, ...over,
  },
});

const ctx = { now: new Date('2026-11-03T10:00:00Z'), key: 'session:5', version: 0 };
const proposalMachine = proposal({ idleMs: 0, exemptFixtures: false, reviewCheckMs: 60 * 60 * 1000, staleNotifyMs: 0, staleGraceMs: 0, retentionMs: 0 });

function run(machine, state, type, payload, facts, context = ctx) {
  const event = { id: 99, type, payload: { sessionId: 5, ...payload }, source: { kind: 'route', name: 'test' } };
  const from = state || { name: '(none)', data: {} };
  const entry = machine.entryFor(from.name, type);
  assert.strictEqual(entry.guard(from, event, facts, context), true, `${type} from ${from.name} is allowed`);
  return entry.to(from, event, facts, context);
}

test('the proposal machine: promote, unpromote and archive each announce the thread', () => {
  const facts = { row: row({ status: 'active', prNumber: null, linkedIssues: [11] }), electorate: { active: 1, majority: 1 } };
  const promoted = run(proposalMachine, live('underway'), 'Promote',
    { from: 'active', userId: 7, username: 'ada', expectedHead: HEAD }, facts);
  assert.equal(promoted.next.name, 'proposing');
  const opened = run(proposalMachine, promoted.next, 'WorkSucceeded',
    { kind: 'review.open', workKey: `open:${promoted.next.data.promoting.n}`, result: { prNumber: 26, prTitle: 'T', prUrl: 'u', head: HEAD } }, facts);
  assert.equal(opened.next.name, 'in_review');
  assert.deepEqual(threadEvents(opened)[0].data.numbers, [11], 'the request it answers, and its own pull request when it has one');
  assert.equal(threadEvents(opened)[0].data.sessionId, 5);

  const back = run(proposalMachine, live('in_review'), 'Unpromote', { from: 'promoted', userId: 7, username: 'ada' }, { row: row() });
  assert.equal(back.next.name, 'underway');
  assert.deepEqual(threadEvents(back)[0].data.numbers, [11, 26], 'moved back to underway');

  const archived = run(proposalMachine, live('in_review'), 'Close', { from: 'promoted', reason: 'manual', userId: null }, { row: row() });
  assert.equal(archived.next.name, 'closed');
  assert.deepEqual(threadEvents(archived)[0].data.numbers, [11, 26], 'withdrawn');
});

test('the merged settle announces every request the change closes', () => {
  const machine = mergeFollowups({});
  const facts = {
    session: { id: 5, appId: 1, userId: 7, status: 'promoted', prNumber: 26, prTitle: 'T', linkedIssues: [11, 12], agentSessionId: null, staging: null },
    app: { id: 1, slug: 'demo', repo: { owner: 'o', name: 'r' }, selfHosted: false, demoMode: false, booted: [] },
  };
  const out = run(machine, null, 'Merged',
    { mergeSha: HEAD, mergedAt: '2026-11-03T10:00:00Z', force: false, forcedBy: null, tally: null, observedBy: 'merge' }, facts);
  assert.deepEqual(threadEvents(out)[0].data.numbers, [11, 12, 26]);
  assert.equal(threadEvents(out)[0].data.sessionId, 5);
});

test('the preview machine: a checks run starting or settling announces it by id', () => {
  const machine = preview({ idleMs: 0, reviewCheckMs: 0, retentionMs: 0, maxRetries: 3 });
  const facts = {
    session: { id: 5, appId: 1, status: 'promoted', checks: { commitSha: HEAD, state: 'passing' }, pin: HEAD },
    app: { id: 1, slug: 'demo' },
  };
  const served = {
    sessionId: 5, appId: 1, appSlug: 'demo', userId: 7, seed: 1, head: HEAD, trigger: null, last: 1,
    preparing: null, serving: { n: 1, head: HEAD, runtimeKind: 'docker', runtimeName: 'r', url: 'u' },
    run: null, verdict: 'passing', failure: null, platformFault: false, streak: 0, firstFailureAt: null,
    episode: 0, retiring: [], exit: null, pending: null, closedAt: null, operations: [],
  };
  const start = run(machine, { name: 'settled', data: served }, 'RecheckRequested',
    { reason: 'manual', trigger: 'manual-recheck' }, facts);
  assert.equal(start.next.name, 'checking');
  assert.deepEqual(threadEvents(start)[0].data.numbers, []);
  assert.equal(threadEvents(start)[0].data.sessionId, 5, 'the change it names is the id');

  const verdict = run(machine, { name: 'settled', data: { ...served, serving: null } }, 'ChecksSkipped',
    { reason: 'nothing', head: HEAD }, facts);
  assert.equal(verdict.next.name, 'settled');
  assert.deepEqual(threadEvents(verdict)[0].data.numbers, []);
  assert.equal(threadEvents(verdict)[0].data.sessionId, 5);
});

// ── The client ─────────────────────────────────────────────────────────

test('app.js turns a thread_changed frame into a re-read of each thread and of the change', () => {
  const noop = () => {};
  const c = {
    console: { log: noop, warn: noop, error: noop, debug: noop, info: noop },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, URL, URLSearchParams,
    location: { search: '', hash: '', pathname: '/', href: 'http://localhost/' },
    history: { replaceState: noop, pushState: noop },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    navigator: { userAgent: 'node' },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    WebSocket: function WebSocketStub() {},
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s), escapeAttr: (s) => String(s == null ? '' : s),
    document: {
      hidden: false, visibilityState: 'visible', getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => [], addEventListener: noop, removeEventListener: noop, createElement: () => ({}),
      body: {}, documentElement: { classList: { contains: () => false } },
    },
    addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    PlatformI18n: englishPlatformI18n(), PlatformUI: { toast: noop }, DevChat: {}, Home: {},
    UsernodeReact: {},
  };
  c.window = c;
  c.globalThis = c;
  vm.createContext(c);
  vm.runInContext(read('public/js/app.js'), c, { filename: 'app.js' });
  const App = vm.runInContext('App', c);
  const calls = [];
  c.UsernodeReact.liveReads = { resync: (reason, url) => calls.push([reason, url]) };

  App.handleThreadChanged({ type: 'thread_changed', appSlug: 'demo', sessionId: 42, numbers: [11, 12, 0] });
  assert.deepEqual(calls, [
    ['thread', '/api/apps/demo/threads/11'],
    ['thread', '/api/apps/demo/threads/12'],
    ['thread', '/api/apps/demo/threads/change/42'],
  ]);
  assert.match(read('public/js/app.js'), /case 'thread_changed':\s+App\.handleThreadChanged\(data\);/, 'the socket calls it');
  assert.match(read('frontend/src/lib/live-reads.ts'), /'thread'/, 'the seam knows the reason');
});

// ── The page's re-read ─────────────────────────────────────────────────

// A React small enough to step through: the suite has no DOM (see
// tests/thread-one-page.test.js).
function steppedReact() {
  const slots = [];
  let cursor = 0;
  let dirty = false;
  const slot = (init) => { const i = cursor++; if (!(i in slots)) slots[i] = init(); return slots[i]; };
  const react = {
    ...require('../frontend/node_modules/react'),
    useRef: (current) => slot(() => ({ current })),
    useState: (initial) => {
      const s = slot(() => ({ value: initial }));
      return [s.value, (next) => { s.value = typeof next === 'function' ? next(s.value) : next; dirty = true; }];
    },
    useEffect: (effect, deps) => {
      const s = slot(() => ({ deps: null, cleanup: null }));
      if (s.deps && deps.every((v, i) => Object.is(v, s.deps[i]))) return;
      s.deps = deps;
      if (s.cleanup) s.cleanup();
      s.cleanup = effect();
    },
  };
  return {
    react,
    async draw(fn) {
      let out;
      do {
        dirty = false;
        cursor = 0;
        out = fn();
        await new Promise((resolve) => { setImmediate(resolve); });
      } while (dirty);
      return out;
    },
  };
}

test('threadReads owns its thread and the changes it lists, and nothing else', () => {
  const { threadReads } = loadTsx(`${TOPIC}/thread-items.tsx`);
  const ids = new Set([51, 52]);
  const owns = threadReads('/api/apps/club/threads/10', 'club', ids);
  assert.equal(owns(new URL('https://h.test/api/apps/club/threads/10')), true, 'its own thread');
  assert.equal(owns(new URL('https://h.test/api/apps/club/threads/change/51')), true, 'a change it lists');
  assert.equal(owns(new URL('https://h.test/api/apps/club/threads/change/99')), false, 'a change it does not list');
  assert.equal(owns(new URL('https://h.test/api/apps/club/threads/11')), false, 'another request');
  assert.equal(owns(new URL('https://h.test/api/apps/other/threads/10')), false, 'another project with the same number');
});

test('a thread_changed event makes useThreadPayload read its thread again', async () => {
  const live = loadTsx('frontend/src/lib/live-reads.ts');
  live._resetLiveReads();
  const { react, draw } = steppedReact();
  const { useThreadPayload } = loadTsx(`${TOPIC}/thread-items.tsx`, {
    stubs: { react, '../../../lib/live-reads': live },
  });
  const calls = [];
  let answer = { ok: true, json: async () => ({ items: [{ id: 51, type: 'change' }] }) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (p, init) => { calls.push({ path: p, init }); return answer; };
  try {
    let out = await draw(() => useThreadPayload('club', 10));
    assert.deepEqual(out.data.items, [{ id: 51, type: 'change' }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.cache, undefined, 'the first read takes the saved copy');

    live.resync('thread', '/api/apps/club/threads/change/51');
    live.flush();
    out = await draw(() => useThreadPayload('club', 10));
    assert.equal(calls.length, 2, 'a change it lists re-reads its thread');
    assert.equal(calls[1].init.cache, 'no-cache', 'past the saved copy');

    live.resync('thread', '/api/apps/club/threads/change/99');
    live.flush();
    out = await draw(() => useThreadPayload('club', 10));
    assert.equal(calls.length, 2, 'a change it does not list changes nothing');

    live.resync('thread', '/api/apps/club/threads/10');
    live.flush();
    out = await draw(() => useThreadPayload('club', 10));
    assert.equal(calls.length, 3, 'its own thread reads again');
  } finally {
    globalThis.fetch = realFetch;
    live._resetLiveReads();
  }
});

// ── The page and its status line ───────────────────────────────────────

const requestView = (status = {}) => ({
  number: 4417, category: 'Communities & projects', menuKey: 'request:4417', asker: 'evan',
  askedAt: '2026-10-08T14:01:11Z', askedTime: '04:01 PM', askedTitle: 'Oct 8, 2026, 04:01 PM',
  title: 'Add topics as discussion containers', titleEditing: null,
  bodyHtml: '<div class="dev-issue-body"><p>Consider topics.</p></div>',
  editor: { issue: 4417, markdown: 'Consider topics.', source: null, canEdit: false },
  status: {
    stage: 'built', lead: 'Homeroom bot is building this.', note: 'A change for it is waiting for approval.',
    fine: null, action: null, closed: null, ...status,
  },
});

const THREAD = {
  thread: { id: 3, number: 4417, kind: 'work', lead: 'request', title: null, state: 'open' },
  items: [{ type: 'change', id: 51, number: 12, title: 'Bigger buttons', status: 'promoted', state: 'review', replies: 0 }],
  follow: null,
};

test('a request whose change is up for a vote shows the change section, not the track card', () => {
  const mod = loadTsx(`${TOPIC}/request-head.tsx`, {
    stubs: {
      './thread-items': {
        useThreadPayload: () => ({ data: THREAD, setData: () => {}, reread: () => {} }),
        ThreadItems: () => null,
        pageSlug: () => 'demo',
      },
    },
  });
  const html = renderToHtml(createElement(mod.RequestHead, {
    r: { ...requestView(), track: { state: 'building', phase: 'preview', steps: [], startedAt: '2026-11-03T09:00:00Z' } },
  }));
  assert.match(html, /data-thread-change="51" data-thread-change-state="review"/, 'the change section is there');
  assert.doesNotMatch(html, /dev-request-status/, 'no status line beside the change section');
  assert.doesNotMatch(html, /dev-request-track/, 'no Building card');

  // The pill the bar carries is the same read's (`requestPill`).
  const { requestPill, threadLayout } = loadTsx(`${TOPIC}/thread-model.ts`);
  const pill = requestPill(threadLayout(THREAD, { type: 'request', id: 4417 }), null, (id) => id);
  assert.equal(pill.key, 'vote', 'Up for a vote');
});

function appView() {
  const noop = () => {};
  const c = {
    console, App: { user: { id: 42, username: 'evan' }, currentApp: 'example', currentTab: 'dev' },
    relTime: () => 'just now',
    document: { getElementById: () => null, querySelector: () => null, addEventListener: noop },
    localStorage: { getItem: () => null }, addEventListener: noop, dispatchEvent: noop,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '' }, URLSearchParams,
  };
  c.window = c;
  c.PlatformI18n = englishPlatformI18n();
  vm.createContext(c);
  vm.runInContext(read('public/js/app-view.js'), c);
  vm.runInContext('globalThis.av = AppView', c);
  c.av.appData = { slug: 'example', can_collaborate: true };
  c.av._govProposals = [];
  return c.av;
}

test('the status line follows the change section: a review wins over a stale bot state', () => {
  const av = appView();
  const issue = {
    number: 6227, state: 'open', title: 'Show the reason beside each challenge credit', created_by_username: 'evan',
    body: 'Each credit should say why it was given.', createdAt: '2026-11-03T16:52:00Z', bounty_count: 0, chatCount: 0,
    in_progress: null, category: { top: null }, priority: { top: null }, assignee: { top: null },
    bot: { what: 'building', since: '2026-11-03T16:00:00Z' },
    addressed_by: { sessionId: 9, state: 'review', prNumber: 12, title: 'A reason under each credit' },
  };
  const view = av._requestStatusView(issue);
  assert.equal(view.lead, 'Up for a vote.');
  assert.equal(view.note, null, 'no "waiting for approval" beside it');
  assert.equal(view.stage, 'built');
});
