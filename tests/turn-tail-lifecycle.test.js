// The post-agent TAIL, and why a durable record has to span it.
//
// A dispatch turn has two halves. The first — `claude` running inside the
// worker — was always restart-proof: its output goes to a journal file and
// chat_sessions.active_turn points at it, so boot adoption replays it.
//
// The second half is the TAIL: heal the push, open/update the PR, hand the
// staging preview to the preview machine, post the agent's summary card,
// re-issue the Mayor's wrap-up. That stretch used to be MINUTES long — it
// built the preview inline, and a self-app build spends ~4:45 just cloning
// the platform database — and it ran with active_turn already cleared,
// because execInWorker's `finally` dropped the record the moment the
// journal was consumed.
//
// Production consequence (session 2954): an unrelated proposal merged to
// main, the self-app deploy replaced the platform process mid-preview-build,
// and boot adoption saw a running container with no exec and no record. It
// took the "warm-idle, nothing to do" branch, and the dev chat kept
// "Building staging preview..." as its last word forever — no card, no
// summary, no error, no spinner. The owner eventually typed "continue",
// which bought a second full build turn for a commit that was already
// pushed.
//
// These tests pin the fix:
//   1. holdTurnRecord keeps the record (stamped phase 'tail') AND the
//      journal, so the existing resume path can pick the tail up.
//   2. finishTurn is what actually ends a turn, and it removes both.
//   3. Milestone stamps merge, never clobber, and can never resurrect a
//      released record.
//   4. finalizeRecoveredTurn honours those milestones, so a resumed tail
//      doesn't re-post cards or re-fire events, and a preview the machine
//      already serves for the commit is announced as up, not as building.
//
// Run with: node --test tests/turn-tail-lifecycle.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Load worker.js against a fake docker + logger + pg pool, so nothing
// touches a daemon or a database. Returns the module, the recorded docker
// execs, and the recorded SQL.
function loadWorker({
  failTransitions = false,
  vanishOnTransition = false,
  initialActiveTurn = {
    turnId: 'logical-1', phase: 'executing', backend: 'codex_openrouter',
    turnUuid: 'attempt-1', logicalTurnId: 'logical-1', attemptNumber: 1,
    journal: '/home/node/.claude/turn-777.log', tail: {},
  },
} = {}) {
  const ids = {
    docker: require.resolve('../src/services/docker'),
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    subject: require.resolve('../src/services/worker'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const execs = [];
  const events = [];
  const realDocker = require('../src/services/docker');
  stub(ids.docker, {
    ...realDocker,
    execFileAsync: async (cmd, args, opts) => {
      execs.push({ cmd, args, opts });
      events.push({ type: 'docker', cmd, args, opts });
      return { stdout: '', stderr: '' };
    },
  });
  const noop = () => {};
  stub(ids.logger, { info: noop, warn: noop, error: noop, debug: noop });

  const queries = [];
  let activeTurn = initialActiveTurn;
  stub(ids.pool, {
    getPool: () => ({
      query: async (sql, params = []) => {
        const text = String(sql);
        queries.push({ sql: text, params });
        events.push({ type: 'query', sql: text, params });
        if (/SELECT active_turn/.test(text)) {
          return { rows: [{ active_turn: activeTurn }], rowCount: 1 };
        }
        if (/SET active_turn = active_turn \|\| \$3::jsonb/.test(text)) {
          if (vanishOnTransition) {
            activeTurn = null;
            return { rows: [], rowCount: 0 };
          }
          if (failTransitions || !activeTurn) return { rows: [], rowCount: 0 };
          const patch = JSON.parse(params[2]);
          activeTurn = { ...activeTurn, ...patch };
          return { rows: [{ active_turn: activeTurn }], rowCount: 1 };
        }
        if (/SET active_turn = jsonb_set/.test(text)) {
          if (failTransitions || !activeTurn) return { rows: [], rowCount: 0 };
          activeTurn = {
            ...activeTurn,
            tail: { ...(activeTurn.tail || {}), ...JSON.parse(params[1]) },
          };
          return { rows: [{ active_turn: activeTurn }], rowCount: 1 };
        }
        if (/SET active_turn = NULL/.test(text)) {
          if (failTransitions || !activeTurn || activeTurn.phase !== 'cleanup_pending') {
            return { rows: [], rowCount: 0 };
          }
          activeTurn = null;
          return { rows: [{ id: params[0] }], rowCount: 1 };
        }
        return { rows: [], rowCount: failTransitions ? 0 : 1 };
      },
    }),
  });

  delete require.cache[ids.subject];
  const worker = require('../src/services/worker');

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k];
      else delete require.cache[id];
    }
  };
  return { worker, execs, queries, events, getActiveTurn: () => activeTurn, restore };
}

