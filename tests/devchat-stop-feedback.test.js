// #889: clicking Stop in dev chat used to acknowledge itself with nothing
// at all — the red Stop button stayed red (there is no `:disabled` rule for
// `.dc-send-btn`, so `disabled = true` was invisible), the "Claude Code is
// running…" line kept spinning, and the chat looked untouched for the ~19s
// the server took to unwind the turn.
//
// These tests drive the REAL DevChat._stopCurrentTurn / _enterStoppingState /
// _clearStoppingState / _setStreamingUI / _finishStreaming against a minimal
// fake DOM, asserting on the observable button + message-list state rather
// than the network. Same vm-in-a-sandbox approach as
// tests/devchat-composer-restore.test.js — dev-chat.js is a plain browser
// script (`const DevChat = {…}`), so we load its source into a vm context,
// expose DevChat, and drive it.
//
// Cases (per the spec's Tests section):
//   1. click            → _stopping, dc-btn-stopping, exactly one row, the
//                         previously-live status row deactivated
//   2. `stopped` event  → row spliced, button back to Send, flag cleared
//   3. fetch rejects    → failure row, red Stop restored, turn still live
//   4. wrap-up refusal  → mayor2 spinner state, no stopping row
//   5. duplicate events → still exactly one row
//
// Run with: node --test tests/devchat-stop-feedback.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { makeComposerBridge, composerHtml } = require('./lib/dev-composer-html');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'),
  'utf8'
);

