// #1959 — the Improve panel says "Ready for your input" only when it is true.
//
// App feedback triage 2026-09-10, row 44b: change the pill from "Ready" to
// "Ready for your input" — but only when true. The sibling row (44a, #1958)
// made the Working → Ready flip follow the push; this one is about what the
// idle pill SAYS. Until now every idle session read "Ready", which is right
// for a finished build and for a spec with nothing left to ask, and wrong for
// a spec that ended with open Questions or an assistant holding for an
// answer — the rows a reader most needs to pick out.
//
// The fact comes from the server, because only the transcript knows it:
// GET /api/me/active-sessions ships `awaiting_input` (sessionAwaitsInput in
// routes/sessions.js — pinned in tests/me-active-sessions.test.js). Here the
// client half is pinned:
//
//   1. THE PILL. Rendered, not grepped: "Ready for your input" when the row
//      is waiting, plain "Ready" when it is not, "Working" while a turn is
//      in flight whatever the payload said, "Handed off" for a work order.
//      Same tone — the words carry the qualification. (The tile badge this
//      line also named is retired: #1946, #1947.)
//   2. THE CAPTION AGREES. "Needs you" and "Ready for your input" read ONE
//      predicate (awaitsInput), so the row cannot say two different things.
//   3. BUSY WINS LIVE. A push that starts a turn takes "Needs you" down in
//      the same frame it puts the spinner up (#1958's shape), and the open
//      panel's refetch is what brings the next verdict.
//
// Run with: node --test tests/improve-ready-for-input.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { runModules, makeStoreStub } = require('./helpers/bundle-module');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx.js');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const CONTROLLER = read('frontend/src/features/improve/improve-controller.js');
const ROW_TSX = read('frontend/src/features/improve/session-row.tsx');
const SESSION_STATE = read('public/js/session-state.js');

// ── 1. The pill, rendered ──────────────────────────────────────────────

// Bundled once: esbuild is the slow part, and the row is pure.
const { SessionRow } = loadTsx('frontend/src/features/improve/session-row.tsx');

const VIEW = {
  key: 's5', kind: 'session', id: 5, appSlug: 'demo', appName: 'Demo app',
  icon: { kind: 'letter', letter: 'D' }, title: 'Draft the spec',
  href: '#app/demo/dev/sessions/5', status: null, busy: false, awaitingInput: false,
  lastActivityAt: '2026-09-10T10:05:00.000Z',
};

/** The pill as rendered: its visible words, and whether the arc is in it. */
function pill(view) {
  const html = renderToHtml(createElement(SessionRow, {
    session: view, showApp: false, onNavigate() {},
  }));
  const at = html.indexOf('shrink-0 inline-flex');
  assert.ok(at > 0, 'the row renders its pill');
  const open = html.lastIndexOf('<span', at);
  const markup = html.slice(open, html.indexOf('</a>', at));
  // The arc ELEMENT — the pill's own class run names the arc's class too
  // (the `[&>.dc-status-spinner-arc]` recolour), so a substring would
  // always match.
  return {
    text: markup.replace(/<[^>]+>/g, '').trim(),
    spins: /class="dc-status-icon dc-status-spinner-arc"/.test(markup),
  };
}

test('a finished spec with open questions reads "Ready for your input"', () => {
  assert.deepEqual(pill({ ...VIEW, awaitingInput: true }), { text: 'Ready for your input', spins: false });
});

test('a finished spec with nothing to answer, or a finished build, reads plain "Ready"', () => {
  assert.deepEqual(pill(VIEW), { text: 'Ready', spins: false });
});

test('a turn in flight stays "Working", whatever the payload said about waiting', () => {
  // The controller never sets both, but the component still has to put the
  // spinner first: "Ready for your input" beside an arc is a contradiction.
  assert.deepEqual(pill({ ...VIEW, busy: true, awaitingInput: true }), { text: 'Working', spins: true });
});

test('a handed-off work order keeps its own word', () => {
  assert.deepEqual(pill({ ...VIEW, key: 't7', kind: 'task', id: 7, href: '#app/demo/dev/issues/7' }),
    { text: 'Handed off', spins: false });
});

