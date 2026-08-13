// Completed-challenge deep link (#982):
// #leaderboard/challenges/<eventId>/<challengeId>.
//
// WHAT THIS PINS. The profile's completed list renders each row as a real
// anchor to that address. Making the anchor is the easy half; the address
// only means anything if the router carries BOTH ids through to the pane,
// and the pane holds the request until the grid it needs has actually been
// fetched. The pane is mounted by the section switch that comes AFTER the
// route is resolved, so nothing can be opened at route time — the request
// has to survive a mount and a fetch, and then be spent exactly once.
//
// Three layers:
//   1. Behavioural — the shipped topochain-challenges.js IIFE runs in a vm
//      with a DOM shim (same idiom as tests/estimator-card-render.test.js),
//      driven through the real openFromHash/_renderGrid path.
//   2. Static — the router in app.js parses the segments and hands them
//      over before the section mounts.
//   3. Static — the profile anchors point at the shape all of the above
//      expects.
//
// Run with: node --test tests/challenge-deep-link.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const CHALLENGES_SRC = fs.readFileSync(
  path.join(root, 'frontend/src/features/leaderboard/topochain-challenges.js'), 'utf8'
);
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const profileJs = fs.readFileSync(path.join(root, 'frontend/src/features/profile/profile.js'), 'utf8');

// ── DOM shim: enough for the grid + the two overlays, no more ───────────

function makeElement(id) {
  const el = {
    id,
    innerHTML: '',
    dataset: {},
    style: {},
    _classes: new Set(),
    addEventListener() {},
    appendChild() {},
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  el.classList = {
    add: (c) => el._classes.add(c),
    remove: (c) => el._classes.delete(c),
    contains: (c) => el._classes.has(c),
  };
  return el;
}

// A pane wired to a fixed challenge list, with the event bar stubbed to the
// real one's contract: select() is a NO-OP when the id is unchanged, which
// is precisely the case the deep link has to cope with on its own.
function loadPane({ challenges, eventId = null }) {
  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  // The detail overlay ships hidden, like the real markup.
  byId('tc-se-detail-overlay').classList.add('hidden');

  const subs = [];
  const context = {
    eventId,
    select(id) {
      if (id == null || id === context.eventId) return; // real no-op branch
      context.eventId = id;
      context.notify();
    },
    onChange(fn) { subs.push(fn); return () => {}; },
    // The bar notifies on a user pick AND once at the end of its own
    // initial loadEvents() — the second one carries no change at all.
    notify() { for (const fn of subs) fn(context.eventId); },
  };

  const sandbox = {
    document: {
      getElementById: byId,
      createElement: (tag) => makeElement(tag),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    window: { TopochainEventContext: context },
    console,
    setTimeout,
    clearTimeout,
    location: { hash: '', search: '' },
    // The pane fetches its breakdown when a detail opens; keep it empty so
    // the assertions are about which challenge opened, not about the fetch.
    // It still has to be well-SHAPED: the breakdown renderer reads
    // `totals.participants` off the page, and that render lands after the
    // synchronous test body has returned, where a throw becomes an
    // unhandled rejection rather than a failed assertion.
    fetch: async (url) => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({
        success: true,
        data: String(url).includes('/breakdown')
          ? { entries: [], totals: { participants: 0, total_points: 0 }, has_more: false }
          : [],
      }),
    }),
  };
  sandbox.window.window = sandbox.window;
  // In a browser `window.X` IS a bare global, and the shipped code leans on
  // that: it feature-detects `window.TopochainEventContext` and then calls
  // `TopochainEventContext.select(...)` unqualified. Mirror it here or the
  // vm sees only half the pair.
  sandbox.TopochainEventContext = context;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CHALLENGES_SRC, sandbox, { filename: 'topochain-challenges.js' });

  const pane = sandbox.window.TopochainChallenges;
  pane._open = true;
  pane._challenges = challenges;
  pane._challengesLoading = false;
  pane._loadedEventId = eventId;
  return { pane, context, byId, subs };
}

const CH = [
  { id: 900500, completed: false, card_preview: { goal: 'Report a bug' } },
  { id: 900511, completed: true, card_preview: { goal: 'Share the announcement' } },
  { id: 900514, completed: true, card_preview: { goal: 'Vote five times' } },
];

const overlayOpen = (byId) =>
  !byId('tc-se-detail-overlay').classList.contains('hidden');

// A pending link the PANE built was constructed inside the vm, so its
// prototype is the sandbox's Object.prototype and deepStrictEqual — which
// compares prototypes — rejects it against a host literal. Copy it into this
// realm first; the assertion is about the two ids, not about which realm
// allocated the wrapper.
const pending = (pane) =>
  (pane._pendingDeepLink ? { ...pane._pendingDeepLink } : pane._pendingDeepLink);

// ─── 1. Behavioural ─────────────────────────────────────────────────────