// One persistent fake element per id (registry-backed) so the send button we
// assert on survives re-resolution by id, mirroring the real DOM.
function makeElement(id) {
  const classes = new Set();
  const attrs = new Map();
  return {
    id,
    style: {},
    dataset: {},
    disabled: false,
    title: '',
    innerHTML: '',
    textContent: '',
    value: '',
    scrollHeight: 0,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (x) => classes.has(x),
      toggle: () => {},
    },
    setAttribute(k, v) { attrs.set(k, v); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    removeAttribute(k) { attrs.delete(k); },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { return c; },
    removeChild() {},
    remove() {},
    focus() {},
    blur() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function makeHarness() {
  // #1078: the send button is a FIELD of the composer's view model now —
  // `_setStreamingUI` published the four states it used to paint by hand.
  // These tests are about which state a stop lands in, so they read the
  // descriptor; the rendering of each is pinned once, at the bottom.
  const composer = makeComposerBridge();
  const registry = new Map();
  const getEl = (id) => {
    if (!registry.has(id)) registry.set(id, makeElement(id));
    return registry.get(id);
  };

  const document = {
    _title: 'MyApp',
    get title() { return this._title; },
    set title(v) { this._title = v; },
    getElementById: (id) => getEl(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeElement(`__created_${tag}`),
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
  };

  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };

  // Timers never fire on their own — nothing here waits out 15 or 40
  // seconds. #937: they ARE recorded, so the escalation-ladder tests can
  // fire a specific rung by its scheduled delay (fireRung below) instead
  // of reaching past the real _armStoppingLadder to mutate rows by hand.
  const timers = new Map();
  let nextTimerId = 1;
  const sandbox = {
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn, ms) => {
      const id = nextTimerId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
    document,
    localStorage,
    AbortController,
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    escapeHtml: (s) => String(s == null ? '' : s),
    App: { currentTab: 'dev', currentSubTab: 'sessions', user: { username: 'evan' } },
    Notifications: {},
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.UsernodeReact = { devChat: composer.bridge };

  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;

  // Neutralize rendering + streaming plumbing. Crucially _setStreamingUI is
  // left REAL — the button state is exactly what these tests are about.
  DevChat.renderMessages = () => {};
  DevChat.scrollToBottom = () => {};
  DevChat.refreshBudget = () => {};
  DevChat._showSpinner = () => {};
  DevChat._removeSpinner = () => {};
  DevChat._flushStreamingFinal = () => {};
  DevChat._stopProgressPolling = () => {};
  DevChat._closeResumableStream = () => {};
  DevChat._openResumableStream = () => {};
  DevChat._startProgressPolling = () => {};
  DevChat._syncSaveDraftBtn = () => {};
  DevChat._renderSavedDrafts = () => {};
  DevChat._renderQuickReplies = () => {};
  DevChat._applySyncBanner = () => {};
  DevChat._restoreComposer = () => {};
  DevChat._reconcileAfterFallbackDone = () => {};

  // The send button's state, straight off the model `_setStreamingUI`
  // publishes — `kind` IS the branch it used to paint.
  const send = () => composer.state().send;
  return { DevChat, sandbox, document, getEl, timers, composer, send };
}

// #937: run the escalation rung scheduled for `ms` (15000 = "taking longer
// than usual" + silent re-POST, 40000 = "isn't responding" + Force stop).
// Returns false when no such timer is armed, which is itself assertable.
function fireRung(timers, ms) {
  for (const [id, t] of timers) {
    if (t.ms === ms) {
      timers.delete(id);
      t.fn();
      return true;
    }
  }
  return false;
}

const armedDelays = (timers) => [...timers.values()].map((t) => t.ms).sort((a, b) => a - b);

const SESSION_ID = 42;

// Put the harness in the state a user sees mid-CC-turn: streaming, a live
// "Claude Code is running…" status row, red Stop button mounted.
function arriveMidTurn(DevChat) {
  DevChat.currentSession = { id: SESSION_ID, status: 'active' };
  DevChat.messages = [
    { role: 'user', content: 'add dark mode', created_at: new Date().toISOString() },
    {
      role: 'system',
      content: 'Claude Code is running...',
      created_at: new Date().toISOString(),
      _slug: 'aaa111',
      _active: true,
    },
  ];
  DevChat.isStreaming = true;
  DevChat._setStreamingUI(true, 'cc');
}

const stoppingRows = (DevChat) => DevChat.messages.filter((m) => m._stopping);

test('clicking Stop paints the stopping button + one transient row', async () => {
  const { DevChat, sandbox, send } = makeHarness();
  arriveMidTurn(DevChat);

  assert.equal(send().kind, 'stop', 'precondition: red Stop is mounted');

  let posted = null;
  sandbox.fetch = async (url, opts) => {
    posted = { url, method: opts?.method };
    return { ok: true, status: 200, json: async () => ({ ok: true, stopped: true, phase: 'cc' }) };
  };

  await DevChat._stopCurrentTurn();

  assert.equal(posted.url, `/api/sessions/${SESSION_ID}/stop`);
  assert.equal(posted.method, 'POST');

  // Button: muted stopping state, not the red square, and unclickable.
  assert.equal(DevChat._stopping, true);
  assert.equal(send().kind, 'stopping');

  // Transcript: exactly one live stopping row…
  const rows = stoppingRows(DevChat);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, 'Stopping the agent…');
  assert.equal(rows[0]._active, true, 'row is _active so it gets the arc spinner + elapsed ticker');
  assert.equal(rows[0].role, 'system');

  // …and the previously-spinning line froze, so only one thing spins.
  const ccRow = DevChat.messages.find((m) => m._slug === 'aaa111');
  assert.equal(ccRow._active, false);

  // The turn itself is still live until the server says otherwise.
  assert.equal(DevChat.isStreaming, true);
});

test('the `stopped` event splices the transient row and restores Send', async () => {
  const { DevChat, sandbox, document, send } = makeHarness();
  arriveMidTurn(DevChat);
  sandbox.fetch = async () => ({
    ok: true, status: 200, json: async () => ({ ok: true, stopped: true, phase: 'cc' }),
  });
  await DevChat._stopCurrentTurn();
  assert.equal(stoppingRows(DevChat).length, 1);

  // What every 'stopped' handler (POST-SSE / resumable / WS) ends up calling.
  DevChat._finishStreaming();

  assert.equal(DevChat._stopping, false);
  assert.equal(stoppingRows(DevChat).length, 0, 'transient row is gone');
  // The real, persisted "…stopped by @user." row is the server's job; the
  // user message and the frozen CC line are untouched.
  assert.equal(DevChat.messages.length, 2);

  assert.equal(send().kind, 'send');
});

test('a failed stop request explains itself and hands back the Stop button', async () => {
  const { DevChat, sandbox, document, send } = makeHarness();
  arriveMidTurn(DevChat);
  sandbox.fetch = async () => { throw new Error('network down'); };

  await DevChat._stopCurrentTurn();

  assert.equal(DevChat._stopping, false);
  assert.equal(stoppingRows(DevChat).length, 0, 'stopping row replaced, not left spinning');
  const last = DevChat.messages[DevChat.messages.length - 1];
  assert.equal(last.role, 'system');
  assert.match(last.content, /Couldn’t stop the agent/);

  // The turn is still running, so the red Stop must come back for a retry.
  assert.equal(DevChat.isStreaming, true);
  assert.equal(send().kind, 'stop');
});

test('a non-ok HTTP response takes the same failure path', async () => {
  const { DevChat, sandbox, document, send } = makeHarness();
  arriveMidTurn(DevChat);
  sandbox.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });

  await DevChat._stopCurrentTurn();

  assert.equal(stoppingRows(DevChat).length, 0);
  assert.match(DevChat.messages[DevChat.messages.length - 1].content, /Couldn’t stop the agent/);
  assert.equal(send().kind, 'stop');
});

