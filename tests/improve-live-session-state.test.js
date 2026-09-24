// #1958 — the Improve panel's rows follow the live session store.
//
// App feedback triage 2026-09-10, row 44a: "improve sidebar update delay when
// spec finishes". The sidebar is the Improve panel — the right-edge slide-over
// on desktop — and what lagged was its Working / Ready pill. The panel's rows
// read `busy` off the last /api/me/active-sessions answer, so they were the
// one working-state surface on the platform that did NOT read it through
// SessionState (public/js/session-state.js), which every turn boundary already
// pushes to. With the panel open, a finished turn flipped its pill one refetch
// round trip after the push; with it shut, opening it afterwards painted the
// flag a fetch during the turn had left behind until the open-time refetch
// landed. And the controller seeded the store with `data.issuedAt`, a field
// the endpoint never sent, so every payload was stamped at ARRIVAL — the
// inversion the store's own comment warns about, which let an answer that was
// in flight while the turn ended put the spinner straight back.
//
// The real controller and the real store are loaded together, as the page
// loads them, so the precedence rule under test is the shipped one. The clock
// is the harness's, because "issued before the event, landed after it" is a
// statement about timestamps.
//
// Run with: node --test tests/improve-live-session-state.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { runModules, makeStoreStub } = require('./helpers/bundle-module');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const CONTROLLER = read('frontend/src/features/improve/improve-controller.js');
const SESSION_STATE = read('public/js/session-state.js');

const SESSION = {
  id: 5, app_slug: 'demo', app_name: 'Demo app', status: 'active',
  session_title: 'Draft the spec', created_at: '2026-09-10T10:00:00.000Z',
  last_activity_at: '2026-09-10T10:05:00.000Z',
};

/**
 * One page: the store script first (it publishes `window.SessionState`), then
 * the controller over it. `answers` is what each successive fetch resolves
 * with — a function returns its own promise, so a test can hold an answer
 * back and land it after an event.
 */
function load(answers) {
  const fetches = [];
  let clock = 1_700_000_000_000;
  const sandbox = {
    console, Promise, URLSearchParams,
    // Recorded, never run: the store's coalesced notify and its reconcile
    // tick both go through here, and neither is what these tests are about.
    setTimeout: (fn, ms) => { sandbox.timers.push({ fn, ms }); return sandbox.timers.length; },
    clearTimeout() {},
    timers: [],
    // The harness owns time. Only `now` and `parse` are read (the store's
    // stamps, the controller's recency sort).
    Date: { now: () => clock, parse: (v) => Date.parse(v) },
    location: { search: '', hash: '' },
    // The viewer: the mark's working indicator counts their own sessions only.
    App: { user: { id: 7 } },
    document: { hidden: false, visibilityState: 'visible', getElementById: () => null, addEventListener() {} },
    fetch: (url) => {
      fetches.push(url);
      const next = answers.shift();
      if (typeof next === 'function') return next();
      return Promise.resolve({ ok: true, json: async () => next });
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SESSION_STATE, sandbox);
  const store = makeStoreStub({
    slug: 'demo', name: 'Demo app', open: false, working: false,
    sessions: [], otherSessions: [], sessionsLoaded: false, loadingSessions: false,
  });
  // The one surface still listing these sessions. Flip `sheet.open` in a
  // test that needs the reload gate open; it is the notifications sheet's
  // flag, not the Improve panel's — that panel retired (#2718 review).
  const sheet = { open: false };
  runModules(sandbox, [['improve-controller.js', CONTROLLER]], {
    imports: {
      '../apps/app-card.js': { iconViewFor: (app) => ({ kind: 'letter', letter: app.name[0] }) },
      // THE CONTROLLER PRESENTS NOTHING NOW (#2718 review). It adopted the
      // Improve panel's root through lib/kit-surface and swept the other
      // sheets through lib/sheet-controller; the panel retired, `open()`
      // forwards to the app-context sheet, and both stubs went with it. What
      // it does import is the notifications sheet's own open flag — the one
      // surface still listing these sessions, and the gate on reloading them.
      '../notifications/notifications-sheet-store.js': {
        notificationsSheetStore: { get: () => sheet, subscribe: () => () => {} },
      },
      './improve-store.js': { improveStore: store },
      '../../lib/shell-snapshot': { saveShellSnapshot() {} },
    },
    tail: 'window.__improve = Improve;',
  });
  return {
    Improve: sandbox.__improve,
    SessionState: sandbox.window.SessionState,
    store,
    sheet,
    fetches,
    tick: (ms) => { clock += ms; },
  };
}

const payload = (busy) => ({ sessions: [{ ...SESSION, busy }], externalTasks: [] });

// ── The push repaints the row ──────────────────────────────────────────

test('a finished turn flips the row to Ready on the push, before any refetch', async () => {
  const { Improve, SessionState, store, fetches } = load([payload(true)]);
  await Improve.loadSessions();
  assert.equal(store.state.sessions.length, 1);
  assert.equal(store.state.sessions[0].busy, true, 'mid-turn, the payload says so');

  // The turn ends. The panel is SHUT — the common case: a slide-over is
  // closed to work in the chat it covers — and the island's subscription
  // (features/improve/index.tsx) calls exactly this.
  SessionState.applyEvent({ sessionId: 5, busy: false, status: 'active' });
  Improve.onSessionStateChanged();

  assert.equal(store.state.sessions[0].busy, false,
    'Ready, synchronously, from the store — not a round trip later');
  assert.equal(fetches.length, 1, 'and no refetch while the panel is shut');
  assert.equal(store.state.working, false, 'the button glyph agrees');
});

test('a turn STARTING flips the row to Working the same way', async () => {
  const { Improve, SessionState, store } = load([payload(false)]);
  await Improve.loadSessions();
  assert.equal(store.state.sessions[0].busy, false);

  // Somebody else's shared build on the same app: the row list does not
  // carry it and the mark stays quiet (#2779 follow-up: own work only).
  SessionState.applyEvent({ sessionId: 9, userId: 8, busy: true, phase: 'cc', status: 'active' });
  Improve.onSessionStateChanged();
  assert.equal(store.state.working, false, 'another member\'s build does not light the mark');

  SessionState.applyEvent({ sessionId: 5, userId: 7, busy: true, phase: 'cc', status: 'active' });
  Improve.onSessionStateChanged();

  assert.equal(store.state.sessions[0].busy, true);
  assert.equal(store.state.working, true);
});

test('an open sheet still reloads, for what the store cannot know', async () => {
  // A title that landed at turn end, the status line, the activity stamp:
  // none of those ride the session_state push, so the reload stays — but
  // the pill does not wait for it.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { Improve, SessionState, store, sheet, fetches } = load([payload(true), () => held]);
  await Improve.loadSessions();
  // The Improve panel's own flag until #2718's review retired the panel; the
  // sheet that lists these rows is the notifications one now.
  sheet.open = true;

  SessionState.applyEvent({ sessionId: 5, busy: false, status: 'active' });
  Improve.onSessionStateChanged();

  assert.equal(fetches.length, 2, 'the open panel refetches');
  assert.equal(store.state.sessions[0].busy, false,
    'and the row already reads Ready while that request is in flight');
  release({ ok: true, json: async () => payload(false) });
});

// ── The seed is stamped when the request goes out ──────────────────────

test('an answer issued before the turn ended cannot put Working back', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { Improve, SessionState, store, tick } = load([() => held]);

  // The request goes out at t0 carrying the mid-turn truth…
  const inFlight = Improve.loadSessions();
  // …the turn ends five seconds later…
  tick(5000);
  SessionState.applyEvent({ sessionId: 5, busy: false, status: 'active' });
  // …and the answer, written at t0, lands last.
  release({ ok: true, json: async () => payload(true) });
  await inFlight;

  assert.equal(SessionState.isBusy(5, true), false,
    'the older fetch loses to the newer event — the phantom-spinner rule');
  assert.equal(store.state.sessions[0].busy, false, 'and the row says Ready');
});

