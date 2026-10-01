// Live refresh of the Challenges tab (issue #3569).
//
// WHAT THIS PINS. While the Challenges tab is showing, a short interval
// re-reads the same public challenges endpoint `loadChallenges()` uses and
// republishes the grid through the descriptor-only path, so the viewer's
// own progress — the First challenges cards, the group headers, the season
// line and the locked placeholder — moves in place instead of waiting for
// the next visit. The refresh must not flash the grid (no loading state,
// no clearing), must not touch a failed first load's error state, and must
// stand down while the browser tab is hidden, while the challenge detail
// page or a profile overlay is open over the grid, and while a refresh or
// the first load is in flight. An answer that arrives after the viewer
// switched events is discarded.
//
// The real controller runs in a vm with a stub store, a stub fetch, stub
// timers and a stub document, as in tests/challenge-groups.test.js.
//
// Run with: node --test tests/challenge-live-refresh.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const SRC = fs.readFileSync(
  path.join(root, 'frontend/src/features/leaderboard/topochain-challenges.js'),
  'utf8'
);

// A pane over a fixed challenge list, with the event bar stubbed to the
// real one's contract, a controllable fetch and recording timers. Calls
// land in `calls` in order; the challenges answer is whatever
// `challengesAnswer` is at the moment the fetch runs.
function loadPane({
  challenges = [],
  eventId = 10,
  onboarding = null,
  mine = [],
  challengesAnswer = null,
  hidden = false,
} = {}) {
  const subs = [];
  const context = {
    eventId,
    select(id) {
      if (id == null || id === context.eventId) return;
      context.eventId = id;
      context.notify();
    },
    onChange(fn) { subs.push(fn); return () => {}; },
    notify() { for (const fn of subs) fn(context.eventId); },
  };
  const calls = [];
  const timers = { intervals: [], cleared: [], nextId: 1 };
  const sandbox = {
    window: { TopochainEventContext: context },
    TopochainEventContext: context,
    console,
    setTimeout,
    clearTimeout,
    setInterval(fn, ms) {
      const id = timers.nextId++;
      timers.intervals.push({ id, fn, ms });
      return id;
    },
    clearInterval(id) {
      timers.cleared.push(id);
      const at = timers.intervals.findIndex((t) => t.id === id);
      if (at !== -1) timers.intervals.splice(at, 1);
    },
    document: { hidden },
    location: { hash: '', search: '' },
    URLSearchParams,
    fetch(url) {
      calls.push(String(url));
      if (String(url).includes('/challenges-api/')) {
        return Promise.resolve(jsonRes({ success: true, data: mine }));
      }
      if (challengesAnswer) return Promise.resolve(challengesAnswer);
      return new Promise(() => {});
    },
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'topochain-challenges.js' });

  const pane = sandbox.window.TopochainChallenges;
  const state = { mounted: true, grid: null, detail: null, profile: null };
  const store = { get: () => state, set: (patch) => Object.assign(state, patch) };
  pane._store = store;
  pane._open = false;
  pane._challenges = challenges;
  pane._challengesLoading = false;
  pane._loadedEventId = eventId;
  pane._onboarding = onboarding;
  // open() schedules the interval; stub its first load so the harness's
  // fixture rows stay in place (a real first load would clear them while
  // its fetch never settles).
  const realLoadChallenges = pane.loadChallenges;
  pane.loadChallenges = () => {};
  pane.open();
  pane.loadChallenges = realLoadChallenges;
  // Exposed for the tests: the call log, the event bar, the document's
  // hidden flag. (`__answer` exists for symmetry with the other probes;
  // each test that needs a different answer passes it via `loadPane`.)
  pane.__calls = calls;
  pane.__context = context;
  pane.__hidden = (v) => { sandbox.document.hidden = v; };
  pane.__answer = (r) => { challengesAnswer = r; };
  return { pane, store, context, timers, calls };
}

const jsonRes = (payload, ok = true) => ({
  ok,
  status: ok ? 200 : 500,
  headers: { get: () => 'application/json' },
  json: async () => payload,
});

