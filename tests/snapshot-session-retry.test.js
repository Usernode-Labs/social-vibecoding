// #6429: a boot identity check that ran out of time must be retried while
// the connection stays up, and a late answer must settle it.
//
// The reported tab was reloaded while the server was slow: /api/auth/me took
// 2,049 ms, the read was aborted at BOOT_SESSION_TIMEOUT_MS (2,000), and
// _reconcileSession stayed on the display-only snapshot — which is what
// enterAuthed holds the events socket, SessionState and the budget badges
// behind. `usernode:offline-change` fires only when the probe's answer
// CHANGES, so an online tab never asked again: the bot's lists, the row
// labels and the bell stayed at their last showing for 26 minutes.
//
// These run the real _reconcileSession, _runSessionReconcile,
// _settleSnapshotSession, _scheduleSessionRetry, _clearSessionRetry,
// _fetchSession and _fetchWebSession in a VM, with a controllable fetch and
// a fake clock, so the retry ladder and the late answer are pinned as
// behaviour rather than spelling.
//
// Run with: node --test tests/snapshot-session-retry.test.js

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

// A top-level App method's source, from its name to its closing `},`.
function methodSource(name) {
  let start = APP.indexOf(`\n  async ${name}(`);
  if (start === -1) start = APP.indexOf(`\n  ${name}(`);
  assert.ok(start > -1, `App.${name} not found`);
  const end = APP.indexOf('\n  },\n', start);
  assert.ok(end > -1, `end of App.${name} not found`);
  return APP.slice(start + 1, end + 4);
}

const REAL = [
  '_reconcileSession', '_runSessionReconcile', '_settleSnapshotSession',
  '_scheduleSessionRetry', '_clearSessionRetry',
  '_fetchSession', '_fetchWebSession', '_answeredSignedOut',
  'bootSession', '_publishBootSession',
];

// #6429: the foreground hook is a module-scope assignment, not an App method.
const FOREGROUND = (() => {
  const at = APP.indexOf('App._foregroundResync = () => {');
  assert.ok(at > -1, 'App._foregroundResync not found');
  const end = APP.indexOf('\n};', at);
  return APP.slice(at, end + 3);
})();

const ME = { id: 41, username: 'sam', hasPlatformAccess: true };

const flush = () => new Promise((resolve) => setImmediate(resolve));

// A clock the test drives: nothing runs until advance() reaches it, and a
// promise queued by a timer gets a turn before the next one fires.
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const setTimeoutFake = (fn, ms) => {
    const id = ++seq;
    timers.set(id, { at: now + (Number(ms) || 0), fn, order: id });
    return id;
  };
  const clearTimeoutFake = (id) => { timers.delete(id); };
  async function advance(ms) {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[1].order - b[1].order)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await flush();
    }
    now = target;
    await flush();
  }
  return {
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    advance,
    now: () => now,
    at: (id) => (timers.has(id) ? timers.get(id).at : undefined),
    drop: (id) => { timers.delete(id); },
  };
}

const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const me = (id = ME.id) => response(200, { user: { ...ME, id } });