// ── 1. The record's lifetime ────────────────────────────────────────────

for (const alreadyCleared of [false, true]) {
  test(`Kubernetes finishTurn ${alreadyCleared ? 'removes only the old journal after release' : 'removes owned files before releasing the turn'}`, async (t) => {
    const previous = process.env.WORKER_RUNTIME;
    process.env.WORKER_RUNTIME = 'kubernetes';
    const fx = loadWorker(alreadyCleared ? { initialActiveTurn: null } : {});
    t.after(() => {
      fx.restore();
      if (previous === undefined) delete process.env.WORKER_RUNTIME;
      else process.env.WORKER_RUNTIME = previous;
    });
    const calls = [];
    t.mock.method(require('../src/services/kubernetes'), 'execInWorker', async (_config, runtime, command, input, options) => {
      calls.push({ runtime, command, input, options });
      assert.equal(fx.getActiveTurn()?.phase || null, alreadyCleared ? null : 'cleanup_pending');
      return { stdout: '', stderr: '' };
    });
    const journal = '/home/node/.claude/turn-777.log';
    assert.equal(await fx.worker.finishTurn(2954, { journal, turnId: 'logical-1' }), true);
    assert.equal(fx.execs.length, 0, 'Kubernetes cleanup must not invoke Docker');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].runtime, 'sv-worker-s2954');
    // #4575: the turn's own prompt files too, named by its id.
    const own = fx.worker.turnPromptPaths('logical-1');
    assert.deepEqual(calls[0].command, ['rm', '-f', journal, ...(alreadyCleared ? [] : [
      fx.worker.TURN_PROMPT_PATH, fx.worker.TURN_SYSTEM_PROMPT_PATH, fx.worker.TURN_RESUME_FALLBACK_PROMPT_PATH,
      own.prompt, own.system, own.resumeFallback,
    ])]);
    assert.equal(calls[0].options.timeoutMs, 5000);
    assert.equal(fx.getActiveTurn(), null);
  });
}

test('markTurnTail advances the owned turn to tail_pending with seed milestones', async () => {
  const { worker, queries, getActiveTurn, restore } = loadWorker();
  try {
    await worker.markTurnTail(
      2954,
      { sha: 'dcdd174', pushOk: true },
      { turnId: 'logical-1' },
    );
    const { sql, params } = queries.find((q) => /SET active_turn = active_turn \|\|/.test(q.sql));
    assert.match(sql, /UPDATE chat_sessions/);
    assert.match(sql, /active_turn IS NOT NULL/);
    assert.equal(params[0], 2954);
    assert.equal(params[1], 'logical-1');
    const patch = JSON.parse(params[2]);
    assert.equal(patch.phase, 'tail_pending');
    assert.ok(patch.tailStartedAt);
    assert.deepEqual(patch.tail, { sha: 'dcdd174', pushOk: true });
    assert.equal(getActiveTurn().phase, 'tail_pending');
  } finally { restore(); }
});

