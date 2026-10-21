// A local agent's turn is finished after a restart (#907).
//
// The platform's side of a turn handed to a user's machine is a waiter in
// the process that dispatched it, and the post-turn tail that runs when the
// waiter returns. A restart killed both while the laptop kept working: the
// commits it uploaded stayed on the branch with no PR, preview, card or
// wrap-up, the conversation said "interrupted, Retry", and Retry could build
// it all again. The turn's work item's next claim takes it over
// (services/turns.js) and services/local-agent-recovery.js finishes it
// through the post-turn path restart recovery uses for a worker's turn.
//
// The orchestration is driven here against a stateful fake of the turn row
// and recording fakes for the tail; the SQL that makes it exactly-once runs
// against PostgreSQL in tests/local-agent-recovery-postgres.test.js.
//
// Run with: node --test tests/local-agent-recovery.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const localAgent = require('../src/services/local-agent');
const recovery = require('../src/services/local-agent-recovery');
const activeWorkers = require('../src/services/active-workers');
const stopRegistry = require('../src/services/stop-registry');

const SESSION = {
  id: 42, status: 'active', user_id: 5, app_id: 3, is_headless: false,
  app_slug: 'leaderboard', app_name: 'Leaderboard', repo_url: 'https://github.com/acme/leaderboard',
  branch_name: 'dev/evan-1', behind_main: 2, username: 'evan', agent_session_id: 9, spec_md: '',
};

function turnRow(over = {}) {
  return {
    id: '11', session_id: 42, lease_id: '7', user_id: 5, mode: 'build', status: 'completed',
    head_sha: 'c'.repeat(40), summary: 'Added a score column.', spec_md: null, error_detail: null,
    progress: ['Reading the code', 'Editing app.js'], waiter_id: 'recovery-waiter',
    tail_claimed_at: null, created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    updated_at: 't1', finished_at: new Date().toISOString(), ...over,
  };
}

// The turn row the real localAgent statements read and write.
function rowPool(turn, { session = SESSION } = {}) {
  const calls = [];
  const query = async (sql, params = []) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (/SELECT cs\.\*/.test(text)) return { rows: session ? [session] : [] };
    if (/SELECT label FROM session_agent_leases/.test(text)) return { rows: [{ label: "Evan's laptop" }] };
    if (/SELECT \* FROM local_agent_turns WHERE id/.test(text)) {
      const row = turn.next ? turn.next() : turn.row;
      return { rows: row ? [{ ...row }] : [] };
    }
    if (/SET tail_claimed_at = NOW\(\)/.test(text)) {
      if (turn.row.tail_claimed_at || params[1] !== turn.row.waiter_id) return { rows: [] };
      turn.row.tail_claimed_at = new Date().toISOString();
      turn.claims = (turn.claims || 0) + 1;
      return { rows: [{ ...turn.row }] };
    }
    if (/SET waiter_seen_at = NOW\(\)\s+WHERE id = \$1 AND waiter_id = \$2 AND tail_claimed_at IS NULL/.test(text)) {
      return { rows: params[1] === turn.row.waiter_id && !turn.row.tail_claimed_at ? [{ id: turn.row.id }] : [] };
    }
    if (/SET tail_finished_at = NOW\(\)/.test(text)) { turn.row.tail_finished_at = 'now'; return { rows: [] }; }
    if (/UPDATE local_agent_turns\s+SET status = 'stopped'/.test(text)) { turn.stopRequested = true; return { rows: [] }; }
    return { rows: [], rowCount: 0 };
  };
  return { calls, query };
}