// Builds a sandboxed App whose reads the test answers by hand. A read that
// has not been answered is "still out" — the shape a slow server gives.
function harness({ online = true } = {}) {
  const clock = fakeClock();
  const state = { online };
  const calls = {
    fetches: [], connects: 0, reloads: 0, dropped: 0, saves: 0,
    sessionStart: 0, resyncs: 0, nudges: 0,
  };
  const reads = [];
  const fetchImpl = (url, opts) => {
    const read = { url: String(url), opts: opts || {} };
    calls.fetches.push(read.url);
    read.promise = new Promise((resolve, reject) => {
      read.resolve = resolve;
      read.reject = reject;
      const signal = read.opts.signal;
      if (signal) signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    reads.push(read);
    return read.promise;
  };
  const sandbox = {
    console, Promise, JSON, Date, Math, Object, Array, String, Number, Boolean, RegExp, Error,
    AbortController, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    fetch: fetchImpl,
    location: { reload() { calls.reloads += 1; } },
    document: {
      visibilityState: 'visible',
      dispatchEvent() {},
      addEventListener() {},
    },
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    },
  };
  sandbox.window = sandbox;
  sandbox.window.Offline = {
    isOffline: () => !state.online,
    nudge() { calls.nudges += 1; },
  };
  sandbox.SessionState = { start() { calls.sessionStart += 1; } };
  vm.createContext(sandbox);
  const methods = REAL.map(methodSource).join(',\n');
  vm.runInContext(`
    var App = {
      BOOT_SESSION_TIMEOUT_MS: 2000,
      BOOT_SESSION_LATE_LIMIT_MS: 30000,
      SESSION_RETRY_DELAYS_MS: [2000, 5000, 15000, 30000],
      _sessionRetryStep: 0,
      _sessionRetryTimer: null,
      _reconcileInFlight: null,
      _bootSession: null,
      _settleBootSession: null,
      _sessionFromSnapshot: true,
      user: ${JSON.stringify(ME)},
      ${methods},
    };
    ${FOREGROUND}
  `, sandbox);
  const App = sandbox.App;
  // The screens are out of scope: record what the promotion starts.
  App.connectEvents = () => { calls.connects += 1; };
  App._dropCachedSession = () => { calls.dropped += 1; };
  App.saveSessionSnapshot = () => { calls.saves += 1; };
  App._syncViewer = () => {};
  App.resyncCurrentView = () => { calls.resyncs += 1; };
  return { App, clock, state, calls, reads, sandbox };
}

test('a check that ran out of time is retried while online, and the tab goes live once', async () => {
  const h = harness();
  const boot = h.App._reconcileSession({ fromBoot: true });
  await flush();
  assert.equal(h.reads.length, 1, 'the boot asks once');

  await h.clock.advance(2000);
  assert.equal(h.App._sessionFromSnapshot, true, 'no answer: still on the snapshot');
  assert.equal(h.calls.nudges, 1, 'and the strip is nudged, as before');
  assert.equal((await h.App.bootSession()).unknown, true);
  const retry = h.App._sessionRetryTimer;
  assert.ok(retry, 'a retry is scheduled instead of waiting for the network to change');
  assert.equal(h.clock.at(retry) - h.clock.now(), 2000, 'the first rung is 2 s');

  // The retry fires while the first read is still out: one read at a time.
  await h.clock.advance(2000);
  assert.equal(h.reads.length, 1, 'the retry joined the read still out');

  // That read finally fails (a dropped connection, or its late limit).
  h.reads[0].reject(new Error('network'));
  await flush();
  assert.equal(h.calls.connects, 0, 'a failed check starts nothing');

  // The ladder asks again, and this time the server answers.
  await h.clock.advance(5000);
  assert.equal(h.reads.length, 2, 'the next attempt starts a new read');
  h.reads[1].resolve(me());
  await flush();

  assert.equal(h.App._sessionFromSnapshot, false, 'the check settled');
  assert.equal(h.calls.connects, 1, 'the events socket opens exactly once');
  assert.equal(h.calls.sessionStart, 1, 'and the held work starts once');
  assert.equal(h.App._sessionRetryTimer, null, 'no retry is left pending');

  await h.clock.advance(60000);
  assert.equal(h.reads.length, 2, 'nothing asks again once the check has settled');
  assert.equal(h.calls.connects, 1);
  await boot;
});

test('a late answer to the read that ran out of time settles the check', async () => {
  const h = harness();
  const boot = h.App._reconcileSession({ fromBoot: true });
  await flush();
  await h.clock.advance(2000);
  assert.equal(h.App._sessionFromSnapshot, true, 'the boot stopped waiting');
  assert.ok(h.App._sessionRetryTimer, 'and started the ladder');

  // The server answers 50 ms after the boot gave up waiting.
  await h.clock.advance(50);
  h.reads[0].resolve(me());
  await flush();

  assert.equal(h.App._sessionFromSnapshot, false, 'the late answer is an answer');
  assert.equal(h.calls.connects, 1, 'the socket opens once');
  assert.equal(h.calls.sessionStart, 1);
  assert.equal(h.calls.reloads, 0);
  assert.equal(h.App._sessionRetryTimer, null, 'and the pending retry is cleared');

  await h.clock.advance(60000);
  assert.equal(h.reads.length, 1, 'no retry asked again after the late answer');
  assert.equal(h.calls.connects, 1, 'held work starts once, never twice');
  await boot;
});

test('a 401 that arrives on time or late still drops the saved session and reloads', async () => {
  for (const late of [false, true]) {
    const h = harness();
    h.App._reconcileSession({ fromBoot: true });
    await flush();
    if (late) await h.clock.advance(2000);
    h.reads[0].resolve(response(401, { error: 'Not authenticated' }));
    await flush();
    assert.equal(h.calls.dropped, 1, `dropped (late=${late})`);
    assert.equal(h.calls.reloads, 1, `reloaded (late=${late})`);
    assert.equal(h.App._sessionFromSnapshot, false);
    assert.equal(h.App._sessionRetryTimer, null, 'no retry survives the reload');
  }
});

test('a different account that answers on time or late still reloads', async () => {
  for (const late of [false, true]) {
    const h = harness();
    h.App._reconcileSession({ fromBoot: true });
    await flush();
    if (late) await h.clock.advance(2000);
    h.reads[0].resolve(me(99));
    await flush();
    assert.equal(h.calls.reloads, 1, `reloaded (late=${late})`);
    assert.equal(h.calls.dropped, 1, 'the other account\'s shell is discarded');
    assert.equal(h.App._sessionRetryTimer, null);
  }
});

test('a 200 with no user says nothing, and the ladder stops', async () => {
  const h = harness();
  h.App._reconcileSession({ fromBoot: true });
  await flush();
  h.reads[0].resolve(response(200, {}));
  await flush();
  assert.equal(h.App._sessionFromSnapshot, true, 'still unverified');
  assert.equal(h.calls.connects, 0);
  assert.equal(h.App._sessionRetryTimer, null, 'asking again would get the same empty answer');
});

test('while the probe says offline, no retry is scheduled', async () => {
  const h = harness({ online: false });
  h.App._reconcileSession({ fromBoot: true });
  await flush();
  await h.clock.advance(2000);
  assert.equal(h.calls.nudges, 1, 'the offline strip is raised');
  assert.equal(h.App._sessionFromSnapshot, true);
  assert.equal(h.App._sessionRetryTimer, null,
    'offline waits for usernode:offline-change, as today');

  // A read that lands anyway still settles the check.
  h.reads[0].resolve(me());
  await flush();
  assert.equal(h.calls.connects, 1);
});

test('the retry ladder waits 2 s, 5 s, 15 s, then every 30 s', async () => {
  const h = harness();
  const seen = [];
  for (let i = 0; i < 5; i += 1) {
    h.App._scheduleSessionRetry();
    const id = h.App._sessionRetryTimer;
    assert.ok(id, `rung ${i + 1} is scheduled`);
    seen.push(h.clock.at(id) - h.clock.now());
    // Consume the timer without running it, so the step is visible.
    h.clock.drop(id);
    h.App._sessionRetryTimer = null;
  }
  assert.deepEqual(seen, [2000, 5000, 15000, 30000, 30000]);
  h.App._clearSessionRetry();
  assert.equal(h.App._sessionRetryStep, 0, 'and a settled check starts over at 2 s');
});

test('a retry and a return to the tab share one read', async () => {
  const h = harness();
  const boot = h.App._reconcileSession({ fromBoot: true });
  await flush();
  h.App._reconcileSession();
  h.App._reconcileSession();
  await flush();
  assert.equal(h.reads.length, 1, 'only one read is out');

  h.reads[0].resolve(me());
  await Promise.all([boot, flush()]);
  assert.equal(h.calls.connects, 1, 'and it settles the check once');
});

test('coming back to the tab asks at once while the check is unverified', async () => {
  const h = harness();

  h.sandbox.document.visibilityState = 'hidden';
  h.App._foregroundResync();
  await flush();
  assert.equal(h.reads.length, 0, 'a hidden tab asks nothing');

  h.sandbox.document.visibilityState = 'visible';
  h.App._foregroundResync();
  await flush();
  assert.equal(h.reads.length, 1, 'a visible one asks now');
  assert.equal(h.reads[0].url, '/api/auth/me');

  h.App._foregroundResync();
  await flush();
  assert.equal(h.reads.length, 1, 'one read at a time');

  h.reads[0].resolve(me());
  await flush();
  assert.equal(h.App._sessionFromSnapshot, false);
  h.App._foregroundResync();
  await flush();
  assert.equal(h.reads.length, 1, 'a verified session is not asked about again');

  // Offline it waits for the probe, exactly as it did before.
  h.App._sessionFromSnapshot = true;
  h.state.online = false;
  h.App._foregroundResync();
  await flush();
  assert.equal(h.reads.length, 1);
});