test('noteTailMilestone merges one key and cannot revive a released record', async () => {
  const { worker, queries, restore } = loadWorker();
  try {
    await worker.noteTailMilestone(
      2954,
      { completionRowPosted: true },
      { turnId: 'logical-1' },
    );
    assert.equal(queries.length, 1);
    const { sql, params } = queries[0];
    assert.match(sql, /COALESCE\(active_turn->'tail', '\{\}'::jsonb\) \|\| \$2::jsonb/);
    assert.match(sql, /WHERE id = \$1\s+AND active_turn IS NOT NULL/,
      'a late stamp on a finished turn is a no-op, not an insert');
    assert.deepEqual(JSON.parse(params[1]), { completionRowPosted: true });

    // Nothing to record → no query at all (the wrap-up site calls this
    // unconditionally, and it must stay free when there's nothing to say).
    queries.length = 0;
    await worker.noteTailMilestone(2954, null);
    await worker.noteTailMilestone(2954, 'nope');
    assert.equal(queries.length, 0);
  } finally { restore(); }
});

test('markTurnRetryPending keeps the durable phase in tail_pending', async () => {
  const { worker, queries, getActiveTurn, restore } = loadWorker({
    initialActiveTurn: {
      turnId: 'logical-1', phase: 'tail_pending', backend: 'codex_openrouter',
      turnUuid: 'attempt-1', logicalTurnId: 'logical-1', attemptNumber: 1,
      journal: '/home/node/.claude/turn-777.log', tail: {},
    },
  });
  try {
    await worker.markTurnRetryPending(2954, {
      turnUuid: 'attempt-1', logicalTurnId: 'logical-1', attemptNumber: 1,
    });
    assert.equal(queries.length, 1);
    const { sql, params } = queries[0];
    assert.match(sql, /active_turn = active_turn \|\| \$3::jsonb/);
    assert.match(sql, /active_turn->>'turnId' = \$2/);
    assert.match(sql, /active_turn->>'turnUuid' = \$4/);
    const patch = JSON.parse(params[2]);
    assert.equal(patch.phase, 'tail_pending');
    assert.equal(patch.retryFresh, true);
    assert.equal(patch.logicalTurnId, 'logical-1');
    assert.equal(params[3], 'attempt-1');
    assert.equal(getActiveTurn().phase, 'tail_pending');
  } finally { restore(); }
});

test('finishTurn removes shared files while cleanup ownership still blocks dispatch', async () => {
  const { worker, execs, queries, events, restore } = loadWorker();
  try {
    await worker.finishTurn(2954, {
      turnId: 'logical-1',
      journal: '/home/node/.claude/turn-777.log',
    });

    const rm = execs.find((c) => c.args.includes('rm'));
    assert.ok(rm, 'the journal a holdTurnRecord caller kept is removed here');
    assert.ok(rm.args.includes('/home/node/.claude/turn-777.log'));
    assert.ok(rm.args.includes(worker.TURN_PROMPT_PATH));
    assert.ok(rm.args.includes(worker.TURN_SYSTEM_PROMPT_PATH));
    assert.ok(rm.args.includes(worker.TURN_RESUME_FALLBACK_PROMPT_PATH));
    assert.ok(rm.args.includes('usernode-worker-2954'),
      'targets the session\'s own worker container');

    const cleared = queries.find((q) => /active_turn = NULL/.test(q.sql));
    assert.ok(cleared, 'the durable record is dropped');
    assert.deepEqual(cleared.params, [2954, 'logical-1']);

    const cleanupIdx = events.findIndex((event) => event.type === 'query'
      && /active_turn = active_turn \|\|/.test(event.sql));
    const rmIdx = events.findIndex((event) => event.type === 'docker'
      && event.args.includes('rm'));
    const clearIdx = events.findIndex((event) => event.type === 'query'
      && /active_turn = NULL/.test(event.sql));
    assert.ok(cleanupIdx < rmIdx && rmIdx < clearIdx,
      'cleanup_pending is published before shared-file removal and cleared only afterwards');
  } finally { restore(); }
});