test('"wrap-up cannot be stopped" switches to the finishing-up spinner', async () => {
  const { DevChat, sandbox, document, send } = makeHarness();
  arriveMidTurn(DevChat);
  sandbox.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, stopped: false, reason: 'wrap-up cannot be stopped' }),
  });

  await DevChat._stopCurrentTurn();

  assert.equal(DevChat._stopping, false);
  assert.equal(stoppingRows(DevChat).length, 0, 'no stop is coming, so nothing may keep spinning');
  assert.match(
    DevChat.messages[DevChat.messages.length - 1].content,
    /wrap-up can’t be interrupted/
  );

  assert.deepEqual(send(), { kind: 'busy', label: 'Finishing up', title: 'Finishing up…' },
    'mayor2 spinner state');
  assert.equal(DevChat.isStreaming, true);
});

test('"no active turn" tears down streaming and reconciles from the DB', async () => {
  const { DevChat, sandbox, document, send } = makeHarness();
  arriveMidTurn(DevChat);
  let reconciled = null;
  let streamingAtReconcile = null;
  DevChat._reconcileAfterFallbackDone = (id) => {
    reconciled = id;
    // The real _reconcileAfterFallbackDone bails while isStreaming is true
    // ("a newer turn owns the timeline"), so capture the flag as it sees
    // it — asserting only that we CALLED it would pass even when the
    // reload can never actually happen.
    streamingAtReconcile = DevChat.isStreaming;
  };
  sandbox.fetch = async () => ({
    ok: true, status: 200, json: async () => ({ ok: true, stopped: false, reason: 'no active turn' }),
  });

  await DevChat._stopCurrentTurn();

  assert.equal(stoppingRows(DevChat).length, 0);
  assert.equal(DevChat._stopping, false);
  assert.equal(reconciled, SESSION_ID, 'reloads so the timeline repaints as finished');
  assert.equal(streamingAtReconcile, false, 'streaming torn down first, or the reload no-ops');
  assert.equal(DevChat.isStreaming, false);
  // No `stopped` event is coming for a turn that already ended, so the
  // composer has to be usable again on our own.
  assert.equal(send().kind, 'send');
});