const ch = (id, label, extra = {}) => ({
  id,
  card_preview: { label, goal: `Challenge ${id}` },
  ...extra,
});

const setupPayload = (challenges, onboarding) => ({
  success: true,
  data: challenges,
  onboarding,
});

const LOCKED = {
  total: 3, completed: 0, unlocked: false, hidden_count: 5, event_id: 10,
};
const UNLOCKED = {
  total: 3, completed: 1, unlocked: true, hidden_count: 0, event_id: 10,
};

// ─── The timer's lifecycle ───────────────────────────────────────────────

test('open() schedules the refresh interval and close() clears it', () => {
  const { pane, timers } = loadPane();
  assert.equal(timers.intervals.length, 1, 'one interval while the pane is open');
  assert.equal(timers.intervals[0].ms, 15000, 'about every 15 seconds');
  const id = timers.intervals[0].id;
  assert.equal(pane._liveTimer, id);
  pane.close();
  assert.deepEqual(timers.cleared, [id], 'close() clears the interval');
  assert.equal(pane._liveTimer, null);
  assert.equal(timers.intervals.length, 0, 'and the handle list shows it gone');
});

test('open() never stacks a second interval', () => {
  const { pane, timers } = loadPane();
  const realLoadChallenges = pane.loadChallenges;
  pane.loadChallenges = () => {};
  pane.open(); // open() again, without a close in between
  pane.open();
  pane.loadChallenges = realLoadChallenges;
  assert.equal(timers.intervals.length, 1, 'one interval while the pane is open');
  assert.equal(timers.intervals[0].ms, 15000);
});

test('close() stops a tick that is mid-flight from publishing', async () => {
  const { pane, store, timers } = loadPane({
    challenges: [ch(1, 'ONBOARDING'), ch(2, 'WEEKLY')],
    onboarding: LOCKED,
    challengesAnswer: jsonRes(setupPayload([ch(1, 'ONBOARDING', { progress: { done: true, current: 1, target: 1 } }), ch(2, 'WEEKLY')], UNLOCKED)),
  });
  pane._renderGrid();
  const before = JSON.stringify(store.get().grid);
  const tick = timers.intervals[0].fn;
  pane.close(); // close() ran while the fetch was in the air
  await tick();
  assert.equal(JSON.stringify(store.get().grid), before,
    'a closed pane discards the answer, as loadChallenges() does');
});

// ─── The guards ──────────────────────────────────────────────────────────

test('a tick fetches nothing while hidden, an overlay is up, a refresh is in flight or the first load is', async () => {
  const { pane, timers, calls } = loadPane({
    challengesAnswer: jsonRes(setupPayload([], null)),
  });
  const tick = timers.intervals[0].fn;

  pane.__hidden(true);
  await tick();
  assert.equal(calls.length, 0, 'hidden browser tab: no fetch');
  pane.__hidden(false);

  pane._detailChallenge = ch(1, 'ONBOARDING');
  await tick();
  assert.equal(calls.length, 0, 'detail page open: no fetch');
  pane._detailChallenge = null;

  pane._profileUserId = 'u1';
  await tick();
  assert.equal(calls.length, 0, 'profile overlay open: no fetch');
  pane._profileUserId = null;

  pane._refreshing = true;
  await tick();
  assert.equal(calls.length, 0, 'refresh in flight: no fetch');
  pane._refreshing = false;

  pane._challengesLoading = true;
  await tick();
  assert.equal(calls.length, 0, 'first load in flight: no fetch');
  pane._challengesLoading = false;

  await tick();
  assert.equal(calls.length, 1, 'otherwise the tick fetches');
  assert.match(calls[0], /\/api\/v4\/season-events\/10\/challenges$/);
});

test('a tick fetches nothing when the pane is closed or has no event', async () => {
  const { pane, timers, calls } = loadPane();
  const tick = timers.intervals[0].fn;

  pane._open = false;
  await tick();
  assert.equal(calls.length, 0, 'closed: no fetch');
  pane._open = true;

  pane.__context.eventId = null;
  await tick();
  assert.equal(calls.length, 0, 'no event selected: no fetch');
});

