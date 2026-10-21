// Challenge groups on the Challenges tab (the Semi design, 2026-10-16).
//
// WHAT THIS PINS. The tab draws at most three groups, in this order, each a
// heading over its own grid: First challenges (the open ONBOARDING ones), Next
// challenges (every other open one, whatever its category) and Done (every
// finished one, at the end). Each group is a contiguous slice of the ONE flat
// order the cards' `idx` index into. Nothing on the tab says anything about
// time: no group clocks, no toggles, no deadlines on the cards or the page. A
// weekly challenge's counted rail says "this week" instead.
//
// The real controller runs in a vm with a stub store, as in
// tests/challenge-deep-link.test.js. The pane half renders
// ./challenges-pane.tsx over the descriptors that controller builds.
//
// Run with: node --test tests/challenge-groups.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/topochain-challenges.js'), 'utf8');
const PANE_PATH = 'frontend/src/features/leaderboard/challenges-pane.tsx';
const PANE = fs.readFileSync(path.join(root, PANE_PATH), 'utf8');
const PANE_API = 'tests/fixtures/challenges-pane-api.ts';

// A pane over a fixed challenge list, with the event bar stubbed to the real
// one's contract (select() no-ops on the current id). Nothing here waits on
// the network: a fetch that never settles keeps every assertion about the
// synchronous half of each call.
function loadPane({ challenges = [], eventId = 10, event = null, onboarding = null, search = '' } = {}) {
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
  if (event) context.selectedEvent = () => event;
  const sandbox = {
    window: { TopochainEventContext: context },
    TopochainEventContext: context,
    console,
    setTimeout,
    clearTimeout,
    location: { hash: '', search },
    // A Web API, not a JavaScript builtin, so a bare vm context lacks it and
    // _maybeShot's lookup would throw into its own catch.
    URLSearchParams,
    fetch: () => new Promise(() => {}),
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.runInContext(SRC, sandbox, { filename: 'topochain-challenges.js' });

  const pane = sandbox.window.TopochainChallenges;
  const state = { mounted: true, grid: null, detail: null };
  const store = { get: () => state, set: (patch) => Object.assign(state, patch) };
  pane._store = store;
  pane._open = true;
  pane._challenges = challenges;
  pane._challengesLoading = false;
  pane._loadedEventId = eventId;
  pane._onboarding = onboarding;
  return { pane, store, context };
}

const ch = (id, label, extra = {}) => ({ id, card_preview: { label, goal: `Challenge ${id}` }, ...extra });
const DONE = { progress: { done: true } };

// Values copied out of the vm realm, whose arrays and objects deepStrictEqual
// would reject against host literals for their prototypes alone.
const gridOf = (store) => store.get().grid;
const keysOf = (grid) => Array.from(grid.groups, (g) => g.key);
const groupOf = (grid, key) => grid.groups.find((g) => g.key === key);
const idsOf = (pane) => Array.from(pane._ordered(), (c) => c.id);
const pageOf = (pane, c) => { pane._detailChallenge = c; return pane.detailView(); };

const MIXED = [
  ch(1, 'PERSISTENT'), ch(2, 'WEEKLY'), ch(3, 'SPOTLIGHT', DONE), ch(4, 'ONBOARDING', DONE),
  ch(5, ' weekly '), ch(6, 'onboarding'), ch(7, 'PERSISTENT'), ch(8, null),
];

// ─── Order ──────────────────────────────────────────────────────────────

test('the grid runs First challenges, Next challenges, Done, as slices of one flat order', () => {
  const { pane, store } = loadPane({ challenges: MIXED });
  pane._renderGrid();
  const grid = gridOf(store);
  assert.equal(grid.kind, 'cards');
  assert.deepEqual(keysOf(grid), ['first', 'next', 'done']);
  assert.deepEqual(Array.from(grid.groups, (g) => g.heading),
    ['First challenges', 'Next challenges', 'Done'],
    'sentence case in data: the heading uppercases with CSS');
  assert.deepEqual(idsOf(pane), [6, 1, 2, 5, 7, 8, 3, 4],
    'the group first, then the organiser’s order; every finished one, whatever its category, last');

  const idx = [];
  for (const g of grid.groups) for (const c of g.cards) idx.push(c.idx);
  assert.deepEqual(idx, [0, 1, 2, 3, 4, 5, 6, 7],
    'contiguous slices, strictly increasing, covering every card of _ordered()');
  const ordered = pane._ordered();
  for (const g of grid.groups) {
    for (const c of g.cards) assert.equal(pane._groupOf(ordered[c.idx]).key, g.key, `card ${c.idx} sits in its own group`);
  }
  assert.deepEqual(Array.from(groupOf(grid, 'first').cards, (c) => ordered[c.idx].id), [6],
    'a label is matched trimmed and case-blind, and a finished ONBOARDING card is Done, not First');
  for (const g of grid.groups) {
    assert.deepEqual(Object.keys(g).sort(), ['cards', 'heading', 'key'], `${g.key}: a heading and cards, no clock or toggle`);
  }
  assert.equal(grid.notice, undefined, 'no setup gate, no notice');
});

test('a group with no card is not drawn', () => {
  const { pane, store } = loadPane({ challenges: [ch(1, 'WEEKLY'), ch(2, 'PERSISTENT')] });
  pane._renderGrid();
  assert.deepEqual(keysOf(gridOf(store)), ['next'], 'nothing to start with and nothing done: one group');
  const done = loadPane({ challenges: [ch(1, 'WEEKLY', DONE), ch(2, 'ONBOARDING', DONE)] });
  done.pane._renderGrid();
  assert.deepEqual(keysOf(gridOf(done.store)), ['done'], 'everything finished: only Done');
});

test('inside a group: featured first, then the organiser’s order; a lift never crosses groups', () => {
  const { pane } = loadPane({ challenges: [ch(1, 'WEEKLY'), ch(2, 'WEEKLY'), ch(3, 'ONBOARDING'), ch(4, 'WEEKLY', DONE)] });
  pane._mine = new Map([[2, { featured: true }], [4, { featured: true }]]);
  assert.deepEqual(idsOf(pane), [3, 2, 1, 4]);
});

test('a card in a later group opens its own challenge', () => {
  const { pane, store } = loadPane({ challenges: MIXED });
  const opened = [];
  pane.openChallengeDetail = (c) => opened.push(c.id);
  pane._pushDetailHash = () => {};
  pane._renderGrid();
  const done = groupOf(gridOf(store), 'done');
  pane._openIdx(done.cards[1].idx);
  assert.deepEqual(opened, [4]);
});

// ─── No time on the tab ─────────────────────────────────────────────────

test('nothing on the tab tells the time: no clocks, toggles, deadlines or next counts', () => {
  const { pane, store } = loadPane({
    challenges: [
      ch(1, 'WEEKLY', { effective: { schedule_end: new Date(Date.now() + 3 * 86400000).toISOString() },
        scoring: { interval_minutes: 30, last_scored_at: new Date().toISOString() } }),
      ch(2, 'ONBOARDING'),
    ],
    event: { name: 'Season 2', ends_at: new Date(Date.now() + 90 * 86400000).toISOString() },
  });
  for (const gone of ['_groupClock', '_groupTimeLeft', '_groupSummary', '_endRaw', '_endsText', '_endsTitle',
    '_endsWhen', '_timeLeft', '_weekEnd', '_deadlineOf', '_cadenceOf', '_toggleGroup', '_collapsed']) {
    assert.equal(pane[gone], undefined, `${gone} is gone`);
  }
  pane._renderGrid();
  for (const g of gridOf(store).groups) {
    for (const c of g.cards) {
      assert.ok(!('deadline' in c) && !('cadence' in c), `card ${c.key}: no deadline and no next count`);
    }
  }
  const page = pageOf(pane, pane._challenges[0]);
  for (const key of ['eyebrow', 'deadline', 'ends', 'cadence']) assert.ok(!(key in page), `the page has no ${key}`);
  assert.doesNotMatch(JSON.stringify(gridOf(store)) + JSON.stringify(page), /left|next count|ends |Season 2/,
    'no time and no season in any word the tab draws');
});

test('a weekly challenge’s counted rail says this week; a yes-or-no one keeps its words', () => {
  const { pane } = loadPane();
  const counted = (label, current, metric = 'accepted') => pane._stateOf(ch(1, label, {
    progress: { done: false, current, target: 2 }, metric: metric ? { label: metric } : null,
  })).stateLabel;
  assert.equal(counted('WEEKLY', 0), '0/2 accepted this week');
  assert.equal(counted('weekly', 1), '1/2 accepted this week', 'the label is matched case-blind');
  assert.equal(counted('PERSISTENT', 1), '1/2 accepted', 'anything else counts without the week');
  assert.equal(counted('WEEKLY', 1, null), '1/2 this week', 'no unit: the figure and the week');
  assert.equal(counted('ONBOARDING', 1, null), '1/2', 'no unit, not weekly: the figure alone');
  // The fallback path (no per-viewer progress) counts ledger rows the same way.
  pane._mine = new Map([[1, { activities: [{}], activities_total: 0 }]]);
  assert.equal(pane._stateOf(ch(1, 'WEEKLY', { metric: { kind: 'apps_tried', target: 3, label: 'apps tried' } })).stateLabel,
    '1/3 apps tried this week');
  pane._mine = new Map();
  assert.equal(pane._stateOf(ch(1, 'WEEKLY', { progress: { done: false, current: 0, target: 1 } })).stateLabel,
    'Not started', 'a weekly yes-or-no one is not given a count it does not have');
  assert.equal(pane._stateOf(ch(1, 'WEEKLY', { progress: { done: false, current: 1, target: 1 } })).stateLabel,
    'Started');
});

// ─── The summary ────────────────────────────────────────────────────────

test('the summary counts every challenge on the tab, and the viewer’s points once they are known', () => {
  const { pane, store } = loadPane({ challenges: MIXED });
  pane._renderGrid();
  assert.deepEqual({ ...gridOf(store).progress }, { done: 2, total: 8, points: null },
    'before the viewer’s own rows land (or signed out) the points are unknown, not 0');
  pane._mine = new Map([[1, { activities_total: 500 }], [4, { activities_total: 3000 }], [9, { activities_total: 99 }]]);
  pane._renderGrid();
  assert.deepEqual({ ...gridOf(store).progress }, { done: 2, total: 8, points: 3500 },
    'the points the viewer earned on the challenges in view, and only those');
});

// ─── The pane ───────────────────────────────────────────────────────────

test('the pane draws each group as a small-caps heading over its own grid', () => {
  assert.doesNotMatch(PANE, /GroupHeader|_toggleGroup|aria-expanded/, 'no disclosure: every group is open');
  assert.match(PANE, /import \{[^}]*\bSectionHeader\b[^}]*\} from '@\/components\/ui\/grouped-list';/,
    'the shell’s label over a card group, not a hand-written one');
  const { pane, store } = loadPane({ challenges: MIXED });
  pane._renderGrid();
  const api = loadTsx(PANE_API);
  api.topochainChallengesStore.set({ mounted: true, grid: JSON.parse(JSON.stringify(gridOf(store))), detail: null });
  const html = renderToHtml(createElement(api.ChallengesPane));
  const heads = [...html.matchAll(/<h2 class="([^"]*)">([^<]*)<\/h2>\s*<div id="tc-se-group-(\w+)" class="grid /g)];
  assert.deepEqual(heads.map((h) => [h[2], h[3]]),
    [['First challenges', 'first'], ['Next challenges', 'next'], ['Done', 'done']],
    'each heading sits right over the grid it names');
  for (const h of heads) assert.match(h[1], /\buppercase\b/, `${h[2]}: small caps, by CSS`);
  assert.ok(html.indexOf('id="tc-se-challenge-summary"') < html.indexOf('First challenges'), 'the summary leads');
  assert.doesNotMatch(html, /How challenges work|data-challenges-intro/, 'the intro card is gone');
  // Code only: the pane's header comment names `{' '}` to explain its absence.
  const code = PANE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
  assert.doesNotMatch(code, /\{' '\}/, 'no whitespace child');
});