// #1378: the SAME 'no active turn' answer, but the session is still busy.
// That is what the server says for a turn adopted after a platform restart:
// it is very much alive, it just has no in-process stop handle. The teardown
// above must NOT happen here — it was the reported bug, because dropping the
// ladder is what made Force stop (the one path that ends such a turn)
// unreachable, leaving a Send button in front of a running agent.
test('"no active turn" keeps the ladder armed while the session is still busy', async () => {
  const { DevChat, sandbox, document, timers, send } = makeHarness();
  arriveMidTurn(DevChat);
  let reconciled = false;
  DevChat._reconcileAfterFallbackDone = () => { reconciled = true; };
  sandbox.fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).endsWith('/status')
      ? { busy: true, stoppable: false }
      : { ok: true, stopped: false, reason: 'no active turn', hasDurableTurn: true }),
  });

  await DevChat._stopCurrentTurn();

  assert.equal(reconciled, false, 'no reload — the turn has not ended');
  assert.equal(DevChat.isStreaming, true, 'the agent is still running');
  assert.equal(DevChat._stopping, true);
  assert.equal(stoppingRows(DevChat).length, 1, 'the stopping row stays up');
  assert.notEqual(send().kind, 'send');
  // The rungs are what matter: rung 2 is where Force stop is offered.
  assert.deepEqual(armedDelays(timers), [DevChat.STOPPING_SLOW_MS, DevChat.STOPPING_STUCK_MS]);
  assert.equal(fireRung(timers, DevChat.STOPPING_STUCK_MS), true);
  const row = DevChat._stoppingRow();
  assert.equal(row._forceOffered, true, 'Force stop is reachable');
});

// #1378: /status reports whether POST /stop can do anything at all. When it
// cannot, the composer must not paint a red Stop the click would not honour.
test('a not-stoppable turn paints a spinner instead of the red Stop', () => {
  const { DevChat, send } = makeHarness();
  DevChat.currentSession = { id: SESSION_ID, status: 'active' };
  DevChat.isStreaming = true;
  DevChat._setStreamingUI(true, null, { stoppable: false });

  assert.deepEqual(send(), {
    kind: 'busy',
    label: 'Working',
    title: 'This turn is still running but can’t be stopped from here',
  }, 'no red Stop');
  assert.equal(DevChat._streamingStoppable, false);

  // A repaint that only knows the phase must not silently re-offer Stop —
  // every one of those call sites now carries the remembered stoppability.
  DevChat._stopRequestFailed();
  assert.equal(send().kind, 'busy');

  // …and it is not sticky: the next turn starts stoppable again.
  DevChat._setStreamingUI(false);
  assert.equal(DevChat._streamingStoppable, true);
  DevChat._setStreamingUI(true, 'cc');
  assert.equal(send().kind, 'stop');
});

test('duplicate `stopping` events collapse into a single row', async () => {
  const { DevChat, sandbox } = makeHarness();
  arriveMidTurn(DevChat);
  sandbox.fetch = async () => ({
    ok: true, status: 200, json: async () => ({ ok: true, stopped: true, phase: 'cc' }),
  });

  // Own click, then the server's echo arriving on both the WS and the
  // primary SSE (seq dedup covers the common case, but a bus replay after a
  // reconnect can genuinely deliver it again).
  await DevChat._stopCurrentTurn();
  DevChat._enterStoppingState({ by: 'evan' });
  DevChat._enterStoppingState({ by: 'evan' });

  assert.equal(stoppingRows(DevChat).length, 1);
  assert.equal(DevChat._stopping, true);
});

test('a stop by someone else names them in the row', () => {
  const { DevChat } = makeHarness();
  arriveMidTurn(DevChat);

  DevChat._enterStoppingState({ by: 'dana' });

  const rows = stoppingRows(DevChat);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, '@dana is stopping the agent…');
});

test('_enterStoppingState is a no-op when nothing is streaming', () => {
  const { DevChat } = makeHarness();
  DevChat.currentSession = { id: SESSION_ID };
  DevChat.messages = [];
  DevChat.isStreaming = false;

  DevChat._enterStoppingState({ by: 'evan' });

  assert.equal(stoppingRows(DevChat).length, 0);
  assert.equal(DevChat._stopping, false);
});

test('a fresh send never inherits the previous turn stopping state', () => {
  const { DevChat, document, send } = makeHarness();
  arriveMidTurn(DevChat);
  // Reload-recovery sets the flag with no row to hang it on.
  DevChat._stopping = true;

  DevChat._clearStoppingState();
  DevChat._setStreamingUI(true, 'mayor1');

  assert.equal(send().kind, 'stop', 'a new turn is interruptible again');
});