function tailFakes({ finalize = { outcome: 'done', summary: 'Commit cccccccc pushed to dev/evan-1.\n\nOpened PR #3.' } } = {}) {
  const seen = {
    finalize: [], wrapUps: [], notifications: [], handBacks: [], emits: [], published: [], busyDuringTail: null,
  };
  const realSessions = require('../src/routes/sessions');
  const deps = {
    finalizeRecoveredTurn: async (args) => {
      seen.finalize.push(args);
      seen.busyDuringTail = activeWorkers.isSessionBusy(42) && !!stopRegistry.get(42)?.localTurnId;
      return finalize;
    },
    buildRecoveryStopHandle: ({ sessionId }) => {
      const handle = stopRegistry.createHandle({ sessionId, phase: 'cc' });
      handle.send = (event, data) => seen.emits.push([event, data]);
      return handle;
    },
    sessionsRoutes: {
      ...realSessions,
      runRecoveredWrapUp: async (args) => { seen.wrapUps.push(args); return { ok: true }; },
      persistScoutPublication: async (args) => {
        seen.published.push(args);
        return { applied: true, scoutText: 'Scout drafted a plan.', metadata: {}, lineCount: 2, specVersion: 1 };
      },
    },
    notifications: {
      createSessionDoneNotification: async (_pool, args) => { seen.notifications.push(['done', args]); return [{ id: 1 }]; },
      createSessionStalledNotification: async (_pool, args) => { seen.notifications.push(['stalled', args]); return [{ id: 2 }]; },
      hydrateAndPush: async () => {},
    },
    agentSessions: { conversationsOfChange: async () => [{ agentSessionId: 9, userId: 5 }] },
    agentTurn: { handBackAfterRecovery: async (args) => { seen.handBacks.push(args); } },
    pushToUser: () => {},
    broadcastGlobal: () => {},
    staging: {},
  };
  return { deps, seen };
}