test('a deep link opens that challenge once the grid paints', () => {
  // eventId already matches: select() no-ops, so nothing re-renders and the
  // request must be resolved against the grid as it already stands.
  const { pane, byId } = loadPane({ challenges: CH, eventId: 900500 });
  pane._renderGrid();
  assert.equal(overlayOpen(byId), false, 'nothing opens unprompted');

  pane.openFromHash(900500, 900514);
  assert.equal(pane._detailChallenge?.id, 900514);
  assert.equal(overlayOpen(byId), true);
  assert.equal(pane._pendingDeepLink, null, 'the request is spent');
});

test('a deep link registered before the pane loads survives until it does', () => {
  const { pane, context, byId } = loadPane({ challenges: [], eventId: null });
  // The router resolves the address while the pane is still unmounted —
  // exactly what App._routeLeaderboard does before Leaderboard._setSection.
  pane._open = false;
  pane.openFromHash(900500, 900511);
  assert.equal(context.eventId, 900500, 'the event bar is pointed at the right event');
  assert.deepEqual(pending(pane), { eventId: 900500, challengeId: 900511 });

  // Mount + first paint.
  pane._open = true;
  pane._challenges = CH;
  pane._renderGrid();
  assert.equal(pane._detailChallenge?.id, 900511);
  assert.equal(overlayOpen(byId), true);
});

test('a mid-reload render cannot spend the link on the previous event’s grid', () => {
  // loadChallenges() re-renders with _challengesLoading set while the OLD
  // event's rows are still in _challenges. Matching against those could open
  // a challenge from the wrong event — or burn the request on a list the
  // target was never in.
  const { pane, byId } = loadPane({ challenges: CH, eventId: 900500 });
  pane._open = false;
  pane.openFromHash(900502, 900777);
  pane._open = true;

  pane._challengesLoading = true;
  pane._renderGrid();
  assert.deepEqual(pending(pane), { eventId: 900502, challengeId: 900777 },
    'still pending — that grid was not the one it asked for');
  assert.equal(overlayOpen(byId), false);
});

test('a grid for a DIFFERENT event leaves the link armed', () => {
  // The other half of the same guard: the pane can finish a render for the
  // event the viewer was already on while the requested one is still in
  // flight. State is set directly here because the sequence — request for
  // 900502, bar back on 900500 — is a race no public call reproduces in
  // order.
  const { pane, context, byId } = loadPane({ challenges: CH, eventId: 900500 });
  pane._pendingDeepLink = { eventId: 900502, challengeId: 900514 };
  context.eventId = 900500;
  pane._challengesLoading = false;
  pane._renderGrid();
  assert.deepEqual(pending(pane), { eventId: 900502, challengeId: 900514 });
  assert.equal(overlayOpen(byId), false,
    '900514 exists in THIS grid — resolving here would open the wrong event’s copy');
});

test('an unknown challenge id lands silently on the grid', () => {
  const { pane, byId } = loadPane({ challenges: CH, eventId: 900500 });
  pane.openFromHash(900500, 424242);
  assert.equal(overlayOpen(byId), false, 'no overlay');
  assert.equal(pane._pendingDeepLink, null,
    'spent anyway — a missing id must not fire later against another event');
  assert.equal(pane._challengesError, null, 'and no error state');
});

test('an event with no challenges retires the link instead of holding it', () => {
  const { pane } = loadPane({ challenges: [], eventId: 900500 });
  pane.openFromHash(900500, 900514);
  pane._renderGrid(); // empty state
  assert.equal(pane._pendingDeepLink, null);
});

test('a bare event id selects the event and opens nothing', () => {
  const { pane, context, byId } = loadPane({ challenges: CH, eventId: 900500 });
  pane.openFromHash(900502, null);
  assert.equal(context.eventId, 900502);
  assert.equal(pane._pendingDeepLink, null);
  assert.equal(overlayOpen(byId), false);
});

test('closing the pane drops an unresolved link', () => {
  const { pane } = loadPane({ challenges: [], eventId: null });
  pane._open = false;
  pane.openFromHash(900502, 900514);
  assert.ok(pane._pendingDeepLink);
  pane.close();
  assert.equal(pane._pendingDeepLink, null,
    'a link left armed would pop an overlay on some later, unrelated visit');
});

test('a redundant event notification does not tear down the open overlay', () => {
  // The event bar notifies once at the end of its own initial loadEvents(),
  // carrying the event the pane already loaded. Treating that as a change
  // closed the detail a beat after the deep link opened it — the link
  // rendered the right panel and then lost it, which reads as the feature
  // not working at all.
  const { pane, context, subs } = loadPane({ challenges: CH, eventId: 900500 });
  pane._open = false;
  let reloads = 0;
  pane.loadChallenges = () => { reloads += 1; pane._loadedEventId = context.eventId; };
  pane.open(); // the shipped subscription wiring
  assert.equal(subs.length, 1, 'the pane subscribed to the event bar');
  assert.equal(reloads, 1, 'and did its own first load');

  pane._challenges = CH;
  pane._challengesLoading = false;
  pane.openFromHash(900500, 900514);
  assert.equal(pane._detailChallenge?.id, 900514);

  context.notify(); // same event — the initial loadEvents() tail
  assert.equal(reloads, 1, 'no redundant refetch');
  assert.equal(pane._detailChallenge?.id, 900514, 'and the overlay survives');
});