test('idempotent finish may remove a unique journal but never the shared prompt', async () => {
  const { worker, execs, queries, getActiveTurn, restore } = loadWorker({
    initialActiveTurn: null,
  });
  try {
    const cleared = await worker.finishTurn(2954, {
      turnId: 'logical-old',
      journal: '/home/node/.claude/turn-old.log',
    });
    assert.equal(cleared, true);
    assert.equal(getActiveTurn(), null);
    assert.ok(!queries.some((q) => /active_turn = NULL/.test(q.sql)));
    const rm = execs.find((c) => c.args.includes('rm'));
    assert.ok(rm.args.includes('/home/node/.claude/turn-old.log'));
    assert.ok(!rm.args.includes(worker.TURN_PROMPT_PATH),
      'a stale/idempotent owner cannot delete a replacement turn\'s shared prompt');
    assert.ok(!rm.args.includes(worker.TURN_SYSTEM_PROMPT_PATH),
      'a stale/idempotent owner cannot delete replacement system context');
    assert.ok(!rm.args.includes(worker.TURN_RESUME_FALLBACK_PROMPT_PATH),
      'a stale/idempotent owner cannot delete a replacement resume fallback');
  } finally { restore(); }
});

test('finishTurn does not claim shared cleanup when the row vanished during CAS', async () => {
  const { worker, execs, getActiveTurn, restore } = loadWorker({
    vanishOnTransition: true,
  });
  try {
    const cleared = await worker.finishTurn(2954, {
      turnId: 'logical-1',
      journal: '/home/node/.claude/turn-777.log',
    });
    assert.equal(cleared, true);
    assert.equal(getActiveTurn(), null);
    const rm = execs.find((c) => c.args.includes('rm'));
    assert.ok(rm.args.includes('/home/node/.claude/turn-777.log'));
    assert.ok(!rm.args.includes(worker.TURN_PROMPT_PATH),
      'an already-cleared CAS result never grants ownership of the shared path');
    assert.ok(!rm.args.includes(worker.TURN_SYSTEM_PROMPT_PATH),
      'an already-cleared CAS result never grants system-context ownership');
    assert.ok(!rm.args.includes(worker.TURN_RESUME_FALLBACK_PROMPT_PATH),
      'an already-cleared CAS result never grants fallback-prompt ownership');
  } finally { restore(); }
});

test('finishTurn with an exact turn id needs no journal and still owns prompt cleanup', async () => {
  const { worker, execs, queries, restore } = loadWorker({
    initialActiveTurn: { turnId: 'logical-1', phase: 'tail_pending' },
  });
  try {
    // Second call for the same turn, or a turn that never held a record.
    await worker.finishTurn(2954, { turnId: 'logical-1' });
    const rm = execs.find((c) => c.args.includes('rm'));
    assert.ok(rm, 'the exact owner still removes the shared prompt');
    assert.ok(rm.args.includes(worker.TURN_PROMPT_PATH));
    assert.ok(rm.args.includes(worker.TURN_SYSTEM_PROMPT_PATH));
    assert.ok(rm.args.includes(worker.TURN_RESUME_FALLBACK_PROMPT_PATH));
    assert.ok(!rm.args.some((arg) => /turn-.*\.log$/.test(arg)),
      'no journal path is invented');
    assert.ok(queries.some((q) => /active_turn = NULL/.test(q.sql)));
  } finally { restore(); }
});

test('finishTurn retains the journal when the durable clear does not land', async () => {
  const { worker, execs, queries, restore } = loadWorker({ failTransitions: true });
  try {
    const cleared = await worker.finishTurn(2954, {
      turnId: 'logical-1',
      journal: '/home/node/.claude/turn-777.log',
    });
    assert.equal(cleared, false);
    assert.ok(queries.some((q) => /SET active_turn = active_turn \|\|/.test(q.sql)),
      'the durable cleanup transition was attempted');
    assert.equal(execs.filter((c) => c.args.includes('rm')).length, 0,
      'the replay source survives for the next recovery');
  } finally { restore(); }
});