// ── #937: the escalation ladder ─────────────────────────────────────────
//
// Before this, a stop that didn't land left the UI frozen forever: the
// button said "Stopping…", and the ONLY thing that ever changed was a 30s
// text mutation appending "(taking longer than usual)". In the reported
// incident that state held for 17m51s while the agent kept working, and
// the user had no way out. The ladder now retries, then offers Force stop.

test('rung 1 (15s): says so and silently re-POSTs the stop exactly once', async () => {
  const { DevChat, sandbox, timers } = makeHarness();
  arriveMidTurn(DevChat);

  const posts = [];
  sandbox.fetch = async (url, opts) => {
    posts.push({ url, method: opts?.method, body: opts?.body });
    return { ok: true, status: 200, json: async () => ({ ok: true, stopped: true, phase: 'cc' }) };
  };

  await DevChat._stopCurrentTurn();
  assert.equal(posts.length, 1, 'the click itself');
  // Both rungs armed, at the documented delays.
  assert.deepEqual(armedDelays(timers), [15000, 40000]);

  assert.equal(fireRung(timers, 15000), true);

  const row = DevChat.messages.find((m) => m._stopping);
  assert.match(row.content, /\(taking longer than usual\)$/);
  assert.equal(posts.length, 2, 'the stop is quietly asked again');
  assert.equal(posts[1].method, 'POST');
  assert.equal(posts[1].url, `/api/sessions/${SESSION_ID}/stop`);
  assert.equal(posts[1].body, undefined, 'a plain retry, not a force');
  // No Force stop yet — 15s is "slow", not "stuck".
  assert.ok(!row._forceOffered);
});

test('the 15s retry fires once however many stopping events arrive', async () => {
  const { DevChat, sandbox, timers } = makeHarness();
  arriveMidTurn(DevChat);

  const posts = [];
  sandbox.fetch = async (url, opts) => {
    posts.push({ url, method: opts?.method });
    return { ok: true, status: 200, json: async () => ({ ok: true, stopped: true, phase: 'cc' }) };
  };

  await DevChat._stopCurrentTurn();
  // The clicking tab also receives the server's echoed `stopping` on the
  // POST SSE, the global WS and a bus replay — three more deliveries.
  DevChat._enterStoppingState({ by: 'evan' });
  DevChat._enterStoppingState({ by: 'evan' });
  DevChat._enterStoppingState({ by: 'evan' });

  fireRung(timers, 15000);
  DevChat._retryStopRequest();
  DevChat._retryStopRequest();

  assert.equal(posts.length, 2, 'the click plus exactly one retry');
});

test('rung 2 (40s): admits it is stuck and offers Force stop', async () => {
  const { DevChat, sandbox, timers } = makeHarness();
  arriveMidTurn(DevChat);
  sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, stopped: true, phase: 'cc' }) });

  await DevChat._stopCurrentTurn();
  fireRung(timers, 15000);
  assert.equal(fireRung(timers, 40000), true);

  const row = DevChat.messages.find((m) => m._stopping);
  // The wording drops the euphemism — by now it genuinely is not coming.
  assert.equal(row.content, 'Still stopping. The agent isn’t responding.');
  // The flag renderMessages branches on to draw the in-row button.
  assert.equal(row._forceOffered, true);
  // Still exactly one row: escalation mutates, never appends.
  assert.equal(stoppingRows(DevChat).length, 1);
});

test('Force stop POSTs { force: true } and disables its own button', async () => {
  const { DevChat, sandbox, timers } = makeHarness();
  arriveMidTurn(DevChat);
  const posts = [];
  sandbox.fetch = async (url, opts) => {
    posts.push({ url, method: opts?.method, body: opts?.body });
    return { ok: true, status: 200, json: async () => ({ ok: true, stopped: true, forced: true }) };
  };

  await DevChat._stopCurrentTurn();
  fireRung(timers, 40000);

  const btn = { disabled: false, textContent: 'Force stop' };
  await DevChat._forceStopTurn(btn);

  const forced = posts[posts.length - 1];
  assert.equal(forced.url, `/api/sessions/${SESSION_ID}/stop`);
  assert.equal(forced.method, 'POST');
  assert.deepEqual(JSON.parse(forced.body), { force: true });
  // Double-click protection: the container teardown behind this is not
  // something to run twice.
  assert.equal(btn.disabled, true);
  assert.equal(btn.textContent, 'Forcing…');
});