test('a real event switch still reloads and clears the overlay', () => {
  // The dedupe above must not blunt the case it sits next to.
  const { pane, context, subs } = loadPane({ challenges: CH, eventId: 900500 });
  pane._open = false;
  let reloads = 0;
  pane.loadChallenges = () => { reloads += 1; pane._loadedEventId = context.eventId; };
  pane.open();
  assert.equal(subs.length, 1);
  reloads = 0;

  pane._challenges = CH;
  pane._challengesLoading = false;
  pane.openFromHash(900500, 900514);
  assert.equal(pane._detailChallenge?.id, 900514);

  context.select(900502); // a user pick in the event picker
  assert.equal(reloads, 1, 'the new event is fetched');
  assert.equal(pane._detailChallenge, null,
    'and the previous event’s detail is torn down');
});

test('_loadedEventId tracks the event the grid belongs to', () => {
  assert.match(CHALLENGES_SRC,
    /TopochainChallenges\._loadedEventId = eventId;/,
    'loadChallenges records which event its list is for');
  const load = CHALLENGES_SRC.slice(CHALLENGES_SRC.indexOf('async loadChallenges()'));
  const assignAt = load.indexOf('_loadedEventId = eventId');
  const guardAt = load.indexOf('if (eventId == null)');
  assert.ok(assignAt > -1 && assignAt < guardAt,
    'it is recorded before the no-event early return, or a null event never clears it');
});

// ─── 2. Static: the router carries both ids ─────────────────────────────

test('the hash router parses #leaderboard/challenges/<event>/<challenge>', () => {
  assert.match(appJs, /const challengeTarget = parts\[1\] === 'challenges' && parts\[2\]/);
  assert.match(appJs, /eventId: App\._numericSegment\(parts\[2\]\)/);
  assert.match(appJs, /challengeId: App\._numericSegment\(parts\[3\]\)/);
  assert.match(appJs, /App\.navigateToLeaderboard\(parts\[1\], profileUser, challengeTarget\)/);
});

test('a non-numeric segment degrades to the plain screen', () => {
  const start = appJs.indexOf('_numericSegment(raw)');
  const body = appJs.slice(start, appJs.indexOf('\n  },', start));
  assert.match(body, /Number\.isInteger\(n\) && n > 0 && n <= 2147483647 \? n : null/,
    'ids must be positive signed 32-bit integers — invalid values must not reach fetch URLs');
});

test('the target is threaded through both navigateToLeaderboard paths', () => {
  // The already-mounted fast path and the cold screen-swap path each call
  // _routeLeaderboard; a target dropped on either one makes the deep link
  // work only on a full page load, or only on an in-app click.
  const calls = appJs.match(
    /App\._routeLeaderboard\(sub, profileUser, challengeTarget\)/g
  ) || [];
  assert.equal(calls.length, 2, 'both the mounted and the cold path pass it on');
  assert.match(appJs, /navigateToLeaderboard\(sub, profileUser, challengeTarget\)/);
  assert.match(appJs, /_routeLeaderboard\(sub, profileUser, challengeTarget\)/);
});

test('the pane is told BEFORE the section mounts', () => {
  // The DEFINITION, not one of the two call sites above it.
  const start = appJs.indexOf('\n  _routeLeaderboard(sub, profileUser, challengeTarget) {');
  assert.ok(start > 0, '_routeLeaderboard must take the target');
  const body = appJs.slice(start, appJs.indexOf('\n  },', start));
  const handoff = body.indexOf('TopochainChallenges.openFromHash');
  const mount = body.indexOf('Leaderboard._setSection(sub)');
  assert.ok(handoff > -1 && mount > -1);
  assert.ok(handoff < mount,
    'selecting the event after the mount would load the default event, then throw it away');
  assert.match(body, /window\.TopochainChallenges\?\.openFromHash/,
    'feature-detected — the pane script may not be present on every shell build');
});

// ─── 3. Static: the anchors point at that address ───────────────────────

test('the profile links each completed challenge to <event>/<challenge>', () => {
  assert.match(profileJs,
    /card\.href = '#leaderboard\/challenges\/' \+\s*\n\s*`\$\{encodeURIComponent\(c\.season_event_id\)\}\/\$\{encodeURIComponent\(c\.id\)\}`/,
    'both ids, in that order — the event id is what makes the challenge id resolvable');
  assert.match(profileJs, /card\.setAttribute\('data-completed-challenge', String\(c\.id\)\)/);
});