test('finishTurn refuses to infer ownership from the session current record', async () => {
  const { worker, execs, queries, getActiveTurn, restore } = loadWorker();
  try {
    const cleared = await worker.finishTurn(2954);
    assert.equal(cleared, false);
    assert.equal(getActiveTurn().turnId, 'logical-1');
    assert.ok(!queries.some((q) => /active_turn = NULL/.test(q.sql)));
    assert.equal(execs.filter((c) => c.args.includes('rm')).length, 0);
  } finally { restore(); }
});

test('isTailPhase classifies a held tail, tolerating a string-encoded column', () => {
  const { worker, restore } = loadWorker();
  try {
    assert.equal(worker.isTailPhase(null), false);
    assert.equal(worker.isTailPhase({ mode: 'build', journal: '/j' }), false,
      'a mid-exec record is not a tail');
    assert.equal(worker.isTailPhase({ phase: 'tail' }), true);
    assert.equal(worker.isTailPhase(JSON.stringify({ phase: 'tail' })), true);
    assert.equal(worker.isTailPhase('not json'), false);
    assert.equal(worker.TURN_PHASE_TAIL, 'tail_pending');
  } finally { restore(); }
});

// ── 2. execInWorker's two contracts, read off the source ────────────────
//
// The dispatch itself needs a live docker daemon, so pin the branch
// structurally: the journal delete and the clear are both gated on
// holdTurnRecord, and the tail branch hands off via markTurnTail.

const WORKER_SRC = fs.readFileSync(
  path.join(__dirname, '../src/services/worker.js'), 'utf8'
);