test('a later-issued answer is allowed to take over again', async () => {
  const { Improve, SessionState, store, tick } = load([payload(true)]);
  SessionState.applyEvent({ sessionId: 5, busy: false, status: 'active' });
  tick(5000);
  await Improve.loadSessions();
  assert.equal(store.state.sessions[0].busy, true,
    'a request issued after the event is newer than it');
});

// ── The fallback ───────────────────────────────────────────────────────

test('a session the store has never heard of keeps the payload flag', () => {
  const { Improve, store } = load([]);
  // onSessionCreated publishes a server row straight into the list, ahead
  // of any load that could have seeded the store.
  Improve.onSessionCreated({ ...SESSION, id: 9, busy: true }, 'demo');
  assert.equal(store.state.sessions[0].busy, true);
});

test('the row reads the shared accessor rather than the payload alone', () => {
  const fn = CONTROLLER.slice(CONTROLLER.indexOf('function toRow('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /busy: liveBusy\(session\)/);
  assert.doesNotMatch(body, /busy: isBusy\(session\)/,
    'the payload flag is the FALLBACK, inside liveBusy, not the answer');
  assert.match(CONTROLLER, /live\.isBusy\(session\.id, fallback\)/,
    'the same accessor the dev screen list and the board cards use');
  // And the seed no longer trusts a field the endpoint never sent.
  assert.doesNotMatch(CONTROLLER, /seed\(sessions, data\.issuedAt\)/);
  assert.match(CONTROLLER, /seed\(sessions, issuedAt\)/);
  assert.match(CONTROLLER, /const issuedAt = Date\.now\(\);[\s\S]{0,400}?fetch\(`\/api\/me\/active-sessions/,
    'stamped before the request goes out, as DevChat.loadActiveSessions does');
  assert.match(body, /: `#app\/\$\{session\.app_slug\}\/dev\/proposals\/\$\{session\.id\}`/,
    'the row opens the full change page rather than dropping directly into chat');
  // #2779: except a change an agent session started, which opens that conversation.
  assert.match(body, /href: session\.agent_session_id\s*\? `#messages\/agent\/\$\{session\.agent_session_id\}`/);
});
