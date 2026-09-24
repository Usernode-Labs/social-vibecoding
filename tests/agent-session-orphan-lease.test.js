'use strict';

// A Mayor turn whose process died (a platform restart while its build ran)
// left its conversation leased and its screens on "Thinking" with a stop
// button that answered no_active_turn, until the stale window ran out and
// nothing told the screens even then (production agent session 3).
//
//   1. Handing back: a stale lease is cleared and the dead turn's `done` is
//      sent in its place, never while this process runs a turn there.
//   2. Recovery hands back the conversation whose change it finished, and
//      tries again once a lease still inside the window goes stale.
//   3. The screen's stop settles from the server when nothing was running.
//
// The lease SQL itself runs against Postgres in
// tests/agent-sessions-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');

const agentTurn = require('../src/services/mayor/agent-turn');

function fakes({ stale = new Set(), conversations = [] } = {}) {
  const calls = { released: [], notified: [], published: [] };
  const deps = {
    agentSessions: {
      TURN_LEASE_STALE_MINUTES: 3,
      releaseStaleTurnLease: async (_pool, args) => {
        calls.released.push(args);
        return stale.delete(args.agentSessionId);
      },
      conversationsOfChange: async () => conversations,
    },
    notifyUser: (userId, payload) => calls.notified.push([userId, payload]),
    sessionBus: { publish: (key, event) => calls.published.push([key, event]) },
  };
  return { deps, calls, stale };
}

test('a stale lease is handed back with the done its dead turn never sent', async () => {
  const { deps, calls } = fakes({ stale: new Set([5]) });
  assert.equal(await agentTurn.handBackOrphanedTurn({ pool: {}, agentSessionId: 5, userId: 7, deps }), true);
  assert.deepEqual(calls.released, [{ agentSessionId: 5, userId: 7, finished: false }]);
  assert.deepEqual(calls.notified, [[7, { type: 'agent_session_changed', agentSessionId: 5, busy: false }]]);
  assert.equal(calls.published.length, 1);
  const [key, event] = calls.published[0];
  assert.equal(key, agentTurn.busKey(5));
  assert.equal(event.type, 'done');
  assert.match(event._seq, /^orphan-/, 'a sequence no live turn uses, so a screen does not drop it as seen');

  assert.equal(await agentTurn.handBackOrphanedTurn({ pool: {}, agentSessionId: 5, userId: 7, deps }), false,
    'a live lease, or none, is left alone');
  assert.equal(calls.published.length, 1);
});

test('a turn running in this process is never handed back', async () => {
  const { deps, calls } = fakes({ stale: new Set([6]) });
  agentTurn._stopRegistry.set(6, { phase: 'cc' });
  try {
    assert.equal(await agentTurn.handBackOrphanedTurn({ pool: {}, agentSessionId: 6, userId: 7, deps }), false);
    assert.equal(calls.released.length, 0, 'not even asked of the database');
  } finally {
    agentTurn._stopRegistry.delete(6);
  }
});

test('recovery hands back its change\'s conversations, and waits out a lease still in the window', async () => {
  const { deps, calls, stale } = fakes({
    stale: new Set([5]),
    conversations: [{ agentSessionId: 5, userId: 7 }, { agentSessionId: 8, userId: 7 }],
  });
  await agentTurn.handBackAfterRecovery({ pool: {}, changeId: 4834, deps, retryMs: 10 });
  assert.deepEqual(calls.released.map((r) => [r.agentSessionId, r.finished]), [[5, true], [8, true]],
    'the wrap-up was posted, so each finished something');
  assert.equal(calls.published.length, 1, 'conversation 8 is still inside the stale window');

  stale.add(8);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(calls.released.map((r) => r.agentSessionId), [5, 8, 8], 'tried again once');
  assert.deepEqual(calls.published.map(([key]) => key), [agentTurn.busKey(5), agentTurn.busKey(8)]);
});

test('the default retry waits past the stale window', () => {
  const agentSessions = require('../src/services/agent-sessions');
  assert.ok(agentSessions.TURN_LEASE_STALE_MINUTES <= 5, 'a dead turn\'s conversation looks busy for minutes, not twenty');
  assert.ok(agentTurn.LEASE_RENEW_MS * 5 < agentSessions.TURN_LEASE_STALE_MINUTES * 60_000,
    'a live turn can miss several renewals before it is taken for dead');
});

function withStore(respond, run) {
  globalThis.window = { location: { hash: '' }, App: { setHeaderTitle() {} }, UsernodeReact: {} };
  globalThis.EventSource = class { close() {} };
  const requests = [];
  globalThis.fetch = async (url, opts = {}) => {
    requests.push([opts.method || 'GET', url]);
    return { ok: true, status: 200, json: async () => respond(url, opts) };
  };
  return Promise.resolve()
    .then(() => run(loadTsx('frontend/src/features/agent-session/store.ts'), requests))
    .finally(() => {
      delete globalThis.window;
      delete globalThis.fetch;
      delete globalThis.EventSource;
    });
}

const SESSION = {
  id: 3, title: 'RSS Reader', status: 'open', focusApp: null, focusContext: {}, activeChange: null,
  doneUnseen: false, lastActivityAt: null, createdAt: null,
};

test('stop on a conversation with nothing running settles the screen from the server', async () => {
  let busy = true;
  await withStore((url) => {
    if (/\/stop$/.test(url)) return { ok: true, stopped: false, reason: 'no_active_turn', released: true };
    if (/\/messages\?/.test(url)) return { messages: [], nextAfter: null };
    if (/\/actions$/.test(url)) return { actions: [] };
    return { session: { ...SESSION, busy }, turn: null };
  }, async (store) => {
    await store.openAgentSession({ id: 3, host: 'messages' });
    assert.equal(store.getAgentSessionState().turn.running, true, 'opened on a lease: Thinking');

    busy = false;
    await store.stopAgentTurn();
    const { turn, session } = store.getAgentSessionState();
    assert.equal(turn.running, false, 'no Thinking left behind');
    assert.equal(turn.stopping, false, 'and no stop stuck mid-press');
    assert.equal(session.busy, false);
  });
});

test('a lease still live elsewhere keeps the screen working, but not stuck on stopping', async () => {
  await withStore((url) => {
    if (/\/stop$/.test(url)) return { ok: true, stopped: false, reason: 'no_active_turn', released: false };
    if (/\/messages\?/.test(url)) return { messages: [], nextAfter: null };
    if (/\/actions$/.test(url)) return { actions: [] };
    return { session: { ...SESSION, busy: true }, turn: null };
  }, async (store) => {
    await store.openAgentSession({ id: 3, host: 'messages' });
    await store.stopAgentTurn();
    const { turn } = store.getAgentSessionState();
    assert.equal(turn.running, true, 'its own done ends it');
    assert.equal(turn.stopping, false);
  });
});
