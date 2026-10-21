'use strict';

// A Mayor turn whose process died (a platform restart while its build ran)
// left its conversation leased and its screens on "Thinking" with a stop
// button that answered no_active_turn, until the stale window ran out and
// nothing told the screens even then (production agent session 3).
//
//   1. A recovered run (its turn's work item carried it on after its process
//      went: services/turns.js) tells every conversation whose change it ran
//      that it is over; the claim is the turn machine's to release. While the
//      recovered build runs, it is the conversation's running dispatch.
//   2. The screen's stop settles from the server when nothing was running.
//
// The claim SQL itself runs against Postgres in
// tests/agent-sessions-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');
const { withStateRead } = require('./lib/agent-session-state-read');

const agentTurn = require('../src/services/mayor/agent-turn');

function fakes({ conversations = [] } = {}) {
  const calls = { notified: [], published: [] };
  const deps = {
    agentSessions: { conversationsOfChange: async () => conversations },
    notifyUser: (userId, payload) => calls.notified.push([userId, payload]),
    sessionBus: { publish: (key, event) => calls.published.push([key, event]) },
  };
  return { deps, calls };
}

test('a recovered run tells its change\'s conversations it is over; their claims are their turn machine\'s', async () => {
  const { deps, calls } = fakes({
    conversations: [{ agentSessionId: 5, userId: 7 }, { agentSessionId: 8, userId: 7 }],
  });
  await agentTurn.handBackAfterRecovery({ pool: {}, changeId: 4834, deps });
  assert.deepEqual(calls.published.map(([key, event]) => [key, event.type]),
    [[agentTurn.busKey(5), 'done'], [agentTurn.busKey(8), 'done']], 'the run their screens follow is over');
  assert.match(calls.published[0][1]._seq, /^recovered-/, 'a sequence no live turn uses, so a screen does not drop it as seen');
  assert.deepEqual(calls.notified.map(([userId, payload]) => [userId, payload.agentSessionId, payload.busy]),
    [[7, 5, false], [7, 8, false]], 'the lists stop marking both as working');
  assert.equal(typeof agentTurn.handBackOrphanedTurn, 'undefined', 'no claim is handed back by recovery: the turn machine releases it');
});

test('a conversation whose Mayor turn runs in this process answers for itself', async () => {
  const { deps, calls } = fakes({ conversations: [{ agentSessionId: 6, userId: 7 }] });
  agentTurn._stopRegistry.set(6, { phase: 'cc' });
  try {
    await agentTurn.handBackAfterRecovery({ pool: {}, changeId: 4834, deps });
    assert.deepEqual(calls.published, []);
  } finally {
    agentTurn._stopRegistry.delete(6);
  }
});

test('a recovered build on the active change is the conversation\'s running dispatch', () => {
  const busy = new Set([50]);
  const deps = { isChangeBusy: (changeId) => busy.has(changeId) };
  assert.deepEqual(agentTurn.recoveredRunState(3, 50, deps), { phase: 'cc', stopping: false, changeId: 50 });
  assert.equal(agentTurn.recoveredRunState(3, 51, deps), null, 'nothing running on the change');
  assert.equal(agentTurn.recoveredRunState(3, null, deps), null, 'no active change');
  agentTurn._stopRegistry.set(3, { phase: 'cc' });
  try {
    assert.equal(agentTurn.recoveredRunState(3, 50, deps), null, 'a live Mayor turn answers for itself');
  } finally {
    agentTurn._stopRegistry.delete(3);
  }
});

test('a change busy only with its visual change preview is not the coding agent working', () => {
  const deps = { isChangeBusy: () => true, activeTurnMode: (changeId) => (changeId === 50 ? 'shots' : 'build') };
  assert.equal(agentTurn.recoveredRunState(3, 50, deps), null, 'the conversation shows the capture instead');
  assert.deepEqual(agentTurn.recoveredRunState(3, 51, deps), { phase: 'cc', stopping: false, changeId: 51 });
});

test('a running turn reports when its work started: the build once dispatched, else the turn', () => {
  const handle = { phase: 'mayor', startedAt: 1_000, buildStartedAt: null, change: null };
  agentTurn._stopRegistry.set(4, handle);
  try {
    assert.equal(agentTurn.turnState(4).startedAt, 1_000);
    Object.assign(handle, { phase: 'cc', buildStartedAt: 5_000, change: { changeId: 50 } });
    assert.equal(agentTurn.turnState(4).startedAt, 5_000);
    handle.phase = 'mayor2';
    assert.equal(agentTurn.turnState(4).startedAt, 5_000, 'the wrap-up keeps the build\'s clock');
  } finally {
    agentTurn._stopRegistry.delete(4);
  }
});


function withStore(respond, run) {
  globalThis.window = { location: { hash: '' }, App: { setHeaderTitle() {} }, UsernodeReact: {} };
  globalThis.EventSource = class { close() {} };
  const requests = [];
  globalThis.fetch = withStateRead(async (url, opts = {}) => {
    requests.push([opts.method || 'GET', url]);
    return { ok: true, status: 200, json: async () => respond(url, opts) };
  });
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

test('a screen opened or reconnected mid-build counts from the dispatch, not from its arrival', async () => {
  const dispatchedAt = Date.now() - 40 * 60_000;
  await withStore((url) => {
    if (/\/messages\?/.test(url)) return { messages: [], nextAfter: null };
    if (/\/actions$/.test(url)) return { actions: [] };
    return {
      session: { ...SESSION, busy: true, activeChange: { id: 50 } },
      turn: { phase: 'cc', stopping: false, changeId: 50, startedAt: dispatchedAt },
    };
  }, async (store) => {
    await store.openAgentSession({ id: 3, host: 'messages' });
    assert.equal(store.getAgentSessionState().turn.startedAt, dispatchedAt);

    const redispatchedAt = dispatchedAt + 60_000;
    store.handleEvent(3, { type: 'phase', phase: 'cc', startedAt: redispatchedAt, _seq: 'x-1' });
    assert.equal(store.getAgentSessionState().turn.startedAt, redispatchedAt, 'the phase event carries the build\'s start');
  });
});