test('the qualification is words, not a fourth state', () => {
  // One Ready branch, one tone — the same table
  // tests/improve-session-spinner.test.js counts three branches of.
  const start = ROW_TSX.indexOf('function stateOf(');
  const body = ROW_TSX.slice(start, ROW_TSX.indexOf('\n}\n', start));
  assert.match(body, /label: session\.awaitingInput \? 'Ready for your input' : 'Ready',/);
  assert.equal((body.match(/bg-emerald-500\/15 text-emerald-700 dark:text-emerald-400/g) || []).length, 1,
    'both labels share the emerald pill');
  // The emerald tile badge that stood beside it was the row's static green
  // dot, and it is retired (#1946) — the tint above is the only emerald the
  // Ready state has left, and it comes with the word that explains it.
  assert.doesNotMatch(body, /badge:/, 'no second renderer for the same state');
  assert.doesNotMatch(body, /Ready for your input[\s\S]*?spinner: true/,
    'a waiting row never spins');
});

// ── 2 & 3. The controller: one predicate for caption and pill ──────────

const SESSION = {
  id: 5, app_slug: 'demo', app_name: 'Demo app', status: 'active',
  session_title: 'Draft the spec', created_at: '2026-09-10T10:00:00.000Z',
  last_activity_at: '2026-09-10T10:05:00.000Z',
};

/**
 * One page, as tests/improve-live-session-state.test.js builds it: the store
 * script first (it publishes `window.SessionState`), then the real controller
 * over it, so the busy precedence under test is the shipped one.
 */