test('a rejected Force stop hands back a usable UI', async () => {
  const { DevChat, sandbox, timers } = makeHarness();
  arriveMidTurn(DevChat);
  sandbox.fetch = async (url, opts) => (opts?.body
    // The server 409s a force with no stop pending — force is strictly a
    // second-order escape hatch, never a shortcut.
    ? { ok: false, status: 409, json: async () => ({ ok: false, reason: 'no stop pending' }) }
    : { ok: true, status: 200, json: async () => ({ ok: true, stopped: true, phase: 'cc' }) });

  await DevChat._stopCurrentTurn();
  fireRung(timers, 40000);
  await DevChat._forceStopTurn({ disabled: false, textContent: 'Force stop' });

  assert.equal(stoppingRows(DevChat).length, 0, 'the stuck row is cleared');
  assert.match(DevChat.messages[DevChat.messages.length - 1].content, /Couldn’t stop the agent/);
  assert.equal(DevChat._stopping, false);
  assert.equal(DevChat.isStreaming, true, 'the turn itself is untouched');
});

test('a landing stop disarms the whole ladder', async () => {
  const { DevChat, sandbox, timers } = makeHarness();
  arriveMidTurn(DevChat);
  sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, stopped: true, phase: 'cc' }) });

  await DevChat._stopCurrentTurn();
  fireRung(timers, 15000);
  assert.deepEqual(armedDelays(timers), [40000], 'rung 2 still pending');

  // The server's `stopped` lands — this is what the turn teardown calls.
  DevChat._finishStreaming();

  assert.equal(stoppingRows(DevChat).length, 0);
  assert.equal(DevChat._stopping, false);
  assert.equal(DevChat._stoppingSince, null);
  assert.equal(DevChat._stopRetried, false);
  assert.deepEqual(armedDelays(timers), [],
    'no rung may fire against a stop that already landed');
});

test('duplicate `stopped` events (force + the owning request) settle cleanly', async () => {
  // The force path announces the stop itself, because the request that
  // owns the turn may be the wedged thing being rescued. That request then
  // unwinds and announces it again. Both must collapse to one clean UI.
  const { DevChat, sandbox, timers, send } = makeHarness();
  arriveMidTurn(DevChat);
  sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, stopped: true }) });

  await DevChat._stopCurrentTurn();
  fireRung(timers, 40000);

  DevChat._finishStreaming();
  DevChat._finishStreaming();

  assert.equal(stoppingRows(DevChat).length, 0);
  assert.equal(DevChat._stopping, false);
  assert.equal(DevChat.isStreaming, false);
  assert.equal(send().kind, 'send');
});

// ── #937: reload / second-tab recovery ──────────────────────────────────

test('a tab joining a long-pending stop lands on the stuck rung immediately', () => {
  // The reload case. GET /status serves `stopping` + `stopRequestedAt`;
  // seeding the clock from the server is what stops a refreshed tab from
  // restarting a calm "Stopping…" that would never escalate — which is
  // exactly what the reporter would have seen on reload.
  const { DevChat, timers } = makeHarness();
  arriveMidTurn(DevChat);

  DevChat._enterStoppingState({ stopRequestedAt: Date.now() - 90000 });

  const row = DevChat.messages.find((m) => m._stopping);
  assert.equal(row.content, 'Still stopping. The agent isn’t responding.');
  assert.equal(row._forceOffered, true, 'Force stop is offered without waiting 40 more seconds');
  assert.deepEqual(armedDelays(timers), [], 'nothing left to wait for');
});