test('execInWorker keeps the journal and the record when holdTurnRecord is set', () => {
  assert.match(WORKER_SRC, /if \(!holdTurnRecord && state\.execExitSeen && !state\.fatalError\)/,
    'the journal delete is skipped for a tail-holding caller');
  assert.match(WORKER_SRC, /if \(holdTurnRecord\) \{[\s\S]{0,600}await markTurnTail\(sessionId,/,
    'the tail branch stamps the record instead of clearing it');
  assert.match(WORKER_SRC, /\} else \{\s*\n\s*await finishTurn\(sessionId, \{ turnId: durableTurnId, journal \}\);/,
    'the non-holding contract uses the same identity-safe cleanup path');
  // The seed milestones are what let a dead-worker recovery tell "code
  // landed" from "nothing landed" without a container to ask.
  assert.match(WORKER_SRC, /sha: execState\.sha \|\| null, pushOk: execState\.pushOk === true/);
});

// ── 3. Both dispatch tools opt in and release ───────────────────────────

// #2779: the dev-chat turn moved from routes/sessions.js to services/mayor/turn.js.
const SESSIONS_SRC = ['../src/services/mayor/turn.js', '../src/routes/sessions.js']
  .map((rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8')).join('\n');

test('build and scout keep one owner through their complete tail', () => {
  const holds = SESSIONS_SRC.match(/holdTurnRecord: true/g) || [];
  assert.equal(holds.length, 2,
    'only the live build and scout dispatches hold their tail record');

  const deferredCallers = SESSIONS_SRC.match(/deferTurnCleanup: true/g) || [];
  assert.equal(deferredCallers.length, 3,
    'Mayor-dispatched build/scout and the direct OpenRouter path retain ownership through their wrap-up');

  const localCleanupGates = SESSIONS_SRC.match(
    /if \(durableTailComplete && durableTurnId && \(!deferTurnCleanup \|\| headless\)\)/g
  ) || [];
  assert.equal(localCleanupGates.length, 2,
    'headless/local tails clean up only after every required tool-side effect');
  assert.match(SESSIONS_SRC,
    /wrapUpPosted: true[\s\S]{0,500}worker\.finishTurn\(session\.id, \{ turnId: toolResult\.turnId \}\)/,
    'interactive cleanup happens only after the durable phase-2 milestone');

  // Markerless retries release attempt one, while a missing-thread retry
  // marks its existing tail before the atomic attempt-two registration.
  // Both callback copies check the
  // user stop before and after the awaited transition, and only then clear
  // the prior attempt's pending-stop marker.
  const retryCallbacks = SESSIONS_SRC.match(/prepareRetry: async \(retry\) => \{/g) || [];
  assert.equal(retryCallbacks.length, 2, 'both dispatch tools use stop-aware retry preparation');
  const durableFresh = SESSIONS_SRC.match(/await worker\.markTurnRetryPending\(session\.id,/g) || [];
  assert.equal(durableFresh.length, 2, 'both prepare the one live same-process fresh retry');
  const stopChecks = SESSIONS_SRC.match(/if \(stopPendingFor\(stopHandle\)\) return false;/g) || [];
  assert.equal(stopChecks.length, 4, 'each retry boundary checks for a stop on both sides of its await');

  assert.match(SESSIONS_SRC,
    /if \(!durableTailComplete\) \{[\s\S]{0,200}retaining durable turn for recovery/,
    'a thrown tool-side tail retains its exact durable owner');

  // The sync is the proposal machine's work (branch.sync): its turn runs
  // through durable-turn.runTurn, which holds the record (what dispatch is
  // handed) so a restart follows the turn the worker still runs, and
  // releases it (worker.finishTurn) once the turn's outcome is recorded.
  const SYNC_SRC = fs.readFileSync(
    path.join(__dirname, '../src/services/sync-main.js'), 'utf8'
  );
  assert.match(SYNC_SRC, /deps\.durableTurn\.runTurn\(steps, 'sync',/, 'the sync turn is a durable turn');
  assert.match(SYNC_SRC, /\.\.\.\(extra\.holdTurnRecord \? \{ holdTurnRecord: true \} : \{\}\)/, 'held only as durable-turn asks');
});

test('every non-idempotent tail step stamps a milestone', () => {
  // The preview is no longer one of them: the tail hands the commit to the
  // preview machine, which answers a second hand-off of the same head with
  // 'same_head' instead of building it again.
  for (const key of [
    'prOpenedEventRecorded', 'votesResetFor',
    'completionRowPosted', 'wrapUpPosted',
  ]) {
    assert.match(SESSIONS_SRC, new RegExp(`noteTailMilestone\\([\\s\\S]{0,200}${key}`),
      `${key} must be stamped when that step lands`);
  }
  const explicitLiveOwners = SESSIONS_SRC.match(
    /noteTailMilestone\([\s\S]{0,240}?\{ turnId: durableTurnId \}[\s\S]{0,20}?\);/g
  ) || [];
  assert.equal(explicitLiveOwners.length, 3,
    'every live build-tail milestone carries the exact logical owner');
});

// ── 4. finalizeRecoveredTurn skips what already landed ──────────────────

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8')
  // With what a turn's recovery runs, moved out of server.js unchanged
  // (services/turn-recovery.js).
  + fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'turn-recovery.js'), 'utf8');

test('live retained turns are handed to whoever carries them on', async () => {
  const { scheduleRetainedInteractiveTurn } = require('../src/routes/sessions');
  const activeTurn = {
    turnId: '11111111-1111-4111-8111-111111111111',
    phase: 'tail_pending',
  };
  const scheduled = [];
  const pool = {
    query: async () => ({ rows: [{ active_turn: activeTurn }], rowCount: 1 }),
  };

  assert.equal(await scheduleRetainedInteractiveTurn({
    pool,
    sessionId: 42,
    scheduleInteractiveRecovery: async (sessionId) => {
      scheduled.push(sessionId);
      return true;
    },
  }), true);
  assert.deepEqual(scheduled, [42]);

  // With nobody to schedule it with (a route), the record is retained for
  // the turn-leftovers clock, which asks a recover turn for it once no work
  // item holds it (services/turn-leftovers.js); a turn's own item passes its
  // own (services/turns.js ITEM_CARRIES_ON).
  assert.equal(await scheduleRetainedInteractiveTurn({ pool, sessionId: 42 }), true);
  assert.match(SERVER_SRC, /app\.use\(sessionRoutes\(config\)\);/, 'no in-process scheduler is handed to the routes');
  assert.match(SESSIONS_SRC,
    /catch \(err\) \{[\s\S]{0,500}?scheduleRetainedInteractiveTurn\(\{/,
    'the live request catch schedules any retained durable owner');
});

test('a failed retained-turn read schedules conservatively while no record is a no-op', async () => {
  const { scheduleRetainedInteractiveTurn } = require('../src/routes/sessions');
  let calls = 0;
  const scheduleInteractiveRecovery = async () => { calls += 1; return true; };

  const absent = await scheduleRetainedInteractiveTurn({
    pool: { query: async () => ({ rows: [{ active_turn: null }] }) },
    sessionId: 43,
    scheduleInteractiveRecovery,
  });
  assert.equal(absent, false);
  assert.equal(calls, 0);

  const uncertain = await scheduleRetainedInteractiveTurn({
    pool: { query: async () => { throw new Error('database unavailable'); } },
    sessionId: 44,
    scheduleInteractiveRecovery,
  });
  assert.equal(uncertain, true);
  assert.equal(calls, 1, 'an outage cannot be interpreted as proof that ownership vanished');
});

test('restart cleanup retries derive their action from the durable phase', () => {
  assert.match(SERVER_SRC,
    /if \(durableTailComplete\) \{[\s\S]{0,350}turnCleanupArgs\(recoveryActiveTurn\)[\s\S]{0,250}requireDurableTurnCleanup/,
    'interactive recovery clears only the exact owner after a complete tail');
  assert.match(SERVER_SRC,
    /Recovered tail failed; retaining durable turn for replay/,
    'a failed recovered tail is never erased by its finally block');

  assert.match(SESSIONS_SRC,
    /failHeadlessRun\([\s\S]{0,350}requireDurableTurnCleanup\([\s\S]{0,200}cleanupArgs\(recoveryActiveTurn\)/,
    'the produced-nothing headless exit validates exact-owner cleanup');
  assert.match(SESSIONS_SRC,
    /Release the durable record and its journal only after every recovered[\s\S]{0,300}requireDurableTurnCleanup/,
    'the successful headless exit validates cleanup after its full tail');

  // A retry reads the durable phase again: the adoption and a resumed
  // headless run each derive cleanup from the record as it stands.
  assert.match(SERVER_SRC,
    /const recoveryAction = turnLifecycle\.recoveryAction\(session\.active_turn\);[\s\S]{0,1200}if \(recoveryAction === 'cleanup'\) \{[\s\S]{0,200}worker\.finishTurn/,
    'the adoption reloads cleanup_pending instead of capturing cleanupOnly');
  assert.match(SESSIONS_SRC,
    /const initialRecoveryAction = turnLifecycle\.recoveryAction\(session\.active_turn\);[\s\S]{0,600}if \(initialRecoveryAction === 'cleanup'\) \{[\s\S]{0,200}worker\.finishTurn/,
    'a resumed headless run derives cleanup without replaying the tail');
  // A record left in cleanup_pending that no work item holds is a recover
  // turn's (turn-leftovers.js: no phase filter), not a boot scan's.
  assert.doesNotMatch(SERVER_SRC, /reconcilePendingTurnCleanup/);
});

test('finalizeRecoveredTurn takes an alreadyDone map and defaults to empty', () => {
  assert.match(SERVER_SRC, /startedAtMs, alreadyDone = null,\s*activeTurn = null,[\s\S]{0,300}?localAgentLabel = null,\s*\}\) \{/,
    'optional, so a genuine mid-exec recovery is unaffected');
  assert.match(SERVER_SRC,
    /const done = alreadyDone && typeof alreadyDone === 'object' \? alreadyDone : \{\};/);
});

test('a resumed tail does not duplicate the completion card or the PR event', () => {
  assert.match(SERVER_SRC, /if \(done\.completionRowPosted\) \{/,
    'the agent summary card is posted at most once');
  // ...but the summary still reaches the Mayor wrap-up, or the recovered
  // turn would be narrated blind.
  assert.match(SERVER_SRC,
    /if \(done\.completionRowPosted\) \{[\s\S]{0,400}summaryParts\.unshift\(`What the agent did/);
  assert.match(SERVER_SRC,
    /const prAnnounced = !!done\.prNumber \|\| !!done\.prOpenedEventRecorded;/);
  assert.match(SERVER_SRC, /wasNewPR && !prAnnounced/,
    '"PR #N created" is announced at most once');
  assert.match(SERVER_SRC, /done\.votesResetFor === result\.sha\) return;/,
    'a vote reset the live tail already announced is not re-announced');
});

test('a resumed tail hands its commit to the preview machine, and joins a preview it already serves', () => {
  const start = SERVER_SRC.indexOf('async function finalizeRecoveredTurn(');
  const body = SERVER_SRC.slice(start, SERVER_SRC.indexOf('\n}\n', start));
  // The machine builds and checks the recovered commit: nothing here builds
  // a preview or runs its checks in-process.
  assert.match(body,
    /require\('\.\/(?:src\/services\/)?preview-workflow'\)\.revision\(\{\s*pool, session, head: result\.sha, source: 'turn', trigger: 'boot-reconcile',\s*\}\)\.catch\(/,
    'the exact commit is handed over, and a failed hand-off is not fatal');
  assert.doesNotMatch(body, /buildAndDeployStaging|captureForSession|stagingNeedsRebuild/);
  // The live tail handed this commit over before it died and the machine
  // has built it since: a 'building' card would be one nothing closes.
  assert.match(body,
    /handed\?\.status === 'rejected' && handed\.reason === 'same_head'[\s\S]{0,300}staging_commit_sha = \$2 AND staging_url IS NOT NULL/);
  assert.match(body,
    /if \(serves\) \{\s*await publishRecoveredStaging\(\{ outcome: 'success', stagingUrl: serves\.staging_url \}\);[\s\S]{0,200}\} else \{\s*await publishRecoveredStaging\(\{ outcome: 'building' \}\);/);
  // Either card goes out behind the same receipt as the live tail's own
  // (publishStagingOutcome in routes/sessions.js), so a wrap-up retry never
  // publishes it twice.
  assert.match(body, /\.publishStagingOutcome\(\{/,
    'staging cards are receipt-backed across recovery retries');
  assert.match(SESSIONS_SRC,
    /effectKey: turnEffects\.EFFECT_KEYS\.RECOVERED_STAGING_PUBLICATION/,
    'one receipt key for the live and the recovered card');
});

test('resumeDetachedTurnInner threads the map through and skips a posted wrap-up', () => {
  assert.match(SERVER_SRC,
    /let tailDone = \(activeTurn && typeof activeTurn\.tail === 'object' && activeTurn\.tail\) \|\| \{\};/);
  assert.match(SERVER_SRC, /alreadyDone: tailDone,/,
    'finalizeRecoveredTurn receives it');
  assert.match(SERVER_SRC, /if \(wrapUpOutcome && tailDone\.wrapUpPosted\) \{/,
    'no second assistant reply describing the same build');
  // Operators need to tell "the agent was still typing" from "the platform
  // side was cut off" — they look identical in the logs otherwise.
  assert.match(SERVER_SRC, /phase: activeTurn\.phase \|\| 'exec',/);
});