// The locked placeholder and the unlock note, AFTER the challenges (owner
// decision 2026-09-15). The placeholder's second line is the unlock note, so
// a pane that draws the placeholder draws no separate note; a locked event
// without a count (an older server) still gets the note, below the cards.
test('while locked the pane draws the placeholder after the last grid instead of the note; without a count, the note', () => {
  const api = loadTsx(PANE_API);
  const render = (onboarding) => {
    const { pane, store } = loadPane({ challenges: [ch(1, 'ONBOARDING', DONE), ch(2, 'ONBOARDING')], onboarding });
    pane._renderGrid();
    api.topochainChallengesStore.set({ mounted: true, grid: JSON.parse(JSON.stringify(gridOf(store))), detail: null });
    return renderToHtml(createElement(api.ChallengesPane));
  };
  const afterLastCard = (html, at) => at > html.lastIndexOf('tc-se-card');

  const locked = render({ total: 2, completed: 1, unlocked: false, event_id: 10, hidden_count: 6 });
  // The wrapper carries GRID as well as the gap: outside a grid the card
  // stretched across every column of a wide pane and read as a banner.
  const gridClass = PANE.match(/const GRID = '([^']+)';/)[1];
  const wrapper = `<div class="mt-3 ${gridClass}"><div class="`;
  const placeholder = locked.indexOf(wrapper);
  assert.ok(placeholder !== -1, 'the dashed placeholder, in a wrapper at the grid’s gap that is itself a GRID');
  assert.match(locked.slice(placeholder + wrapper.length).split('"')[0], /\bborder-dashed\b/,
    'the wrapper’s child is the dashed card, one column wide');
  assert.match(PANE, /<div className=\{`mt-3 \$\{GRID\}`\}>\s*<LockedChallengesCard /,
    'the source names the shared GRID constant, not a copy of its classes');
  assert.ok(afterLastCard(locked, placeholder), 'after the last card');
  assert.match(locked, />6 challenges unlock after Getting started</);
  assert.match(locked, />Finish Getting started on Home to see them</, 'without names, what to do');
  assert.doesNotMatch(locked, /role="status"/, 'its first line is the note, so the note is not repeated');
  assert.ok(locked.indexOf('id="tc-se-challenge-summary"') < locked.indexOf('tc-se-card'), 'the summary still leads');

  const named = render({
    total: 2, completed: 1, unlocked: false, event_id: 10, hidden_count: 6,
    hidden_names: ['Make your first proposal', 'Invite a friend'],
  });
  assert.match(named, />Make your first proposal, Invite a friend and 4 more</);

  const one = render({ total: 2, completed: 1, unlocked: false, event_id: 10, hidden_count: 1 });
  assert.match(one, />1 challenge unlocks after Getting started</);

  const uncounted = render({ total: 2, completed: 1, unlocked: false, event_id: 10 });
  assert.doesNotMatch(uncounted, /border-dashed/, 'no count, no placeholder');
  const note = uncounted.search(/<p class="mt-3 [^"]*" role="status">Finish Getting started to unlock the rest of the season\.<\/p>/);
  assert.ok(note !== -1, 'the note, with its text and role');
  assert.ok(afterLastCard(uncounted, note), 'below the challenges, not above them');

  const unlocked = render({ total: 2, completed: 2, unlocked: true, event_id: 10, hidden_count: 6 });
  assert.doesNotMatch(unlocked, /border-dashed/, 'unlocked, nothing is hidden');
  assert.doesNotMatch(unlocked, /role="status"/, 'and there is no notice to draw');
});