// ─── What a successful tick paints ──────────────────────────────────────

test('a successful tick moves the cards, the header, the season line and the locked placeholder in place', async () => {
  const first = [ch(1, 'ONBOARDING'), ch(2, 'WEEKLY')];
  const later = [
    ch(1, 'ONBOARDING', { progress: { done: true, current: 1, target: 1 } }),
    ch(2, 'WEEKLY'),
  ];
  const { pane, store, timers } = loadPane({
    challenges: first,
    onboarding: LOCKED,
    challengesAnswer: jsonRes(setupPayload(later, UNLOCKED)),
  });
  pane._renderGrid();
  const before = store.get().grid;
  assert.equal(before.lockedCount, 5, 'the board starts locked');
  assert.match(before.progress.caption, /First challenges/);
  const setupBefore = before.groups.find((g) => g.key === 'setup');
  assert.equal(setupBefore.meta, '0/1', 'the header starts unfinished');

  await timers.intervals[0].fn();
  const after = store.get().grid;
  assert.equal(after.kind, 'cards', 'no loading state ever replaced the grid');
  assert.equal(after.lockedCount, undefined, 'the lock is gone');
  assert.equal(after.notice, undefined);
  assert.equal(after.progress.caption.includes('First challenges'), false,
    'the season line now reads the whole event');
  const setupAfter = after.groups.find((g) => g.key === 'setup');
  assert.equal(setupAfter.meta, '1/1 done', 'the header now counts the finished group');
  assert.equal(setupAfter.collapsed, true, 'a finished First challenges collapses, per the board default');
  const ordered = pane._ordered();
  assert.deepEqual(Array.from(after.groups, (g) => g.key), ['week', 'setup'],
    'the finished First challenges moved last');
  assert.equal(ordered[0].id, 2, 'This week leads');
  assert.equal(after.groups[0].cards[0].stateLabel, 'Not started',
    'the still-open card kept its own words');
  // The card that got done now carries its public row's done state.
  const doneCard = after.groups.find((g) => g.key === 'setup').cards[0];
  assert.equal(doneCard.done, true, 'the card itself says Done');
});

test('a failed tick leaves the grid exactly as it was', async () => {
  const { pane, store, timers, calls } = loadPane({
    challenges: [ch(1, 'ONBOARDING'), ch(2, 'WEEKLY')],
    onboarding: LOCKED,
    challengesAnswer: jsonRes({ success: false, error: 'boom' }, false),
  });
  pane._renderGrid();
  const before = JSON.stringify(store.get().grid);
  await timers.intervals[0].fn();
  assert.equal(JSON.stringify(store.get().grid), before,
    'no error banner, no emptied grid, nothing changed');
  assert.equal(pane._challengesError, null, 'the first load\'s error state stays clean');
  assert.deepEqual(calls.filter((u) => u.includes('/challenges-api/')), [],
    'no decoration pass ran for a failed public read');
});

test('an answer that arrives after an event switch is discarded', async () => {
  const { pane, store, timers, context } = loadPane({
    challenges: [ch(1, 'ONBOARDING'), ch(2, 'WEEKLY')],
    onboarding: LOCKED,
    challengesAnswer: jsonRes(setupPayload([ch(9, 'SPOTLIGHT')], {
      total: 1, completed: 0, unlocked: true, hidden_count: 0, event_id: 11,
    })),
  });
  pane._renderGrid();
  const before = JSON.stringify(store.get().grid);
  const pending = timers.intervals[0].fn();
  context.eventId = 11; // the viewer switched events mid-flight
  await pending;
  assert.equal(JSON.stringify(store.get().grid), before,
    'event 11\'s answer must not paint over event 10\'s grid');
  assert.equal(pane._challenges[0].id, 1, 'the stored rows are still event 10\'s');
});