test('a tab joining a fresh stop still waits out both rungs', () => {
  const { DevChat, timers } = makeHarness();
  arriveMidTurn(DevChat);

  // A stop started by someone else (the harness user is `evan`).
  DevChat._enterStoppingState({ by: 'dana', stopRequestedAt: Date.now() });

  const row = DevChat.messages.find((m) => m._stopping);
  assert.equal(row.content, '@dana is stopping the agent…');
  assert.ok(!row._forceOffered, 'no premature escape hatch');
  const delays = armedDelays(timers);
  assert.equal(delays.length, 2);
  assert.ok(delays[0] >= 14990 && delays[0] <= 15000,
    'the slow rung accounts for only the clock time spent entering the state');
  assert.ok(delays[1] >= 39990 && delays[1] <= 40000,
    'the stuck rung accounts for only the clock time spent entering the state');
});

test('a later server timestamp re-arms the ladder on the already-showing row', () => {
  // The clicking tab starts its clock optimistically at click time; the
  // server's stamp is authoritative and arrives on the echoed `stopping`.
  // Both tabs must converge on one clock, or they escalate at different
  // moments and disagree about whether Force stop is available.
  const { DevChat, timers } = makeHarness();
  arriveMidTurn(DevChat);

  DevChat._enterStoppingState();
  assert.deepEqual(armedDelays(timers), [15000, 40000]);

  DevChat._enterStoppingState({ stopRequestedAt: Date.now() - 45000 });

  const row = DevChat.messages.find((m) => m._stopping);
  assert.equal(row._forceOffered, true);
  assert.equal(stoppingRows(DevChat).length, 1, 'still one row');
  assert.deepEqual(armedDelays(timers), [], 'the stale timers were replaced, not stacked');
});

// ── The four states, as markup ──────────────────────────────────────────
//
// Everything above reads the DESCRIPTOR, which is the branch `_setStreamingUI`
// used to paint by hand. This is the other half: that each descriptor still
// draws what the imperative writes drew, down to the class attribute — which
// is the thing `.dc-btn-stop { background: #dc2626 !important }` and its
// siblings key off.
test('each send state renders the class, the label and the glyph it always did', () => {
  const base = {
    venueNoteHtml: '', hidden: false, models: null, openRouter: null,
    drafts: { rows: [], busy: false }, attachError: null, placeholder: '',
    saveDraft: { hidden: true, disabled: true, title: '' }, shortcutHintHtml: '',
  };
  const btn = (send) => {
    const html = composerHtml({ ...base, send });
    return html.slice(html.indexOf('<button type="submit"'), html.indexOf('</form>'));
  };

  // The hand-written string, then the class `classList.add` appended. cva
  // emits `lead` first and className last, which is where both belong.
  const SHELL = 'class="dc-send-btn rounded-lg bg-violet-600 hover:bg-violet-500'
    + ' px-4 py-2 text-sm font-medium text-black transition-colors shrink-0';

  const idle = btn({ kind: 'send' });
  assert.ok(idle.includes(`${SHELL}"`), 'idle carries no state class');
  assert.match(idle, /aria-label="Send" title="Send"/);
  assert.match(idle, />Send<\/button>$/);

  const stop = btn({ kind: 'stop' });
  assert.ok(stop.includes(`${SHELL} dc-btn-stop"`));
  assert.match(stop, /aria-label="Stop" title="Stop"/);
  assert.match(stop, /<span class="dc-stop-icon" aria-hidden="true"><\/span>/);
  assert.doesNotMatch(stop, /disabled/, 'the red square is the one busy state you may press');

  const stopping = btn({ kind: 'stopping' });
  assert.ok(stopping.includes(`${SHELL} dc-btn-stopping"`));
  assert.match(stopping, /disabled=""/);
  assert.match(stopping, /aria-label="Stopping" title="Stopping…"/);
  assert.match(stopping, /<span class="dc-send-spinner"><\/span><span class="dc-btn-stopping-label">Stopping…<\/span>/);

  const busy = btn({ kind: 'busy', label: 'Working', title: 'nope' });
  assert.ok(busy.includes(`${SHELL} dc-btn-streaming"`));
  assert.match(busy, /disabled=""/);
  assert.match(busy, /aria-label="Working" title="nope"/);
  assert.match(busy, /<span class="dc-send-spinner"><\/span><\/button>$/, 'a spinner and nothing else');
});