// ─── Screenshot state ───────────────────────────────────────────────────

test('?shot=challenge-detail opens the first unfinished card', () => {
  const opened = [];
  const { pane } = loadPane({
    search: '?shot=challenge-detail',
    challenges: [ch(1, 'ONBOARDING', DONE), ch(2, 'ONBOARDING', DONE), ch(3, 'PERSISTENT'), ch(4, 'WEEKLY')],
    onboarding: { total: 2, completed: 2, unlocked: true, event_id: 10 },
  });
  pane.openChallengeDetail = (c) => opened.push(c.id);
  pane._renderGrid();
  assert.deepEqual(idsOf(pane), [3, 4, 1, 2], 'the finished First challenges are Done, last');
  assert.deepEqual(opened, [3], 'the capture opens the next action');
  pane._renderGrid();
  assert.deepEqual(opened, [3], 'once per page load');

  const finished = [];
  const all = loadPane({
    search: '?shot=challenge-detail',
    challenges: [ch(5, 'WEEKLY', DONE), ch(6, 'PERSISTENT', DONE)],
  });
  all.pane.openChallengeDetail = (c) => finished.push(c.id);
  all.pane._renderGrid();
  assert.deepEqual(finished, [5], 'with nothing left to do it opens the first card');

  const none = [];
  const plain = loadPane({ challenges: [ch(7, 'WEEKLY')] });
  plain.pane.openChallengeDetail = (c) => none.push(c.id);
  plain.pane._renderGrid();
  assert.deepEqual(none, [], 'without the param a real user’s grid opens nothing');
});