function load(answers) {
  const fetches = [];
  let clock = 1_700_000_000_000;
  const sandbox = {
    console, Promise, URLSearchParams,
    setTimeout: (fn, ms) => { sandbox.timers.push({ fn, ms }); return sandbox.timers.length; },
    clearTimeout() {},
    timers: [],
    Date: { now: () => clock, parse: (v) => Date.parse(v) },
    location: { search: '', hash: '' },
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
  runModules(sandbox, [['improve-controller.js', CONTROLLER]], {
    imports: {
      '../apps/app-card.js': { iconViewFor: (app) => ({ kind: 'letter', letter: app.name[0] }) },
      '../../lib/kit-surface': { adoptKitSurface: () => null },
      '../../lib/sheet-controller.js': { dismissRegisteredSheets() {} },
      './improve-store.js': { improveStore: store },
      '../../lib/shell-snapshot': { saveShellSnapshot() {} },
    },
    tail: 'window.__improve = Improve;',
  });
  return {
    Improve: sandbox.__improve,
    SessionState: sandbox.window.SessionState,
    store,
    fetches,
    tick: (ms) => { clock += ms; },
  };
}

const payload = (session, externalTasks = []) => ({ sessions: [{ ...SESSION, ...session }], externalTasks });
const row = (store) => store.state.sessions[0];

test('the server verdict reaches the row, and the caption says the same thing', async () => {
  const { Improve, store } = load([payload({ busy: false, awaiting_input: true })]);
  await Improve.loadSessions();
  assert.equal(row(store).awaitingInput, true);
  assert.equal(row(store).status, 'Needs you');
  assert.equal(row(store).busy, false);
});

test('a session with nothing to answer is plain Ready, and its caption says nothing', async () => {
  const { Improve, store } = load([payload({ busy: false, awaiting_input: false })]);
  await Improve.loadSessions();
  assert.equal(row(store).awaitingInput, false);
  assert.equal(row(store).status, null);
});

test('a server without the field contributes plain Ready rows, not a throw', async () => {
  const { Improve, store } = load([payload({ busy: false })]);
  await Improve.loadSessions();
  assert.equal(row(store).awaitingInput, false);
  assert.equal(row(store).status, null);
});

test('a turn in flight is never waiting on anyone — the payload flag', async () => {
  const { Improve, store } = load([payload({ busy: true, awaiting_input: true })]);
  await Improve.loadSessions();
  assert.equal(row(store).busy, true);
  assert.equal(row(store).awaitingInput, false);
  assert.equal(row(store).status, 'Working…');
});

test('a push that starts a turn takes "Needs you" down in the same frame', async () => {
  const { Improve, SessionState, store, fetches } = load([payload({ busy: false, awaiting_input: true })]);
  await Improve.loadSessions();
  assert.equal(row(store).status, 'Needs you', 'waiting, per the payload');

  // The owner answers; the turn starts. The panel is SHUT, so nothing
  // refetches — the row has to get this right from the push alone.
  SessionState.applyEvent({ sessionId: 5, busy: true, phase: 'cc', status: 'active' });
  Improve.onSessionStateChanged();

  assert.equal(row(store).busy, true, 'the pill spins (#1958)');
  assert.equal(row(store).awaitingInput, false, 'and it is no longer waiting on the user');
  assert.notEqual(row(store).status, 'Needs you', 'the caption cannot contradict the spinner');
  assert.equal(fetches.length, 1, 'no refetch while the panel is shut');
});

test('the open panel refetches when the turn ends, and the row takes the new verdict', async () => {
  // Three answers for three requests: the open, the mid-turn reload the
  // starting push triggers, and the reload the ending push triggers — the
  // one that carries the verdict on the answered spec.
  const { Improve, SessionState, store, fetches } = load([
    payload({ busy: false, awaiting_input: true }),
    payload({ busy: true, awaiting_input: false }),
    payload({ busy: false, awaiting_input: false }),
  ]);
  await Improve.loadSessions();
  store.state.open = true;
  SessionState.applyEvent({ sessionId: 5, busy: true, phase: 'cc', status: 'active' });
  Improve.onSessionStateChanged();

  // The turn ends. The push flips the pill; the reload (open panels only)
  // is what carries the verdict, as it carries the title and the caption.
  SessionState.applyEvent({ sessionId: 5, busy: false, status: 'active' });
  Improve.onSessionStateChanged();
  assert.equal(fetches.length, 3, 'the open panel refetched on both pushes');
  // The stubbed fetch resolves in microtasks; one macrotask drains them.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(row(store).busy, false);
  assert.equal(row(store).awaitingInput, false, 'the answered spec is plain Ready');
  assert.equal(row(store).status, null);
});

test('the status seam #1417 left still reads', async () => {
  // Nothing publishes these into this payload yet; a row that does arrive
  // in that state reads right rather than falling to plain Ready.
  const { Improve, store } = load([payload({ busy: false, status: 'awaiting_input' })]);
  await Improve.loadSessions();
  assert.equal(row(store).awaitingInput, true);
  assert.equal(row(store).status, 'Needs you');
});

test('a work order is never waiting, for the reason it is never busy', async () => {
  const { Improve, store } = load([payload({ busy: false }, [{
    id: 9, issue_number: 1417, title: 'Handed off work', branch_name: 'usernode/x',
    agent: 'claude-code', created_at: '2026-09-10T10:01:00.000Z',
    app_slug: 'demo', app_name: 'Demo app',
  }])]);
  await Improve.loadSessions();
  const task = store.state.sessions.find((r) => r.kind === 'task');
  assert.ok(task, 'the work order is listed');
  assert.equal(task.awaitingInput, false);
  assert.equal(task.busy, false);
});

test('one predicate feeds both surfaces', () => {
  const fn = CONTROLLER.slice(CONTROLLER.indexOf('function toRow('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /status: statusLabel\(session\)/);
  assert.match(body, /awaitingInput: awaitsInput\(session\)/);
  const label = CONTROLLER.slice(CONTROLLER.indexOf('function statusLabel('));
  assert.match(label.slice(0, label.indexOf('\n}\n')), /if \(awaitsInput\(session\)\) return 'Needs you';/);
  // …and the predicate defers to the LIVE busy accessor, not the payload flag.
  const pred = CONTROLLER.slice(CONTROLLER.indexOf('function awaitsInput('));
  assert.match(pred.slice(0, pred.indexOf('\n}\n')), /liveBusy\(session\)\) return false/);
});