test('a build the laptop finished while the platform was down gets its whole tail, once', async () => {
  const turn = { row: turnRow() };
  const pool = rowPool(turn);
  const { deps, seen } = tailFakes();

  const out = await recovery.finishAdoptedTurn({ config: {}, pool, turn: { ...turn.row }, deps });
  assert.deepEqual(out, { outcome: 'completed', wrapUp: 'code' });
  assert.equal(turn.claims, 1, 'the tail is claimed under the recovery\'s waiter id');

  // The post-turn path a recovered worker turn takes, fed what the live
  // waiter would have fed the live tail.
  assert.equal(seen.finalize.length, 1);
  const args = seen.finalize[0];
  assert.equal(args.sessionId, 42);
  assert.equal(args.localAgentLabel, "Evan's laptop", 'the card names the machine');
  assert.equal(args.activeTurn, null);
  assert.equal(args.keepWorker, true, 'no worker to reap');
  assert.deepEqual(
    [args.result.sha, args.result.ahead, args.result.pushOk, args.result.behind, args.result.lastResultText],
    ['c'.repeat(40), 1, true, 2, 'Added a score column.'],
  );
  assert.equal(seen.busyDuringTail, true, 'the change reads as busy, and stoppable, while its tail runs');
  assert.equal(activeWorkers.isSessionBusy(42), false, 'and not afterwards');
  assert.equal(stopRegistry.get(42), undefined);

  assert.equal(seen.wrapUps.length, 1);
  assert.equal(seen.wrapUps[0].outcome, 'code');
  assert.match(seen.wrapUps[0].dispatchSummary, /Opened PR #3/);
  assert.deepEqual(seen.notifications.map(([kind]) => kind), ['done']);
  assert.deepEqual(seen.handBacks, [{ pool, changeId: 42 }],
    'the conversation that dispatched it hears the build is over');
  assert.equal(turn.row.tail_finished_at, 'now');
  assert.ok(pool.calls.some((c) => /SET last_turn_runner = \$2/.test(c.sql) && c.params[1] === 'local'));
  // The progress card is rebuilt from the turn's own lines and closed.
  const progress = pool.calls.filter((c) => /jsonb_set\(metadata, '\{progressLog\}'/.test(c.sql)).at(-1);
  assert.deepEqual(JSON.parse(progress.params[0]),
    ["[Evan's laptop accepted the turn]", 'Reading the code', 'Editing app.js', '[done]']);

  // Had the dead waiter come back, or a second pass reached it: no tail.
  const late = await localAgent.awaitTurnResult(pool, '11', { waiterId: 'dead-waiter' });
  assert.equal(late.outcome, 'adopted');
  const again = await recovery.finishAdoptedTurn({ config: {}, pool, turn: { ...turn.row }, deps });
  assert.equal(again.outcome, 'adopted');
  assert.equal(seen.finalize.length, 1, 'still one tail');
});

test('a turn still running on the laptop is waited for, its lines streamed, then finished', async () => {
  let reads = 0;
  const turn = {
    row: turnRow({ status: 'running', finished_at: null, head_sha: null, progress: ['Reading the code'] }),
  };
  turn.next = () => {
    reads += 1;
    if (reads === 2) {
      // The laptop finishes between two polls, and the bus wakes the waiter.
      setImmediate(() => {
        Object.assign(turn.row, {
          status: 'completed', head_sha: 'd'.repeat(40), progress: ['Reading the code', 'Committing'], updated_at: 't2',
        });
        localAgent.notifyTurn(42);
      });
    }
    return turn.row;
  };
  const pool = rowPool(turn);
  const { deps, seen } = tailFakes();
  await recovery.finishAdoptedTurn({ config: {}, pool, turn: { ...turn.row }, deps });

  assert.deepEqual(seen.emits.filter(([event]) => event === 'cc_progress').map(([, d]) => d.text),
    ["[Evan's laptop accepted the turn]", 'Reading the code', 'Committing', '[done]']);
  assert.equal(seen.finalize[0].result.sha, 'd'.repeat(40));
});

test('a turn the lease sweeper failed is finished with what happened, and the bell says it stopped', async () => {
  const turn = {
    row: turnRow({
      status: 'abandoned', head_sha: null, summary: null,
      error_detail: 'The local coding agent stopped responding.',
    }),
  };
  const { deps, seen } = tailFakes({ finalize: { outcome: 'done', summary: 'The coding agent hit an error.' } });
  await recovery.finishAdoptedTurn({ config: {}, pool: rowPool(turn), turn: { ...turn.row }, deps });
  assert.equal(seen.finalize[0].result.fatalError,
    "Evan's laptop disconnected before finishing this turn: The local coding agent stopped responding.");
  assert.equal(seen.wrapUps[0].outcome, 'failed');
  assert.deepEqual(seen.notifications.map(([kind]) => kind), ['stalled']);
});

test('a scout turn publishes its spec as the live waiter would, then wraps up on it', async () => {
  const turn = { row: turnRow({ mode: 'scout', head_sha: null, spec_md: '# Plan\n\nAdd a score column.' }) };
  const { deps, seen } = tailFakes();
  await recovery.finishAdoptedTurn({ config: {}, pool: rowPool(turn), turn: { ...turn.row }, deps });
  assert.equal(seen.finalize.length, 0, 'a read-only turn never reaches the commit tail');
  assert.equal(seen.published.length, 1);
  assert.equal(seen.published[0].content, '# Plan\n\nAdd a score column.');
  assert.equal(seen.published[0].localAgentLabel, "Evan's laptop");
  assert.equal(seen.wrapUps[0].outcome, 'spec');
});

test('a stopped turn is closed as a stop, with no tail and no wrap-up', async () => {
  const turn = { row: turnRow({ status: 'stopped', error_detail: 'Stopped from the Homeroom dev chat.' }) };
  const pool = rowPool(turn);
  const { deps, seen } = tailFakes();
  await recovery.finishAdoptedTurn({ config: {}, pool, turn: { ...turn.row }, deps });
  assert.equal(seen.finalize.length, 0);
  assert.equal(seen.wrapUps.length, 0);
  const stopRow = pool.calls.find((c) => /INSERT INTO chat_session_messages/.test(c.sql));
  assert.match(stopRow.params[1], /^Stopped, but it had already committed changes to the branch \(cccccccc, pushed\)/,
    'the commits it had uploaded are named, so a resend does not build them twice');
  assert.equal(JSON.parse(stopRow.params[2]).stopped, true);
  assert.equal(turn.row.tail_finished_at, 'now');
});

test('a change closed while the platform was down only stops the laptop', async () => {
  const turn = { row: turnRow({ status: 'running', finished_at: null }) };
  const { deps, seen } = tailFakes();
  const out = await recovery.finishAdoptedTurn({
    config: {}, pool: rowPool(turn, { session: { ...SESSION, status: 'archived' } }), turn: { ...turn.row }, deps,
  });
  assert.equal(out.outcome, 'closed');
  assert.equal(turn.stopRequested, true);
  assert.equal(turn.claims, 1, 'claimed, so no pass takes it again');
  assert.equal(seen.finalize.length, 0);
});

// ── Wiring ─────────────────────────────────────────────────────────────

test('no pass takes a quiet local turn over: its turn\'s work item does, on its next claim', () => {
  assert.equal(recovery.recoverOrphanedLocalTurns, undefined);
  assert.equal(localAgent.adoptOrphanedTurns, undefined);
  const leftovers = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'turn-leftovers.js'), 'utf8');
  assert.doesNotMatch(leftovers, /local-agent-recovery/);
  const turns = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'turns.js'), 'utf8');
  assert.match(turns, /require\('\.\/local-agent'\)\.takeOverOwnedTurn\(pool, ctx\.workId\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /recoverLocalAgentTurns|recoverOrphanedLocalTurns/);
});
